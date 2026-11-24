"use strict";

/* ==========================================================
   MÓDULO webMethods: diagrama BPM de los pasos de un proceso
   Depende de app.js (state, getInstanceSteps, getWebhookMessages,
   getTaskData, loadResponses, findCorrelatedResponse, etc.)

   ÍNDICE
   1. CONFIGURACIÓN DEL DIAGRAMA
   2. CLASIFICACIÓN DE PASOS Y CORRELACIÓN
   3. BÚSQUEDA (padre, hijos, pasos, webhook)
   4. DISEÑO (posición de cada objeto)
   5. DIBUJO SVG
   6. RESUMEN Y RENDER
   7. PANEL DE DETALLE DEL PASO
   8. EVENTOS Y ZOOM
   ========================================================== */


/* ==========================================================
   1. CONFIGURACIÓN DEL DIAGRAMA
   ========================================================== */

/** Prefijo del STEPLABEL -> tipo de objeto BPM. */
const BPM_TYPES = {
    EVI: { kind: "start", name: "Evento inicial" },
    EVF: { kind: "end", name: "Evento final" },
    TS: { kind: "service", name: "Tarea de servicio (llamado a un API)" },
    TU: { kind: "user", name: "Tarea humana (espera al usuario)" },
    COD: { kind: "split", name: "Compuerta divergente (se tomó un camino)" },
    COC: { kind: "join", name: "Compuerta convergente" },
    SP: { kind: "subprocess", name: "Sub Proceso" }
};

const BPM_LAYOUT = {
    laneLabelWidth: 200,
    stepGap: 250,          // Ampliado para las nuevas cajas de 180px
    laneHeight: 180,       // Más alto para acomodar el texto debajo de rombos y círculos
    topPadding: 20,
    rightPadding: 110,
};

const BPM_STATE_TEXT = {
    done: "Concluido",
    waiting: "En espera",
    error: "Con error",
    recovered: "Con error de API (Continuó)", // <--- NUEVO
    simulated: "Simulado (Saltado)"
};

const bpm = {
    requestId: 0,        // descarta búsquedas viejas
    panelRequestId: 0,   // descarta paneles viejos
    status: "idle",      // idle | loading | done | error
    error: "",
    query: "",
    sessionId: "",
    messages: [],        // mensajes webhook de la sesión
    processes: [],       // [{ role, instanceId, name, steps, nodes }]
    notes: [],
    scale: 1,            // Nivel de zoom actual
};


/* ==========================================================
   2. CLASIFICACIÓN DE PASOS Y CORRELACIÓN
   ========================================================== */
const bpmNorm = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const isSessionId = (text) => /^[0-9a-f]{24}$/i.test(text);
const shortId = (id) => (id ? id.slice(0, 8) + "…" : "—");

/** Valor de un campo "extra" del mensaje webhook (por ejemplo stepId o pntFront). */
function bpmMessageField(message, key) {
    const found = message.extra.find(([name]) => name === key);
    return found ? found[1] : "";
}

/** "TU.Capturar INE" -> { prefix: "TU", kind: "user", title: "Capturar INE", ... } */
function bpmClassify(step) {
    const label = String(step.label || step.stepId || "").trim();
    let prefix = "";
    let title = label;

    // Captura el prefijo, el separador (. o _) y el resto del nombre
    const match = label.match(/^([A-Z]{2,4})([._])(.*)/i);
    if (match) {
        const foundPrefix = match[1].toUpperCase();
        const separator = match[2];

        // Regla estricta: Si empieza con SP, DEBE llevar guion bajo para ser subproceso.
        // Si lleva punto (ej. SP.Perfilamiento), lo tratamos como una tarea normal.
        if (foundPrefix === "SP" && separator === ".") {
            prefix = "";   // Al dejarlo vacío, cae en el default { kind: "task" }
            title = label; // Conserva el nombre completo "SP.Perfilamiento"
        } else {
            prefix = foundPrefix;
            title = match[3].trim();
        }
    }

    const info = BPM_TYPES[prefix] || { kind: "task", name: "Tarea" };
    return { prefix, kind: info.kind, typeName: info.name, title: title || step.stepId };
}
/**
 * Llamadas de negocio (API business) que probablemente ejecutó una tarea de servicio.
 * Se buscan por processInstanceId y se comparan por nombre con operation/buildingBlock/api.
 * matched = coincidencia por nombre; all = todas las candidatas de la instancia.
 */
function bpmFindCalls(title, process) {
    const records = [...state.records.values()];
    let candidates = records.filter((r) => r.processInstanceId === process.instanceId);
    if (!candidates.length && bpm.sessionId) candidates = records.filter((r) => r.sessionId === bpm.sessionId);

    const key = bpmNorm(title);
    const matched = key.length < 3 ? [] : candidates.filter((call) => {
        const haystack = bpmNorm(call.operation + call.buildingBlock + call.api);
        const block = bpmNorm(call.buildingBlock);
        return haystack.includes(key) || (block.length > 3 && key.includes(block));
    });
    return { matched, all: candidates };
}

/** 
 * NUEVO: Correlación exacta por processInstanceId Y stepId 
 */
function bpmFindCallsForStep(stepId, process) {
    const records = [...state.records.values()];
    // Buscamos las llamadas exactas que tienen la misma instancia de proceso y el mismo ID de paso
    const matched = records.filter((r) =>
        r.processInstanceId === process.instanceId &&
        r.stepId === stepId
    );
    return { matched, all: records.filter((r) => r.processInstanceId === process.instanceId) };
}


/** Regla explícita: ignorar el estado de pasos que inicien con INT. (ej. INT.Correlación) */
function bpmShouldIgnoreState(step) {
    const rawLabel = String(step.label || step.stepId || "").trim();
    return /^INT\./i.test(rawLabel);
}

/** Convierte los pasos del API en nodos del diagrama con su estado (done | waiting | error). */
function bpmBuildNodes(process) {
    const totalSteps = process.steps.length;

    process.nodes = process.steps.map((step, index) => {
        const type = bpmClassify(step);
        const ignoreState = bpmShouldIgnoreState(step);
        const calls = type.kind === "service" ? bpmFindCallsForStep(step.stepId, process) : { matched: [], all: [] };

        const stepClass = stepStatusClass(step); // "bad" | "ok" | "warn" | "info"
        const stepFailed = stepClass === "bad";

        // Separamos los 400 Bad Request de otros errores (ej. 500)
        const has400Error = calls.matched.some((call) => call.status === 400);
        const apiErrors = calls.matched.filter((call) => call.status >= 400);

        const errors = [];
        if (stepFailed) errors.push(`Estado del paso: ${step.statusText || step.status}`);
        apiErrors.forEach((call) => errors.push(`${apiName(call)} respondió HTTP ${call.status}`));

        const hasSubsequentSteps = index < totalSteps - 1;
        const stepConcluded = stepClass === "ok";

        let nodeState = "done";
        if (ignoreState) {
            // Ignoramos el estado real del paso (ej. INT.Correlación en espera)
            nodeState = "done";
        }else if (step.simulation) {
            nodeState = "simulated";
        } else if (has400Error || (stepFailed && !hasSubsequentSteps)) {
            // Si hubo un HTTP 400 (Bad Request) O el paso falló y se detuvo -> ERROR / ROTO
            nodeState = "error";
        } else if (errors.length > 0) {
            // Otros errores (ej. 500) donde el proceso sí logró continuar
            nodeState = (stepConcluded || hasSubsequentSteps) ? "recovered" : "error";
        } else if (stepClass === "warn") {
            nodeState = "waiting";
        }

        return { index, step, type, calls, errors, state: nodeState, ignoreState };
    });
}

/** Mensajes webhook de la instancia; exact = los que coinciden con el stepId del paso. */
function bpmMessagesFor(node, process) {
    const all = bpm.messages.filter((m) =>
        m.processInstanceId === process.instanceId || m.customProcessInstanceId === process.instanceId);
    const exact = all.filter((m) => bpmMessageField(m, "stepId") === node.step.stepId);
    return { exact, all };
}


