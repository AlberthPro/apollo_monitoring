

"use strict";

/* ==========================================================
   MÓDULO: INSTANCIAS DE PROCESO (webMethods)
   ========================================================== */

const INSTANCES_CONFIG = {
    endpoint: "/rad/PD_CFG_Administracion.api:reportes_API/getInstanceList",
    pageSize: 15,
};


const instancesState = {
    allItems: [],
    filteredItems: [],
    currentPage: 1,
    charts: {},
    loadedOnce: false,
};

/* ==========================================================
   1. UTILIDADES DE FECHA Y FORMATO
   ========================================================== */

function setDefaultTodayDateRange(force = false) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const startInput = document.getElementById("instStartDate");
    const endInput = document.getElementById("instEndDate");

    if (startInput && (force || !startInput.value)) {
        startInput.value = `${todayStr}T00:00`;
    }
    if (endInput && (force || !endInput.value)) {
        endInput.value = `${todayStr}T23:59`;
    }
}

function formatFilterDateForApi(isoLocal, isEndOfDay = false) {
    if (!isoLocal) return "";
    const seconds = isEndOfDay && isoLocal.endsWith("23:59") ? ":59" : ":00";
    return isoLocal.replace("T", " ") + seconds;
}

function formatFullTimestamp(ms, fallbackStr = "") {
    if (!ms || Number.isNaN(ms)) return fallbackStr || "—";
    const d = new Date(ms);
    const pad = (n, len = 2) => String(n).padStart(len, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} `
         + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatMwsDuration(startMs, endMs) {
    if (!startMs || !endMs || endMs < startMs) return "0días 00:00:00.000";
    let diff = endMs - startMs;

    const days = Math.floor(diff / 86400000);
    diff %= 86400000;
    const hours = Math.floor(diff / 3600000);
    diff %= 3600000;
    const minutes = Math.floor(diff / 60000);
    diff %= 60000;
    const seconds = Math.floor(diff / 1000);
    const ms = Math.floor(diff % 1000);

    const pad = (n, len = 2) => String(n).padStart(len, "0");
    return `${days}días ${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}`;
}

function normalizeProcessInstance(raw) {
    const f = {};
    for (const k in raw) f[k.toUpperCase()] = raw[k];

    const statusText = String(f.STATUSDECODE || f.STATUS || "Desconocido").trim();
    const auditMs = Number(f.AUDITTIMESTAMP) || 0;
    const startMs = Number(f.STARTTIMESTAMP) || auditMs;

    const isFinished = /conclu|complet|error|cancel|detenid/i.test(statusText) || [2, 3, 5, 7].includes(Number(f.STATUS));
    const effectiveEndMs = isFinished ? Math.max(auditMs, startMs) : Math.max(Date.now(), auditMs);
    const durationMs = Math.max(0, effectiveEndMs - startMs);

    let version = String(f.VERSION || f.PROCESSVERSION || "").trim();
    const rawKey = String(f.PROCESSKEYDECODE || f.PROCESSKEY || "").trim();
    if (!version) {
        const vMatch = rawKey.match(/[_v](\d+)$/i);
        version = vMatch ? vMatch[1] : "1";
    }

    const processName = String(f.PROCESSLABEL || rawKey.split("/").pop() || "Proceso sin nombre").trim();
    const cleanAuditStr = f.AUDITTIMESTRING ? String(f.AUDITTIMESTRING).replace(/\s*UTC$/i, "").trim() : formatFullTimestamp(auditMs);
    const cleanStartStr = f.STARTTIMESTRING ? String(f.STARTTIMESTRING).replace(/\s*UTC$/i, "").trim() : formatFullTimestamp(startMs);

    return {
        instanceId: String(f.INSTANCEID || "").trim(),
        customId: String(f.CUSTOMID || "").trim(),
        statusCode: String(f.STATUS || "").trim(),
        statusText,
        processName,
        processKey: rawKey,
        version,
        auditMs,
        auditString: cleanAuditStr,
        startMs,
        startString: cleanStartStr,
        durationMs,
        durationFormatted: formatMwsDuration(startMs, effectiveEndMs),
        isFinished,
        iteration: String(f.INSTANCEITERATION || "1").trim(),
    };
}

function getInstanceStatusMeta(statusText) {
    const s = statusText.toLowerCase();
    if (/error|fall/.test(s)) return { pill: "bad", label: "Error en ejecución", color: COLORS.bad };
    if (/cancel/.test(s)) return { pill: "bad", label: "Cancelada", color: "#991B1B" };
    if (/detenid/.test(s)) return { pill: "warn", label: "Detenida", color: "#B45309" };
    if (/suspend/.test(s)) return { pill: "warn", label: "Suspendida", color: COLORS.warn };
    if (/resumid/.test(s)) return { pill: "info", label: "Resumida", color: COLORS.sky };
    if (/inici|ejecuc|activ|curso/.test(s)) return { pill: "info", label: "Iniciada", color: COLORS.brand };
    if (/conclu|complet|finaliz/.test(s)) return { pill: "ok", label: "Estado normal", color: COLORS.ok };
    return { pill: "teal", label: statusText, color: COLORS.teal };
}

/* ==========================================================
   2. CONSUMO DEL API (/getInstanceList)
   ========================================================== */

async function fetchInstanceList() {
    setDefaultTodayDateRange(false);

    const startVal = document.getElementById("instStartDate")?.value || "";
    const endVal = document.getElementById("instEndDate")?.value || "";
    const stateVal = document.getElementById("instStateFilter")?.value.trim() || "";
    const procIdVal = document.getElementById("instProcessIdFilter")?.value.trim() || "";

    const startDate = formatFilterDateForApi(startVal, false);
    const endDate = formatFilterDateForApi(endVal, true);

    if (typeof state !== "undefined" && state.demoMode) {
        return buildDemoInstances();
    }

    const baseHost = typeof currentEnvironment === "function" ? currentEnvironment().host : "";
    const url = new URL(baseHost + INSTANCES_CONFIG.endpoint);

    if (startDate) url.searchParams.append("startDate", startDate);
    if (endDate) url.searchParams.append("endDate", endDate);
    if (stateVal) url.searchParams.append("state", stateVal);
    if (procIdVal) url.searchParams.append("processInstanceId", procIdVal);

    console.info("[GET Instances]", url.toString());

    const data = await fetchJson(url.toString(), { auth: true });

    let body = data?.response ?? data;
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
    }

    const instances = body?.instances || body?.results || data?.instances || data?.results || [];
    return Array.isArray(instances) ? instances.map(normalizeProcessInstance) : [];
}

function buildDemoInstances() {
    const statuses = [
        { code: "2", text: "Concluida" },
        { code: "1", text: "Iniciadas" },
        { code: "3", text: "Error" },
        { code: "4", text: "Suspendido" },
        { code: "5", text: "Cancelado" },
        { code: "6", text: "Resumido" },
        { code: "7", text: "Detenido" },
    ];
    const names = ["FP_ApoloN4", "FP_OnboardingDigital", "SP_ValidacionBuro", "FP_DispersionCredito"];
    const now = Date.now();

    return Array.from({ length: 30 }, (_, i) => {
        const st = statuses[i % statuses.length];
        const startMs = now - Math.floor(Math.random() * 8) * 3600000;
        const auditMs = startMs + 25000;
        return normalizeProcessInstance({
            AUDITTIMESTAMP: auditMs,
            AUDITTIMESTRING: formatFullTimestamp(auditMs),
            STARTTIMESTAMP: startMs,
            INSTANCEID: randomGuid(),
            CUSTOMID: "SES-" + randomHex(12),
            STATUS: st.code,
            STATUSDECODE: st.text,
            PROCESSKEY: "BC_BPM_Apolo/" + names[i % names.length],
            PROCESSKEYDECODE: names[i % names.length],
            PROCESSLABEL: names[i % names.length],
            INSTANCEITERATION: 1,
        });
    });
}

async function loadInstancesData() {
    const tbody = document.getElementById("instancesTableBody");
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="8">${Loader.spinner("Consultando instancias en webMethods...")}</td></tr>`;

    try {
        const list = await fetchInstanceList();
        instancesState.allItems = list.sort((a, b) => b.auditMs - a.auditMs);
        instancesState.filteredItems = [...instancesState.allItems];
        instancesState.loadedOnce = true;
        instancesState.currentPage = 1;
        renderInstancesDashboard();
    } catch (error) {
        console.error("Error en loadInstancesData:", error);
        tbody.innerHTML = `<tr><td colspan="8" class="empty error-text">Error al consultar /getInstanceList: ${escapeHtml(error.message)}</td></tr>`;
    }
}