/* ==========================================================
   3. BÚSQUEDA
   ========================================================== */


/** Devuelve la fecha de hoy en formato YYYYMMDD (hora local) */
function bpmGetTodayApiDate() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** Extrae YYYYMMDD de un texto como "2026-11-22 18:49:22.325 UTC" o "22/11/2026..." */
function bpmExtractApiDate(dateText) {
    const str = String(dateText || "").trim();
    // Formato YYYY-MM-DD
    const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}${isoMatch[2]}${isoMatch[3]}`;
    // Formato DD/MM/YYYY
    const latamMatch = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (latamMatch) return `${latamMatch[3]}${latamMatch[2]}${latamMatch[1]}`;
    return "";
}

/** Sesión de una instancia: busca en memoria y, si no está, consulta /getInstanceList y el log /business del día */
async function bpmFindSession(instanceId, hintDateStr = "") {
    let resolvedSessionId = "";
    let resolvedApiDate = bpmExtractApiDate(hintDateStr);
    const todayApiDate = bpmGetTodayApiDate();

    // 1. Buscar en memoria actual (solo si no nos pasaron una fecha histórica distinta a la activa)
    if (!resolvedApiDate || resolvedApiDate === todayApiDate || resolvedApiDate === state.historyDate) {
        for (const record of state.records.values()) {
            if (record.processInstanceId === instanceId && record.sessionId) {
                return { sessionId: record.sessionId, dateStr: resolvedApiDate, noLogsFound: false };
            }
        }
        const message = state.webhook.messages.find((m) =>
            m.processInstanceId === instanceId || m.customProcessInstanceId === instanceId);
        if (message && message.sessionId) {
            return { sessionId: message.sessionId, dateStr: resolvedApiDate, noLogsFound: false };
        }
    }

    // 2. Consultar /getInstanceList por processInstanceId para obtener su CUSTOMID y fecha exacta
    try {
        const url = new URL(currentEnvironment().host + "/rad/PD_CFG_Administracion.api:reportes_API/getInstanceList");
        url.searchParams.append("processInstanceId", instanceId);
        const data = await fetchJson(url.toString(), { auth: true });

        let body = data?.response ?? data;
        if (typeof body === "string") {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        const instances = body?.instances || body?.results || data?.instances || data?.results || [];
        const match = instances.find((i) => (i.INSTANCEID || i.instanceId) === instanceId) || instances[0];

        if (match) {
            const customId = String(match.CUSTOMID || match.customId || "").trim();
            const extractedDate = bpmExtractApiDate(match.AUDITTIMESTRING || match.STARTTIMESTRING);
            if (extractedDate) {
                resolvedApiDate = extractedDate;
            }
            if (customId && customId !== instanceId) {
                resolvedSessionId = customId;
            }
        }
    } catch (e) {
        console.warn("No se pudo resolver la sesión desde getInstanceList:", e);
    }

    // Determinar si debemos enviar fromDate (cuando la fecha de la instancia es anterior a hoy)
    const isPastDate = resolvedApiDate && resolvedApiDate < todayApiDate;
    const effectiveFromDate = isPastDate ? resolvedApiDate : (state.historyDate || "");

    // 3. Descargar el log /business de ese día (con fromDate si es anterior a hoy) y buscar la sesión
    let noLogsFound = false;
    if (!resolvedSessionId) {
        const loadedItemsCount = await bpmEnsureBusinessRecords("", effectiveFromDate);

        // 3a. Coincidencia directa por processInstanceId
        for (const record of state.records.values()) {
            if (record.processInstanceId === instanceId && record.sessionId) {
                resolvedSessionId = record.sessionId;
                break;
            }
        }

        // 3b. Si es un proceso PADRE (End-to-End), buscamos en las sesiones del día en /webHookMessage
        if (!resolvedSessionId && !state.demoMode) {
            const candidateSessions = [...new Set([...state.records.values()].map((r) => r.sessionId).filter(Boolean))].reverse();

            if (candidateSessions.length === 0 && loadedItemsCount === 0 && effectiveFromDate) {
                noLogsFound = true;
            } else {
                const prevHistoryDate = state.historyDate;
                if (effectiveFromDate) state.historyDate = effectiveFromDate;

                try {
                    for (let i = 0; i < candidateSessions.length && !resolvedSessionId; i += 5) {
                        const batch = candidateSessions.slice(i, i + 5);
                        await Promise.all(batch.map(async (sessId) => {
                            if (resolvedSessionId) return;
                            try {
                                const rawMsgs = await getWebhookMessages(sessId);
                                const msgs = rawMsgs.map(normalizeWebhookMessage);
                                if (msgs.some((m) => m.customProcessInstanceId === instanceId || m.processInstanceId === instanceId)) {
                                    resolvedSessionId = sessId;
                                    bpm.messages = msgs;
                                }
                            } catch (err) { /* ignorar */ }
                        }));
                    }
                } finally {
                    state.historyDate = prevHistoryDate;
                }
            }
        }
    }

    return { sessionId: resolvedSessionId, dateStr: effectiveFromDate, noLogsFound };
}
/**
 * Arma la lista de procesos a dibujar:
 *   customProcessInstanceId -> proceso PADRE (end-to-end)
 *   processInstanceId       -> procesos HIJO (SP_...)
 */
function bpmBuildProcessList(query, messages) {
    const target = messages.find((m) => m.processInstanceId === query || m.customProcessInstanceId === query);
    let parentId = "";
    if (isSessionId(query)) parentId = messages.find((m) => m.customProcessInstanceId)?.customProcessInstanceId || "";
    else if (target) parentId = target.customProcessInstanceId;

    const children = new Map();   // instanceId -> nombre del proceso
    for (const m of messages) {
        if (!m.processInstanceId) continue;

        if (!parentId || m.customProcessInstanceId === parentId) {
            // CORRECCIÓN: Solo guardamos el nombre si viene con texto. 
            // Si viene vacío, conservamos el que ya habíamos guardado antes (o ponemos el genérico).
            if (m.processName) {
                children.set(m.processInstanceId, m.processName);
            } else if (!children.has(m.processInstanceId)) {
                children.set(m.processInstanceId, "Proceso hijo");
            }
        }
    }

    const list = [];
    if (parentId) list.push({ role: "parent", instanceId: parentId, name: "Proceso padre" });
    for (const [instanceId, name] of children) list.push({ role: "child", instanceId, name });
    if (!isSessionId(query) && !list.some((p) => p.instanceId === query)) {
        list.push({ role: "unknown", instanceId: query, name: "Proceso consultado" });
    }
    return list;
}

/** Garantiza que las transacciones de negocio estén cargadas en memoria para correlacionar las tareas de servicio (TS) */
/** Carga el log /business completo del día (sin lastOffset cuando es histórico) */
async function bpmEnsureBusinessRecords(sessionId, fromDateStr) {
    if (state.demoMode) return 0;

    if (sessionId && !fromDateStr) {
        const hasSessionRecords = [...state.records.values()].some((r) => r.sessionId === sessionId);
        if (hasSessionRecords) return 1;
    }

    try {
        let url = state.baseUrl + CONFIG.endpoints.business;
        if (fromDateStr) {
            url += "&fromDate=" + encodeURIComponent(fromDateStr);
        } else {
            url += "&lastOffset=0";
        }
        const data = await fetchJson(url, { auth: CONFIG.auth.business });
        const items = data.Items || data.items || data.results || [];
        addRecords(items);
        return Array.isArray(items) ? items.length : 0;
    } catch (e) {
        console.warn("No se pudieron precargar las transacciones de negocio:", e);
        return 0;
    }
}

async function searchBpm(queryText, hintDateStr = "") {
    const query = String(queryText ?? $("#inputBpmQuery").value).trim();
    if (!query) return;
    $("#inputBpmQuery").value = query;

    const requestId = ++bpm.requestId;
    Object.assign(bpm, { status: "loading", query, error: "", messages: [], processes: [], notes: [], sessionId: "", scale: 1 });
    updateZoomUI();
    renderBpm();

    try {
        // 1) Resolver sesión y fecha histórica (si es anterior a hoy)
        let effectiveFromDate = state.historyDate || "";
        let noLogsFound = false;

        if (isSessionId(query)) {
            bpm.sessionId = query;
            const parsedHint = bpmExtractApiDate(hintDateStr);
            if (parsedHint && parsedHint < bpmGetTodayApiDate()) {
                effectiveFromDate = parsedHint;
            }
        } else {
            const found = await bpmFindSession(query, hintDateStr);
            bpm.sessionId = found.sessionId;
            if (found.dateStr) effectiveFromDate = found.dateStr;
            noLogsFound = found.noLogsFound;
        }
        if (requestId !== bpm.requestId) return;

        // 2) Si tenemos sesión, consultamos /webHookMessage, /searchResponses y /business pasando fromDate si aplica
        if (bpm.sessionId) {
            const prevHistoryDate = state.historyDate;
            if (effectiveFromDate) state.historyDate = effectiveFromDate;

            try {
                const tasks = [
                    // force = true obliga a recargar searchResponses con el fromDate de esa fecha
                    loadResponses(bpm.sessionId, Boolean(effectiveFromDate)).catch(() => {}),
                    bpmEnsureBusinessRecords(bpm.sessionId, effectiveFromDate)
                ];
                if (!bpm.messages.length) {
                    tasks.push(
                        getWebhookMessages(bpm.sessionId)
                            .then((msgs) => { bpm.messages = msgs.map(normalizeWebhookMessage); })
                            .catch((err) => { bpm.notes.push("No se pudo consultar webHookMessage: " + err.message); })
                    );
                }
                await Promise.all(tasks);

                if (!bpm.messages.length && effectiveFromDate) {
                    bpm.notes.push(`No se encontraron registros en los logs (webHookMessage / business / searchResponses) para la fecha ${effectiveFromDate}.`);
                }
            } finally {
                state.historyDate = prevHistoryDate;
            }
        } else if (!isSessionId(query)) {
            if (noLogsFound || effectiveFromDate) {
                bpm.notes.push(`No se encontraron datos en los archivos log (business / webHookMessage / searchResponses) para la fecha ${effectiveFromDate}. Se muestra únicamente la estructura obtenida del motor.`);
            } else {
                bpm.notes.push("No se encontró un sessionDialogueIdentification asociado a esta instancia. Se dibuja únicamente el proceso consultado.");
            }
        }
        if (requestId !== bpm.requestId) return;

        // 3) Pasos de cada proceso (padre e hijos), en paralelo
        const processes = bpmBuildProcessList(query, bpm.messages);
        if (!processes.length) throw new Error("No hay procesos asociados a esa sesión en webHookMessage");

        await Promise.all(processes.map(async (process) => {
            try {
                process.data = await getInstanceSteps(process.instanceId);
                process.steps = extractInstanceSteps(process.data);

                if (process.role === "parent" && process.steps.length > 0) {
                    const fpStep = process.steps.find(s => s.label && s.label.trim().toUpperCase().startsWith("FP_"));
                    if (fpStep) {
                        process.displayName = fpStep.label.trim();
                        process.steps = process.steps.filter(s => s !== fpStep);
                    } else {
                        process.displayName = process.steps[process.steps.length - 1].label.trim();
                    }
                }

                if (process.role !== "parent" && process.steps.length > 0) {
                    const cleanProcName = bpmNorm(process.name);
                    process.steps = process.steps.filter(s =>
                        !( !s.stepId && bpmNorm(s.label) === cleanProcName )
                    );
                }
            } catch (error) {
                process.steps = [];
                bpm.notes.push(`findStepProcesess (${shortId(process.instanceId)}): ${error.message}`);
            }
        }));
        if (requestId !== bpm.requestId) return;

        // 4) Nodos, orden y render
        processes.forEach(bpmBuildNodes);
        const startOf = (p) => p.steps[0]?.timestamp ?? Infinity;
        processes.sort((a, b) => (a.role === "parent" ? -1 : b.role === "parent" ? 1 : startOf(a) - startOf(b)));
        bpm.processes = processes;
        bpm.status = "done";
    } catch (error) {
        if (requestId !== bpm.requestId) return;
        bpm.status = "error";
        bpm.error = error.name === "AbortError" ? "tiempo agotado" : error.message;
    }
    renderBpm();
}

/* ==========================================================
   4. DISEÑO
   ========================================================== */

/** Media anchura / altura de cada figura (para unir las flechas con el borde). */
function bpmShape(node) {
    const kind = node.type.kind;
    if (kind === "start" || kind === "end") return { w: 22, h: 22 };
    if (kind === "split" || kind === "join") return { w: 32, h: 32 };
    return { w: 90, h: 36 }; // Cajas: Ancho 180, Alto 72
}

/**
 * Un proceso por carril. Los hijos se alinean debajo del paso del padre que los invocó
 * (el último paso del padre iniciado antes que el primer paso del hijo).
 */
function bpmLayout(processes) {
    const L = BPM_LAYOUT;
    let width = 0;

    processes.forEach((process, laneIndex) => {
        process.laneIndex = laneIndex;
        process.top = L.topPadding + laneIndex * L.laneHeight;
        process.cy = process.top + L.laneHeight / 2 - 6;
        process.link = null;

        let startX = L.laneLabelWidth + 100;

        // NUEVO: Buscamos el proceso que lo invocó en CUALQUIER carril superior
        if (laneIndex > 0 && process.nodes.length) {
            // Se actualiza para limpiar tanto SP_ como SP.
            const childClean = bpmNorm(process.name.replace(/^SP[._]/i, ""));
            let callerNodeIndex = -1;
            let callerProcess = null;

            // 1. Buscar coincidencia exacta por nombre en procesos anteriores (de abajo hacia arriba)
            if (childClean) {
                for (let i = laneIndex - 1; i >= 0; i--) {
                    callerNodeIndex = processes[i].nodes.findIndex(n => {
                        // Solo los subprocesos deben invocar ramas hijas
                        if (n.type.kind !== "subprocess") return false;
                        const parentClean = bpmNorm(n.type.title);
                        return parentClean && (parentClean.includes(childClean) || childClean.includes(parentClean));
                    });
                    if (callerNodeIndex !== -1) {
                        callerProcess = processes[i];
                        break;
                    }
                }
            }

            // 2. Fallback por tiempo si no coincide el nombre
            if (!callerProcess) {
                const firstTime = process.steps[0].timestamp;
                let minDiff = Infinity;
                for (let i = laneIndex - 1; i >= 0; i--) {
                    let closestBefore = -1;
                    processes[i].nodes.forEach((node, idx) => {
                        if (node.step.timestamp <= firstTime) {
                            const diff = firstTime - node.step.timestamp;
                            if (diff < minDiff) {
                                minDiff = diff;
                                closestBefore = idx;
                                callerProcess = processes[i];
                            }
                        }
                    });
                    if (closestBefore !== -1) {
                        // El nodo que invoca es exactamente el que ocurrió antes, sin sumar 1
                        callerNodeIndex = closestBefore;
                    }
                }
            }

            // Guardamos la referencia al proceso padre real de este nivel
            if (callerProcess && callerNodeIndex !== -1) {
                process.link = { callerProcess, callerNodeIndex };
                startX = callerProcess.nodes[callerNodeIndex].x;
            }
        }

        process.nodes.forEach((node, i) => {
            node.laneIndex = laneIndex;
            node.x = startX + i * L.stepGap;
            node.y = process.cy;
        });
        width = Math.max(width, startX + process.nodes.length * L.stepGap);
    });

    return { width: width + L.rightPadding, height: L.topPadding * 2 + processes.length * L.laneHeight };
}


/* ==========================================================
   5. DIBUJO SVG
   ========================================================== */

/** Parte un texto en líneas de máximo "max" caracteres. */
function bpmWrap(text, max = 22, maxLines = 3) {
    const lines = [""];
    for (const word of String(text).split(/\s+/)) {
        const current = lines[lines.length - 1];
        const joined = (current + " " + word).trim();

        if (joined.length <= max) {
            lines[lines.length - 1] = joined;
        } else if (lines.length < maxLines) {
            lines.push(word);
        } else {
            // FIX: Si ya no hay más líneas, fuerza la palabra para no perderla y que se recorte después
            if (current === "") lines[lines.length - 1] = word;
            break;
        }
    }
    const cut = (line) => (line.length > max + 2 ? line.slice(0, max - 1) + "…" : line);
    const result = lines.map(cut).filter(l => l);
    if (String(text).length > result.join(" ").length + 2 && result.length > 0) {
        result[result.length - 1] = cut(result[result.length - 1] + "…");
    }
    return result.length ? result : [""];
}
const BPM_ICONS = {
    // Persona (tarea humana)
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
    // Engranaje (tarea de servicio)
    service: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7"/>'
        + '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    task: '<rect x="4" y="5" width="16" height="14" rx="2"/>',
    subprocess: '<rect x="3" y="3" width="18" height="18" rx="3" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke-width="2"/>',
};

function bpmNodeSvg(node) {
    const { kind, typeName, title } = node.type;
    const label = `${typeName}: ${title} · ${node.step.stepId} · ${BPM_STATE_TEXT[node.state]}`;
    const shape = bpmShape(node);
    let body = "";

    if (kind === "start" || kind === "end") {
        body = `<circle class="shape" r="22"/>${kind === "end" ? '<circle class="inner" r="10"/>' : ""}`
            + bpmLabelBelow(title, 22, node);
    } else if (kind === "split" || kind === "join") {
        body = `<polygon class="shape" points="0,-32 32,0 0,32 -32,0"/>`
            + bpmLabelBelow(title, 32, node);
    } else {
        const lines = bpmWrap(title, 22, 3);
        const clipId = `clip-${node.step.stepId}-${node.index}`;

        body = `<clipPath id="${clipId}"><rect x="-90" y="-36" width="180" height="72" rx="14"/></clipPath>`
            + `<rect class="shape" x="-90" y="-36" width="180" height="72" rx="14"/>`
            + `<rect class="accent" x="-90" y="-36" width="8" height="72" clip-path="url(#${clipId})"/>`
            + `<g class="icon" transform="translate(-78,-27) scale(0.85)">${BPM_ICONS[kind] || BPM_ICONS.task}</g>`
            + lines.map((line, i) => `<text class="node-title" x="-42" y="${-10 + i * 15}">${escapeHtml(line)}</text>`).join("")
            + `<text class="node-id" x="-77" y="30">${escapeHtml(node.step.stepId)}</text>`
            + `<text class="node-sub" x="82" y="30" text-anchor="end">${escapeHtml(node.step.statusText)}</text>`;
    }

    // Insignia roja cuando el paso falló
    if (node.state === "error") {
        body += `<g class="err-badge" transform="translate(${shape.w - 2},${-shape.h + 2})">`
            + `<circle r="9"/><path d="M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5"/></g>`;
    }

    // NUEVO: Insignia de iteración (Loop)
    // Lee nuestra agrupación previa (_iterationCount) o el valor nativo (stepIteration)
    const iterCount = node.step._iterationCount || parseInt(node.step.stepIteration) || 1;

    if (iterCount > 1) {
        // Dibuja una píldora (pill) en el borde superior centrado del objeto
        body += `<g class="iter-badge" transform="translate(0, ${-shape.h})">`
            + `<rect x="-26" y="-12" width="52" height="24" rx="12" fill="#E8ECFD" stroke="#4F6BED" stroke-width="1.5"/>`
            + `<text x="0" y="4" font-size="11" font-weight="800" fill="#4F6BED" text-anchor="middle">↺ x${iterCount}</text>`
            + `</g>`;
    }

    // Devuelve el nodo completo (sin la etiqueta nativa <title> para respetar tu Tooltip personalizado)
    return `<g class="bpm-node kind-${kind} is-${node.state}" transform="translate(${node.x},${node.y})" `
        + `data-lane="${node.laneIndex}" data-step="${node.index}" tabindex="0" role="button" `
        + `data-bpm-type="${escapeHtml(typeName)}" data-bpm-title="${escapeHtml(title)}" `
        + `data-bpm-id="${escapeHtml(node.step.stepId)}" data-bpm-status="${BPM_STATE_TEXT[node.state] || node.state}" `
        + `aria-label="${escapeHtml(label)}">`
        + `${body}</g>`;
}

/** Texto centrado debajo de eventos y compuertas. */
function bpmLabelBelow(title, offset, node) {
    const lines = bpmWrap(title, 24, 3);
    let html = lines.map((line, i) =>
        `<text class="node-title label-below" y="${offset + 18 + i * 14}" text-anchor="middle">${escapeHtml(line)}</text>`
    ).join("");

    const subY = offset + 18 + lines.length * 14;
    html += `<text class="node-id label-below" y="${subY}" text-anchor="middle">${escapeHtml(node.step.stepId)} · ${escapeHtml(node.step.statusText)}</text>`;
    return html;
}
function bpmCross(x, y) {
    return `<g class="err-badge" transform="translate(${x},${y})"><circle r="9"/><path d="M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5"/></g>`;
}

/** Flechas entre pasos consecutivos (rojas y cortadas si el paso falló). */
function bpmEdgesSvg(process) {
    let svg = "";
    process.nodes.forEach((node, i) => {
        const next = process.nodes[i + 1];
        const from = node.x + bpmShape(node).w;
        const y = node.y;

        if (next) {
            const to = next.x - bpmShape(next).w - 2;
            // Si hay un nodo siguiente, el flujo NO se cortó: la flecha es normal
            const broken = node.state === "error";
            svg += `<line class="bpm-edge${broken ? " broken" : ""}" x1="${from}" y1="${y}" x2="${to}" y2="${y}" `
                + `marker-end="url(#${broken ? "arrowRed" : "arrow"})"/>`;
            if (broken) svg += bpmCross((from + to) / 2, y);
        } else if (node.state === "error") {
            // Solo se muestra "proceso roto" si es el ÚLTIMO nodo y quedó en error
            svg += `<line class="bpm-edge broken" x1="${from}" y1="${y}" x2="${from + 46}" y2="${y}"/>`
                + bpmCross(from + 46, y)
                + `<text class="node-sub broken-text" x="${from + 46}" y="${y - 18}" text-anchor="middle">proceso roto</text>`;
        } else if (node.state === "waiting") {
            svg += `<line class="bpm-edge pending" x1="${from}" y1="${y}" x2="${from + 50}" y2="${y}"/>`
                + `<text class="node-sub" x="${from + 25}" y="${y - 10}" text-anchor="middle">esperando</text>`;
        }
    });
    return svg;
}

function bpmLaneSvg(process, width, allProcesses) {
    const L = BPM_LAYOUT;
    let roleText = { parent: "END-TO-END", child: "Building Block", unknown: "PROCESO" }[process.role];
    // Si el proceso es un "Hijo", pero su invocador no fue el "Padre" principal, es un nieto/anidado.
    if (process.role === "child" && process.link && process.link.callerProcess.role !== "parent") {
        roleText = "ANIDADO";
    }
    const activeNodes = process.nodes.filter((n) => !n.ignoreState);
    const failed = activeNodes.some((n) => n.state === "error");
    const waiting = activeNodes.some((n) => n.state === "waiting");
    const hasWarnings = activeNodes.some((n) => n.state === "recovered");

    const stateText = failed
        ? "Roto"
        : waiting
            ? "En espera"
            : hasWarnings
                ? "Con alertas" // O puedes poner "Completo" si prefieres no resaltar la alerta
                : process.nodes.length ? "Completo" : "Sin pasos";
    let bgHeight = L.laneHeight - 8;
    let isParentWrap = process.role === "parent" && allProcesses.length > 1;
    if (isParentWrap) {
        bgHeight = (allProcesses.length * L.laneHeight) - 8;
    }

    // CAPA 1: Fondo del carril y líneas de flujo horizontales
    let bgSvg = `<rect class="lane-bg ${process.role}" x="4" y="${process.top + 4}" width="${width - 8}" height="${bgHeight}" rx="16" ${isParentWrap ? 'style="fill: #F4F7FC; stroke: #8FA3ED; stroke-width: 2; stroke-dasharray: 8 6;"' : ''}/>`;
    bgSvg += bpmEdgesSvg(process);
    if (!process.nodes.length) {
        bgSvg += `<text class="node-sub" x="${L.laneLabelWidth + 40}" y="${process.cy}">Sin pasos registrados para esta instancia</text>`;
    }

    // CAPA 2: Los nodos físicos (Cajas, Rombos, Círculos)
    let nodesSvg = process.nodes.map(bpmNodeSvg).join("");

    // Usar displayName si existe (solo para el padre), si no usar el process.name normal
    const safeName = process.displayName || process.name || "Proceso sin nombre";
    const displayName = escapeHtml(safeName.length > 25 ? safeName.slice(0, 24) + "…" : safeName);

    let headerSvg = `<g style="cursor:pointer;" data-scroll-to-lane="${process.laneIndex}">`
        + `<rect class="lane-head ${failed ? "is-error" : ""}" x="14" y="${process.top + 16}" width="${L.laneLabelWidth - 24}" height="${L.laneHeight - 32}" rx="12"/>`
        + `<text class="lane-role" x="28" y="${process.top + 44}">${roleText}</text>`
        + `<text class="lane-name" x="28" y="${process.top + 66}">${displayName}</text>`
        + `<text class="node-id" x="28" y="${process.top + 84}">${escapeHtml(shortId(process.instanceId))}</text>`
        + `<text class="node-sub" x="28" y="${process.top + 104}">${process.nodes.length} pasos · ${stateText}</text>`
        + `</g>`;

    // Devolvemos las 3 capas por separado para ensamblarlas en el orden correcto
    return { bg: bgSvg, nodes: nodesSvg, header: headerSvg };
}

function bpmDiagramSvg(processes) {
    const { width, height } = bpmLayout(processes);
    const marker = (id, color) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;

    // NUEVO: Dibujamos los enlaces basándonos en el callerProcess detectado dinámicamente
    const links = processes.filter((p) => p.link && p.nodes.length).map((child) => {
        const caller = child.link.callerProcess.nodes[child.link.callerNodeIndex];
        const first = child.nodes[0];

        const startY = caller.y + bpmShape(caller).h;
        const endY = first.y - bpmShape(first).h - 4;
        const midY = startY + 24; // Baja 24px recto antes de cruzar si es necesario

        const path = `M${caller.x},${startY} V${midY} H${first.x} V${endY}`;

        return `<path class="bpm-link" d="${path}" marker-end="url(#arrowLink)"/>`
            + `<text class="node-sub link-text" x="${first.x + 6}" y="${midY + 4}">invoca</text>`;
    }).join("");

    const renderedLanes = processes.map((p) => bpmLaneSvg(p, width, processes));
    const bgs = renderedLanes.map(l => l.bg).join("");
    const nodes = renderedLanes.map(l => l.nodes).join("");

    // Los textos del carril izquierdo ahora NO llevan la clase 'lane-sticky-header' aquí,
    // se dibujan de manera estática y la barra de cristal los cubrirá visualmente, 
    // por lo que debemos atrapar el clic directamente en la barra de cristal.
    const laneHeaders = renderedLanes.map(l => l.header).join("");

    const glassWidth = BPM_LAYOUT.laneLabelWidth + 10;

    // 1. Convertimos la barra de cristal completa en el objeto que recibe los clics
    //    y agregamos los elementos invisibles sobre cada carril para detectar a qué carril le diste clic.
    const clickZones = processes.map((p, index) => {
        const yTop = p.top + 16;
        const hZone = BPM_LAYOUT.laneHeight - 32;
        return `<rect x="0" y="${yTop}" width="${glassWidth}" height="${hZone}" 
                 fill="transparent" style="cursor:pointer;" 
                 data-scroll-to-lane="${index}"
                 data-custom-tooltip="Clic para ir a la actividad más reciente">
                </rect>`;
    }).join("");

    const glassPanel = `<g class="lane-sticky-header">`
        + `<foreignObject x="0" y="0" width="${glassWidth}" height="${height}" style="pointer-events:none;">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:100%; height:100%; background: rgba(255, 255, 255, 0.55); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-right: 1px solid rgba(0,0,0,0.08); box-shadow: 4px 0 16px rgba(0,0,0,0.05);"></div>`
        + `</foreignObject>`
        + laneHeaders
        + clickZones
        + `</g>`;

    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Diagrama BPM" style="transform-origin: top left;">`
        + `<defs>${marker("arrow", "#98A6BD")}${marker("arrowRed", "#EF5B5B")}${marker("arrowLink", "#4F6BED")}</defs>`
        + bgs + links + nodes + glassPanel + `</svg>`;
}

function updateStickyHeaders() {
    const diagram = $("#bpmDiagram");
    if (!diagram) return;

    // Calculamos el desplazamiento dividiendo por el zoom actual
    const currentScroll = diagram.scrollLeft / bpm.scale;
    // Evitamos rebotes negativos (overscroll) en macOS
    const safeScroll = Math.max(0, currentScroll);

    $$(".lane-sticky-header").forEach(header => {
        header.style.transform = `translateX(${safeScroll}px)`;
    });
}


/* ==========================================================
   6. RESUMEN Y RENDER
   ========================================================== */
function bpmOverall(nodes) {
    // Excluir explícitamente pasos con prefijo INT. (ej. INT.Correlación)
    const evaluatedNodes = nodes.filter((n) => !n.ignoreState);

    if (evaluatedNodes.some((n) => n.state === "error")) return { text: "Con error", css: "kpi-bad" };
    if (evaluatedNodes.some((n) => n.state === "waiting")) return { text: "En espera", css: "kpi-warn" };
    if (evaluatedNodes.some((n) => n.type.kind === "end")) return { text: "Completado", css: "kpi-ok" };
    return { text: "En ejecución", css: "kpi-sky" };
}

function bpmSummaryHtml() {
    const nodes = bpm.processes.flatMap((p) => p.nodes);
    const times = nodes.map((n) => n.step.timestamp).filter(Boolean);
    const duration = times.length ? Math.max(...times) - Math.min(...times) : 0;
    const overall = bpmOverall(nodes);
    const failed = nodes.find((n) => n.state === "error");
    const failedProcess = failed && bpm.processes[failed.laneIndex];

    // Agregamos un contenedor flex para alinear los KPIs y el botón de recargar
    return `
        <div style="display: flex; justify-content: space-between; align-items: stretch; gap: 16px; margin-bottom: 16px;">
            <div class="grid kpi-grid" style="flex: 1; margin: 0;">
                <div class="card kpi kpi-brand"><small>Procesos</small><b>${bpm.processes.length}</b></div>
                <div class="card kpi kpi-violet"><small>Pasos</small><b>${nodes.length}</b></div>
                <div class="card kpi kpi-sky"><small>Duración</small><b>${formatDuration(duration)}</b></div>
                <div class="card kpi ${overall.css}"><small>Estado</small><b>${overall.text}</b></div>
            </div>
        </div>
        ${failed ? `<div class="bpm-alert"><b>Proceso roto</b> en <b>${escapeHtml(failed.step.stepId)}</b>
            · ${escapeHtml(failed.type.title)} (${escapeHtml(failedProcess.name)}).
            <button class="screen-link" data-bpm-open="${failed.laneIndex}:${failed.index}">Ver detalle</button></div>` : ""}
        ${bpm.notes.map((note) => `<p class="tab-hint">${escapeHtml(note)}</p>`).join("")}`;
}