/* ==========================================================
   3. GRÁFICAS Y ESTADÍSTICAS DE NEGOCIO
   ========================================================== */

function initInstancesCharts() {
    if (instancesState.charts.timeline) return;

    const canvasTimeline = document.getElementById("chartInstTimeline");
    const canvasStatus = document.getElementById("chartInstStatus");
    const canvasTop = document.getElementById("chartInstTopProcesses");
    const canvasDur = document.getElementById("chartInstDurationByProcess");

    if (!canvasTimeline || !canvasStatus || !canvasTop || !canvasDur) return;

    const baseOptions = { responsive: true, maintainAspectRatio: false, animation: false };

    instancesState.charts.timeline = new Chart(canvasTimeline, {
        type: "bar",
        data: {
            labels: [],
            datasets: [{
                label: "Instancias",
                data: [],
                backgroundColor: COLORS.brand,
                borderRadius: 6,
                maxBarThickness: 32,
            }]
        },
        options: {
            ...baseOptions,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#EEF2F8" } },
                x: { grid: { display: false } }
            }
        }
    });

    instancesState.charts.status = new Chart(canvasStatus, {
        type: "pie",
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: [],
                borderWidth: 2,
                borderColor: "#FFFFFF"
            }]
        },
        options: {
            ...baseOptions,
            plugins: {
                legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } }
            }
        }
    });

    instancesState.charts.topProcesses = new Chart(canvasTop, {
        type: "bar",
        data: {
            labels: [],
            datasets: [{
                label: "Ejecuciones",
                data: [],
                backgroundColor: COLORS.sky,
                borderRadius: 6,
                maxBarThickness: 24,
            }]
        },
        options: {
            ...baseOptions,
            indexAxis: "y",
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#EEF2F8" } },
                y: { grid: { display: false } }
            }
        }
    });

    instancesState.charts.durationByProcess = new Chart(canvasDur, {
        type: "bar",
        data: {
            labels: [],
            datasets: [{
                label: "Duración promedio (s)",
                data: [],
                backgroundColor: COLORS.violet,
                borderRadius: 6,
                maxBarThickness: 32,
            }]
        },
        options: {
            ...baseOptions,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: "#EEF2F8" } },
                x: { grid: { display: false } }
            }
        }
    });
}