function renderBpm() {
    const summary = $("#bpmSummary");
    const diagram = $("#bpmDiagram");
    summary.innerHTML = "";

    if (bpm.status === "idle") {
        diagram.innerHTML = '<div class="empty">Escribe un processInstanceId, customProcessInstanceId o sessionDialogueIdentification para dibujar el proceso.</div>';
    } else if (bpm.status === "loading") {
        diagram.innerHTML = Loader.spinner("Consultando findStepProcesess y webHookMessage...");
    } else if (bpm.status === "error") {
        diagram.innerHTML = `<p class="error-text">No se pudo dibujar el proceso: ${escapeHtml(bpm.error)}</p>`;
    } else {
        // El diseño asigna el carril (laneIndex) de cada nodo, por eso se dibuja antes del resumen
        const svg = bpmDiagramSvg(bpm.processes);
        summary.innerHTML = bpmSummaryHtml();
        diagram.innerHTML = svg;
        diagram.scrollTo(0, 0);   // cada búsqueda empieza en la esquina superior izquierda
        applyZoom(); // Aplicar zoom despues de renderizar
    }
}


/* ==========================================================
   7. PANEL DE DETALLE DEL PASO (panel derecho)
   ========================================================== */
function bpmStepCard(node, process) {
    const s = node.step;
    // Agregamos "teal" (verde azulado) para el estado simulado
    const pill = { done: "ok", waiting: "warn", recovered: "warn", error: "bad", simulated: "teal" }[node.state] || "info";
    const iterText = s._iterationCount > 1 ? `Iteración ${s._iterationCount}` : `paso ${escapeHtml(s.stepIteration || "—")} · instancia ${escapeHtml(s.instanceIteration || "—")}`;

    return `
        <div class="card result-card">
            <dl class="details">
                <dt>Tipo</dt><dd>${escapeHtml(node.type.typeName)}${node.type.prefix ? ` (${escapeHtml(node.type.prefix)}.)` : ""}</dd>
                <dt>Estado</dt><dd><span class="pill ${pill}">${escapeHtml(s.statusText || BPM_STATE_TEXT[node.state])}</span></dd>
                <dt>stepId</dt><dd class="mono">${escapeHtml(s.stepId)}</dd>
                <dt>Hora</dt><dd>${escapeHtml(s.time)}</dd>
                <dt>Proceso</dt><dd>${escapeHtml(process.name)}</dd>
                <dt>instanceID</dt><dd class="mono">${escapeHtml(process.instanceId)}</dd>
                <dt>Sistema</dt><dd>${escapeHtml(s.systemText || s.system || "—")}</dd>
                <dt>Iteraciones</dt><dd>${iterText}</dd>
                <dt>Simulación</dt><dd>${s.simulation ? "<b>Sí (Saltado)</b>" : "No"}</dd>
                ${node.ignoreState ? `<dt>Regla de flujo</dt><dd><span class="pill info">Estado ignorado (INT.Correlación)</span></dd>` : ""}
                ${s.user ? `<dt>Usuario</dt><dd>${escapeHtml(s.user)}</dd>` : ""}
                ${s.user ? `<dt>Usuario</dt><dd>${escapeHtml(s.user)}</dd>` : ""}
                ${s.role ? `<dt>Rol</dt><dd>${escapeHtml(s.role)}</dd>` : ""}
            </dl>
        </div>`;
}

/** Tarjeta de una pantalla del webHook (channelScreen / pntFront). */
function bpmScreenCard(message) {
    const pntFront = bpmMessageField(message, "pntFront");
    return `
        <div class="card result-card">
            <dl class="details">
                <dt>pntFront</dt><dd>${pntFront ? `<b>${escapeHtml(pntFront)}</b>` : "—"}</dd>
                <dt>channelScreen</dt><dd><span class="pill teal">${escapeHtml(message.channelScreen || "—")}</span></dd>
                <dt>exitCode</dt><dd>${message.exitCode !== "" ? `<span class="pill exit">${escapeHtml(message.exitCode)}</span>` : "—"}</dd>
                <dt>taskId</dt><dd class="mono">${escapeHtml(message.taskId || "—")}</dd>
                <dt>Proceso</dt><dd>${escapeHtml(message.processName || "—")}</dd>
                <dt>Hora</dt><dd>${escapeHtml(message.startTime || "—")}</dd>
            </dl>
        </div>`;
}

/** Tarjeta de una llamada de negocio con su respuesta (searchResponses, uuid = id). */
function bpmCallCard(call, response) {
    return `
        <div class="card result-card">
            <h3>${escapeHtml(apiName(call))}
                <span class="pill ${statusClass(call.status)}">${call.status}</span>
                <span class="pill info">${escapeHtml(call.method)}</span></h3>
            <dl class="details">
                <dt>API</dt><dd>${escapeHtml(call.api)}</dd>
                <dt>Building block</dt><dd>${escapeHtml(call.buildingBlock)}</dd>
                <dt>Duración</dt><dd>${formatDuration(call.durationMs)}</dd>
                <dt>id / uuid</dt><dd class="mono">${escapeHtml(call.id)}</dd>
            </dl>
            <h4 class="panel-title">Respuesta</h4>
            ${response ? formatInteractiveJsonPre(response.body) : '<div class="muted-text">Sin respuesta en searchResponses para este uuid.</div>'}
        </div>`;
}