function updateInstancesCharts(items) {
    initInstancesCharts();
    if (!instancesState.charts.timeline) return;

    const hourBuckets = new Map();
    for (let h = 0; h < 24; h++) {
        hourBuckets.set(`${String(h).padStart(2, "0")}:00`, 0);
    }
    for (const item of items) {
        if (!item.startMs) continue;
        const matchHour = item.startString.match(/\s(\d{2}):\d{2}:\d{2}/);
        const hourKey = matchHour
            ? `${matchHour[1]}:00`
            : `${String(new Date(item.startMs).getHours()).padStart(2, "0")}:00`;

        if (hourBuckets.has(hourKey)) {
            hourBuckets.set(hourKey, hourBuckets.get(hourKey) + 1);
        }
    }
    const timelineChart = instancesState.charts.timeline;
    timelineChart.data.labels = [...hourBuckets.keys()];
    timelineChart.data.datasets[0].data = [...hourBuckets.values()];
    timelineChart.update("none");

    const statusCounts = new Map();
    for (const item of items) {
        const key = item.statusText;
        statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
    }
    const statusLabels = [...statusCounts.keys()];
    const statusValues = statusLabels.map((lbl) => statusCounts.get(lbl));
    const statusColors = statusLabels.map((lbl) => getInstanceStatusMeta(lbl).color);

    const statusChart = instancesState.charts.status;
    statusChart.data.labels = statusLabels;
    statusChart.data.datasets[0].data = statusValues;
    statusChart.data.datasets[0].backgroundColor = statusColors;
    statusChart.update("none");

    const byProcess = groupBy(items, (i) => i.processName);
    const sortedByVolume = [...byProcess.entries()]
        .map(([name, list]) => ({ name, count: list.length }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);

    const topChart = instancesState.charts.topProcesses;
    topChart.data.labels = sortedByVolume.map((p) => p.name);
    topChart.data.datasets[0].data = sortedByVolume.map((p) => p.count);
    topChart.update("none");

    const sortedByDuration = [...byProcess.entries()]
        .map(([name, list]) => {
            const finished = list.filter((i) => i.isFinished);
            const target = finished.length ? finished : list;
            const avgSec = average(target.map((i) => i.durationMs)) / 1000;
            return { name, avgSec: Number(avgSec.toFixed(2)) };
        })
        .sort((a, b) => b.avgSec - a.avgSec)
        .slice(0, 6);

    const durChart = instancesState.charts.durationByProcess;
    durChart.data.labels = sortedByDuration.map((p) => p.name);
    durChart.data.datasets[0].data = sortedByDuration.map((p) => p.avgSec);
    durChart.update("none");
}

/* ==========================================================
   4. RENDER DE KPIs, TABLA Y PAGINADO
   ========================================================== */

function renderInstancesDashboard() {
    const items = instancesState.filteredItems;

    const total = items.length;
    const concluded = items.filter((i) => /conclu|complet/i.test(i.statusText));
    const errors = items.filter((i) => /error|cancel|detenid/i.test(i.statusText));
    const active = items.filter((i) => /inici|suspend|resumid|ejecuc/i.test(i.statusText));

    const successRate = total ? ((concluded.length / total) * 100).toFixed(1) + "%" : "0%";
    const avgDurationMs = concluded.length ? average(concluded.map((i) => i.durationMs)) : 0;

    document.getElementById("kpiInstTotal").textContent = total.toLocaleString(CONFIG.locale);
    document.getElementById("kpiInstSuccessRate").textContent = successRate;
    document.getElementById("kpiInstAvgDuration").textContent = formatDuration(avgDurationMs);
    document.getElementById("kpiInstActive").textContent = active.length.toLocaleString(CONFIG.locale);
    document.getElementById("kpiInstErrors").textContent = errors.length.toLocaleString(CONFIG.locale);
    document.getElementById("instTableCount").textContent = `${total} registros`;

    updateInstancesCharts(items);
    renderInstancesTable();
}

function renderInstancesTable() {
    const items = instancesState.filteredItems;
    const totalPages = Math.max(1, Math.ceil(items.length / INSTANCES_CONFIG.pageSize));
    if (instancesState.currentPage > totalPages) instancesState.currentPage = totalPages;

    const startIdx = (instancesState.currentPage - 1) * INSTANCES_CONFIG.pageSize;
    const pageRows = items.slice(startIdx, startIdx + INSTANCES_CONFIG.pageSize);

    const tbody = document.getElementById("instancesTableBody");
    if (!pageRows.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty">No se encontraron instancias con los filtros actuales.</td></tr>';
        document.getElementById("instPagination").innerHTML = "";
        return;
    }

    tbody.innerHTML = pageRows.map((item) => {
        const meta = getInstanceStatusMeta(item.statusText);
        return `
            <tr>
                <td>
                    <div class="inst-state-cell">
                        <span class="pill ${meta.pill}">${escapeHtml(meta.label)}</span>
                    </div>
                </td>
                <td class="mono">${escapeHtml(item.auditString)}</td>
                <td class="mono">${escapeHtml(item.startString)}</td>
                <td><b>${escapeHtml(item.processName)}</b></td>
                <td>${escapeHtml(item.version)}</td>
                <td class="mono" title="${escapeHtml(item.instanceId)}">${escapeHtml(item.instanceId)}</td>
                <td>
                    <span class="pill ${meta.pill}">${escapeHtml(item.statusText)}</span>
                    <span class="mono" style="margin-left: 6px;">${escapeHtml(item.durationFormatted)}</span>
                </td>
                <td>
                    <button class="view-btn"
                            data-view-instance="${escapeHtml(item.instanceId)}"
                            data-instance-date="${escapeHtml(item.auditString)}"
                            title="Ver diagrama BPM de esta instancia">
                        Detalle de instancia (Ver)
                    </button>
                </td>
            </tr>`;
    }).join("");

    renderInstancesPagination(totalPages);
}

function renderInstancesPagination(totalPages) {
    const container = document.getElementById("instPagination");
    if (totalPages <= 1) {
        container.innerHTML = "";
        return;
    }

    const current = instancesState.currentPage;
    let pagesHtml = "";

    let startPage = Math.max(1, current - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) {
        startPage = Math.max(1, endPage - 4);
    }

    for (let p = startPage; p <= endPage; p++) {
        pagesHtml += `<button class="page-btn ${p === current ? "active" : ""}" data-page="${p}">${p}</button>`;
    }

    container.innerHTML = `
        <button class="page-btn" data-page="${current - 1}" ${current === 1 ? "disabled" : ""}>« Anterior</button>
        <span class="page-sep">|</span>
        ${pagesHtml}
        <span class="page-sep">|</span>
        <button class="page-btn" data-page="${current + 1}" ${current === totalPages ? "disabled" : ""}>Siguiente »</button>
    `;
}

/* ==========================================================
   5. CONEXIÓN CON BPM.JS Y EVENTOS (DELEGACIÓN GLOBAL)
   ========================================================== */

function inspectInstanceInBpm(instanceId, instanceDate = "") {
    if (!instanceId) return;
    if (typeof showTab === "function") showTab("webmethods");
    const input = document.getElementById("inputBpmQuery");
    if (input) input.value = instanceId;
    if (typeof searchBpm === "function") {
        searchBpm(instanceId, instanceDate);
    }
}

function initInstancesModule() {
    // 1. Poner fechas de hoy 00:00 a 23:59 inmediatamente
    setDefaultTodayDateRange(true);

    // 2. Consultar datos iniciales al cargar la página
    loadInstancesData();

    // 3. Delegación global de clics (garantiza que funcione sin importar cuándo se renderice)
    document.addEventListener("click", (event) => {
        // Botón Consultar
        if (event.target.closest("#btnInstSearch")) {
            event.preventDefault();
            loadInstancesData();
            return;
        }

        // Botón Limpiar filtros
        if (event.target.closest("#btnInstClear")) {
            event.preventDefault();
            const stateEl = document.getElementById("instStateFilter");
            const procEl = document.getElementById("instProcessIdFilter");
            if (stateEl) stateEl.value = "";
            if (procEl) procEl.value = "";
            setDefaultTodayDateRange(true);
            loadInstancesData();
            return;
        }

        // Clic en la pestaña "Instancias BPM"
        const tabBtn = event.target.closest('.tab-button[data-tab="instances"]');
        if (tabBtn) {
            setTimeout(() => {
                Object.values(instancesState.charts).forEach((c) => c && c.resize());
            }, 50);
            if (!instancesState.loadedOnce) loadInstancesData();
            return;
        }

        // Botón "Detalle de instancia (Ver)"
        const viewBtn = event.target.closest("[data-view-instance]");
        if (viewBtn) {
            inspectInstanceInBpm(viewBtn.dataset.viewInstance, viewBtn.dataset.instanceDate);
            return;
        }

        // Botones de paginado
        const pageBtn = event.target.closest("#instPagination [data-page]");
        if (pageBtn && !pageBtn.disabled) {
            instancesState.currentPage = Number(pageBtn.dataset.page);
            renderInstancesTable();
        }
    });

    // 4. Enter en el campo processInstanceId
    document.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target.id === "instProcessIdFilter") {
            event.preventDefault();
            loadInstancesData();
        }
    });

    // 5. Cambio en el combo de estado
    document.addEventListener("change", (event) => {
        if (event.target.id === "instStateFilter") {
            loadInstancesData();
        }
    });
}

// Ejecutar cuando el DOM esté listo (o inmediatamente si ya cargó)
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initInstancesModule);
} else {
    initInstancesModule();
}