async function bpmServiceBody(node) {
    // Usamos las llamadas que hicieron "match" exacto con el stepId
    const calls = node.calls.matched;
    let html = '<h4 class="panel-title">APIs ejecutadas en este paso y sus respuestas</h4>';

    if (!calls.length) {
        return html + '<div class="empty">No hay llamadas de negocio en memoria registradas para esta instancia y este stepId exacto.</div>';
    }

    // Cargamos en caché las respuestas (searchResponses) basadas en las sesiones encontradas
    const sessions = [...new Set(calls.map((c) => c.sessionId))];
    await Promise.all(sessions.map((id) => loadResponses(id).catch(() => [])));

    // Renderizamos las tarjetas correlacionando el API de negocio (id) con searchResponses (uuid)
    return html + calls.map((call) =>
        bpmCallCard(call, findCorrelatedResponse(call, state.responsesBySession.get(call.sessionId) || []))
    ).join("");
}

async function bpmUserTaskBody(node, process) {
    const { exact, all } = bpmMessagesFor(node, process);
    const list = (exact.length ? exact : all).slice(-4);
    let html = '<h4 class="panel-title">Pantalla del webHook (pntFront)</h4>';
    if (!list.length) return html + '<div class="empty">No hay mensajes webhook de esta instancia en memoria.</div>';
    if (!exact.length) html += '<p class="tab-hint">No se pudo asociar un mensaje exacto a este paso; se muestran los más recientes de la instancia.</p>';
    html += list.map(bpmScreenCard).join("");
    const withTask = [...list].reverse().find((m) => m.taskId);
    if (withTask) {
        html += `<h4 class="panel-title">Datos de la tarea (taskId ${escapeHtml(withTask.taskId)})</h4>`;
        try { html += buildTaskDataHtml(await getTaskData(withTask.taskId)); } catch (error) { html += `<p class="error-text">No se pudo consultar getTaskData: ${escapeHtml(error.message)}</p>`; }
    }
    return html;
}

function bpmInfoBody(node, process) {
    const next = process.nodes[node.index + 1];
    const text = { start: "Evento inicial: aquí arranca el proceso.", end: "Evento final: el proceso terminó en este punto.", split: "Compuerta divergente: el flujo evaluó una condición y tomó uno de los caminos.", join: "Compuerta convergente: los caminos se unen y el flujo continúa.", task: "Tarea del proceso." }[node.type.kind];
    return `<p class="tab-hint">${text}</p>` + (next && ["split", "join"].includes(node.type.kind) ? `<p><b>Camino tomado:</b> ${escapeHtml(next.step.stepId)} · ${escapeHtml(next.type.title)}</p>` : "");
}

async function openBpmStep(laneIndex, stepIndex) {

    const process = bpm.processes[laneIndex]; const node = process?.nodes[stepIndex];
    if (!node) return;

    $$(".bpm-node.is-selected").forEach((el) => el.classList.remove("is-selected"));
    $(`.bpm-node[data-lane="${laneIndex}"][data-step="${stepIndex}"]`)?.classList.add("is-selected");

    const requestId = ++bpm.panelRequestId;
    const drawer = $("#drawer");
    const kind = node.type.kind;

    // =========================================================================
    // NUEVA INTERFAZ EXCLUSIVA PARA SUBPROCESOS (SP)
    // =========================================================================
    if (kind === "subprocess") {
        const childClean = bpmNorm(node.type.title.replace(/^SP_/i, ""));

        // 1. Intentar buscar en los procesos de webhooks ya parseados
        let childProcess = bpm.processes.find(p => p.role !== "parent" && bpmNorm(p.name).includes(childClean));
        let childId = childProcess ? childProcess.instanceId : "";

        // 2. Fallback: Buscar directamente en la memoria (state.records) cruzando por sessionId
        if (!childId && bpm.sessionId) {
            const possibleCall = [...state.records.values()].find(r =>
                r.sessionId === bpm.sessionId &&
                r.processInstanceId &&
                r.processInstanceId !== process.instanceId &&
                (bpmNorm(r.buildingBlock).includes(childClean) || bpmNorm(r.operation).includes(childClean))
            );
            if (possibleCall) {
                childId = possibleCall.processInstanceId;
            }
        }

        drawer.innerHTML = `
            <button class="btn" id="btnCloseDrawer">Cerrar</button>
            <h3 style="margin:16px 0">
                <span class="pill" style="background:#3F51B5; color:#FFF;">Subproceso</span> 
                ${escapeHtml(node.type.title)}
            </h3>
            
            <div class="card result-card">
                <p class="tab-hint" style="margin-bottom:12px;">Este nodo delegó el control a un subproceso independiente.</p>
                <dl class="details">
                    <dt>stepId</dt><dd class="mono">${escapeHtml(node.step.stepId)}</dd>
                    <dt>Estado padre</dt><dd><span class="pill ${node.state === 'done' ? 'ok' : 'info'}">${escapeHtml(node.step.statusText || node.state)}</span></dd>
                    <dt>Hora de pase</dt><dd>${escapeHtml(node.step.time)}</dd>
                </dl>
                
                <hr style="border:0; border-top:1px solid var(--line); margin: 16px 0;">
                
                ${childId
                ? `<div style="background:#F4F7FC; padding:12px; border-radius:8px; border:1px dashed #8FA3ED;">
                           <small style="color:var(--muted); font-weight:600;">Instancia hija detectada en memoria:</small>
                           <div class="mono" style="margin:6px 0; word-break:break-all;">${escapeHtml(childId)}</div>
                           <button class="btn btn-solid mt" onclick="searchBpm('${escapeHtml(childId)}')">
                               Ver diagrama desde este subproceso
                           </button>
                       </div>`
                : `<div style="background:#FFF8E8; padding:12px; border-radius:8px; border:1px dashed #F5A524;">
                           <small style="color:#9A6200; font-weight:600;">No se encontró en memoria</small>
                           <p style="margin:6px 0 10px; font-size:13px; color:#9A6200;">
                               Este subproceso no reportó eventos ni llamadas de negocio con su nombre en esta sesión. Si conoces su <b>instanceID</b>, ingrésalo manualmente:
                           </p>
                           <div style="display:flex; gap:8px;">
                               <input type="text" id="inputManualSubprocessId" class="input" placeholder="Pega el instanceID..." style="flex:1; min-width:0; padding:6px; border:1px solid #F5A524; border-radius:4px;">
                               <button class="btn" style="background:#F5A524; color:#FFF; border:none; cursor:pointer;" onclick="const val = document.getElementById('inputManualSubprocessId').value.trim(); if(val) searchBpm(val);">
                                   Consultar
                               </button>
                           </div>
                       </div>`
            }
            </div>
           <details class="raw-json" style="margin-top: 16px;"><summary>Datos del paso original (JSON)</summary>
                ${formatInteractiveJsonPre(node.step)}
            </details>`;
        drawer.classList.add("open");
        $("#btnCloseDrawer").onclick = closeDetail;
        return;
    }

    // =========================================================================
    // INTERFAZ ESTÁNDAR (Para TS, TU, EVI, EVF, etc.)
    // =========================================================================
    drawer.innerHTML = `
        <button class="btn" id="btnCloseDrawer">Cerrar</button>
        <h3 style="margin:16px 0">${escapeHtml(node.type.title)}</h3>
        ${node.errors.length ? `<div class="bpm-alert"><b>Este paso falló</b><ul>${node.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>` : ""}
        
        ${bpmStepCard(node, process)}
        <div id="bpmStepBody">Consultando información…</div>
        
        <details class="raw-json" style="margin-top: 16px;"><summary>Datos del paso original (JSON)</summary>
            <pre>${escapeHtml(JSON.stringify(node.step, null, 2))}</pre>
        </details>`;

    drawer.classList.add("open");
    $("#btnCloseDrawer").onclick = closeDetail;

    try {
        const html = kind === "user" ? await bpmUserTaskBody(node, process) : kind === "service" ? await bpmServiceBody(node) : bpmInfoBody(node, process);
        if (requestId === bpm.panelRequestId) $("#bpmStepBody").innerHTML = html;
    } catch (error) {
        if (requestId === bpm.panelRequestId) $("#bpmStepBody").innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
    }
}

/* ==========================================================
   8. EVENTOS Y ZOOM
   ========================================================== */

function applyZoom() {
    const svg = $("#bpmDiagram svg");
    if (svg) {
        svg.style.transform = `scale(${bpm.scale})`;
        svg.style.transformOrigin = "top left";
    }
    updateZoomUI();
    updateStickyHeaders(); // Sincroniza el encabezado al cambiar el zoom
}

function updateZoomUI() {
    $("#bpmZoomLevel").textContent = Math.round(bpm.scale * 100) + "%";
}

function setZoom(newScale) {
    bpm.scale = Math.min(Math.max(0.2, newScale), 3); // Limitar entre 20% y 300%
    applyZoom();
}

function bindBpmZoom(area) {
    area.addEventListener("wheel", (event) => {
        if (!event.ctrlKey) return; // Requiere Control para hacer zoom
        event.preventDefault();

        const zoomSpeed = 0.1;
        const delta = event.deltaY < 0 ? zoomSpeed : -zoomSpeed;
        setZoom(bpm.scale + delta);
    }, { passive: false });
}

/**
 * Herramienta "mano": arrastra el diagrama con el mouse para moverte en horizontal y vertical.
 * Un clic sin arrastrar sigue abriendo el paso. (En pantallas táctiles ya se mueve con el dedo.)
 */
function bindBpmPan(area) {
    const DRAG_THRESHOLD = 5;   // píxeles que debe moverse el mouse para considerarlo arrastre
    let start = null;           // posición del mouse y del scroll al presionar
    let dragging = false;
    let suppressClick = false;

    area.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "mouse" || event.button !== 0) return;
        const box = area.getBoundingClientRect();
        const onScrollbar = event.clientX > box.right - 16 || event.clientY > box.bottom - 16;
        if (onScrollbar) return;    // deja que las barras de desplazamiento funcionen normal
        start = { id: event.pointerId, x: event.clientX, y: event.clientY, left: area.scrollLeft, top: area.scrollTop };
    });

    area.addEventListener("pointermove", (event) => {
        if (!start || event.pointerId !== start.id) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;

        if (!dragging) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            dragging = true;
            area.classList.add("is-panning");
            area.setPointerCapture(event.pointerId);
        }
        area.scrollLeft = start.left - dx;
        area.scrollTop = start.top - dy;
    });

    const stopDragging = () => {
        if (!start) return;
        if (dragging) {
            suppressClick = true;   // el clic que sigue a un arrastre no debe abrir ningún paso
            setTimeout(() => { suppressClick = false; }, 0);
            area.classList.remove("is-panning");
            if (area.hasPointerCapture(start.id)) area.releasePointerCapture(start.id);
        }
        start = null;
        dragging = false;
    };
    area.addEventListener("pointerup", stopDragging);
    area.addEventListener("pointercancel", stopDragging);

    // Fase de captura: frena el clic antes de que llegue a los pasos
    area.addEventListener("click", (event) => {
        if (suppressClick) {
            event.stopImmediatePropagation();
            event.preventDefault();
        }
    }, true);
}


function toggleFullscreenBpm() {
    const bpmCard = $("#bpmCardContainer");
    if (!document.fullscreenElement) {
        if (bpmCard.requestFullscreen) {
            bpmCard.requestFullscreen();
        } else if (bpmCard.webkitRequestFullscreen) { /* Safari */
            bpmCard.webkitRequestFullscreen();
        } else if (bpmCard.msRequestFullscreen) { /* IE11 */
            bpmCard.msRequestFullscreen();
        }
        $("#btnBpmFullscreen").textContent = "🗗 Salir";
        $("#bpmDiagram").style.maxHeight = "calc(100vh - 100px)"; // Ajustar height en FS
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) { /* Safari */
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) { /* IE11 */
            document.msExitFullscreen();
        }
        $("#btnBpmFullscreen").textContent = "⛶ Pantalla Completa";
        $("#bpmDiagram").style.maxHeight = "65vh"; // Volver original
    }
}

/** 
 * Limpia la caché de searchResponses para la sesión actual y 
 * vuelve a ejecutar la búsqueda completa del diagrama.
 */
function reloadBpmDiagram() {
    if (!bpm.query) return;

    // Al eliminar la sesión del Map, obligamos a loadResponses a ir al API nuevamente
    if (bpm.sessionId) {
        state.responsesBySession.delete(bpm.sessionId);
    }

    // Volvemos a lanzar la búsqueda del proceso actual
    searchBpm(bpm.query);
}

/**
 * Scroll suave personalizado que garantiza sincronía perfecta con el panel fijo
 * al ejecutar el movimiento y el transform en el mismo frame de renderizado.
 */
function smoothScrollDiagram(targetX) {
    const diagram = $("#bpmDiagram");
    const startX = diagram.scrollLeft;
    const distance = targetX - startX;

    if (Math.abs(distance) < 2) return; // Si ya está ahí, no hace nada

    const duration = 400; // duración en milisegundos
    const startTime = performance.now();

    function step(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Efecto Ease-in-out (suave al inicio y al final)
        const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        diagram.scrollLeft = startX + distance * ease;
        updateStickyHeaders(); // Sincroniza el panel instantáneamente

        if (progress < 1) {
            requestAnimationFrame(step);
        }
    }
    requestAnimationFrame(step);
}

function bindBpmEvents() {
    $("#btnBpmSearch").addEventListener("click", () => searchBpm());
    $("#inputBpmQuery").addEventListener("keydown", (event) => {
        if (event.key === "Enter") searchBpm();
    });

    // Clic (o Enter) sobre un objeto del diagrama
    const diagram = $("#bpmDiagram");
    bindBpmPan(diagram);   // debe registrarse antes del clic que abre los pasos
    bindBpmZoom(diagram);


    let isTicking = false;
    diagram.addEventListener("scroll", () => {
        if (!isTicking) {
            window.requestAnimationFrame(() => {
                updateStickyHeaders();
                isTicking = false;
            });
            isTicking = true;
        }
    });

    // Controles de zoom con botones
    $("#btnBpmZoomIn").addEventListener("click", () => setZoom(bpm.scale + 0.2));
    $("#btnBpmZoomOut").addEventListener("click", () => setZoom(bpm.scale - 0.2));
    $("#btnBpmResetZoom").addEventListener("click", () => setZoom(1));
    $("#btnBpmFullscreen").addEventListener("click", toggleFullscreenBpm);
    $("#btnBpmReload").addEventListener("click", reloadBpmDiagram);

    document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement) {
            $("#btnBpmFullscreen").textContent = "⛶ Pantalla Completa";
            $("#bpmDiagram").style.maxHeight = "65vh";
        }
    });

    const openFrom = (target) => {
        const node = target.closest(".bpm-node");
        if (node) openBpmStep(Number(node.dataset.lane), Number(node.dataset.step));
        return Boolean(node);
    };

    diagram.addEventListener("click", (event) => {
        // Validar si el clic fue en la banda izquierda del carril
        const laneHeader = event.target.closest("[data-scroll-to-lane]");
        if (laneHeader) {
            const laneIndex = Number(laneHeader.dataset.scrollToLane);
            const process = bpm.processes[laneIndex];

            if (process && process.nodes.length > 0) {
                // Obtenemos el último nodo dibujado
                const lastNode = process.nodes[process.nodes.length - 1];

                // Calcula el X considerando el zoom
                const scrollTargetX = (lastNode.x * bpm.scale) - BPM_LAYOUT.laneLabelWidth - 50;

                // 2. Usamos la función personalizada en lugar del scroll nativo asíncrono
                smoothScrollDiagram(Math.max(0, scrollTargetX));
            }
            return;
        }

        // Comportamiento normal: abrir detalle si se tocó un nodo
        openFrom(event.target);
    });

    // --- LÓGICA DEL TOOLTIP PERSONALIZADO ---
    const tooltip = document.createElement("div");
    tooltip.className = "bpm-custom-tooltip";
    document.body.appendChild(tooltip);

    diagram.addEventListener("mouseover", (event) => {
        const node = event.target.closest(".bpm-node");
        const simpleTooltip = event.target.closest("[data-custom-tooltip]");

        if (node) {
            // Tu diseño complejo para los pasos del diagrama
            const { bpmType, bpmTitle, bpmId, bpmStatus } = node.dataset;
            tooltip.innerHTML = `<b>${bpmType}</b><br>${bpmTitle}<br><span>${bpmId} · ${bpmStatus}</span>`;
            tooltip.classList.add("show");
        } else if (simpleTooltip) {
            // Diseño simple para el mensaje del panel izquierdo
            tooltip.innerHTML = simpleTooltip.dataset.customTooltip;
            tooltip.classList.add("show");
        }
    });

    diagram.addEventListener("mousemove", (event) => {
        if (tooltip.classList.contains("show")) {
            let x = event.clientX + 15;
            let y = event.clientY + 15;

            // Prevenir que el tooltip se salga de la pantalla
            const rect = tooltip.getBoundingClientRect();
            if (x + rect.width > window.innerWidth) x = event.clientX - rect.width - 15;
            if (y + rect.height > window.innerHeight) y = event.clientY - rect.height - 15;

            tooltip.style.left = x + "px";
            tooltip.style.top = y + "px";
        }
    });

    diagram.addEventListener("mouseout", (event) => {
        const node = event.target.closest(".bpm-node");
        const simpleTooltip = event.target.closest("[data-custom-tooltip]");
        // Si sale de cualquiera de los dos, se oculta
        if (node || simpleTooltip) tooltip.classList.remove("show");
    });
    // ----------------------------------------

    diagram.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && openFrom(event.target)) event.preventDefault();
    });

    // Enlace "Ver detalle" del aviso de proceso roto Y botón "Recargar diagrama"
    $("#bpmSummary").addEventListener("click", (event) => {
        // Interceptar botón de recarga
        if (event.target.closest("#btnReloadBpm")) {
            reloadBpmDiagram();
            return;
        }

        // Lógica existente para ver detalle del paso roto
        const link = event.target.closest("[data-bpm-open]");
        if (!link) return;
        const [lane, step] = link.dataset.bpmOpen.split(":").map(Number);
        openBpmStep(lane, step);
    });

    // Botón "Ver diagrama BPM" del panel de pasos (pestaña Webhook)
    $("#drawer").addEventListener("click", (event) => {
        const button = event.target.closest("[data-bpm-query]");
        if (!button) return;
        closeDetail();
        showTab("webmethods");
        searchBpm(button.dataset.bpmQuery);
    });
}

bindBpmEvents();