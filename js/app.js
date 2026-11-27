"use strict";

/* ==========================================================
   ÍNDICE
   1. CONFIGURACIÓN        -> valores que normalmente vas a ajustar
   2. ESTADO               -> datos en memoria
   3. UTILIDADES           -> formato, estadísticas, DOM
   4. SERIALIZACIÓN        -> convierte el JSON del API a objetos limpios
   5. API                  -> consumo de los servicios (y datos demo)
   6. CONSULTA EN TIEMPO REAL
   7. GRÁFICAS
   8. RENDER DE PESTAÑAS
   9. DETALLE Y BÚSQUEDA
   9B. WEBHOOK             -> pestaña Webhook (API webHookMessage)
   10. EVENTOS
   11. INICIO
   ========================================================== */


/* ==========================================================
   1. CONFIGURACIÓN
   ========================================================== */
const CONFIG = {
    // Base de los servicios
    // Ambientes: host + credenciales para el header Authorization (Basic)
    environments: {
        DEV: { host: "http://10.209.23.55:5555", user: "Administrator", password: "aLBqNCrP" },
        QA: { host: "http://10.209.29.180:5555", user: "Administrator", password: "moUSOLgeIR" },
        PROD: { host: "http://10.208.20.246:5565", user: "Administrator", password: "AbIeLifi" },
    },
    defaultEnvironment: "QA",
    basePath: "/rad/endpoints:api",   // se agrega al host del ambiente

    // Qué APIs envían el header Authorization (true) y cuáles no (false).
    // Las llaves coinciden con los nombres de endpoints.
    auth: { business: false, responses: false, webhook: false, taskData: true, findSteps: true },
    endpoints: {
        business: "/business?operation=convert",
        responses: "/searchResponses?sessionDialogueIdentification=",
        webhook: "/webHookMessage?sessionDialogueIdentification=",   // GET, sin autenticación
        taskData: "/getTaskData",   // GET ?taskId=
        findSteps: "/findStepProcesess",   // GET ?instanceID=
    },

    logRequests: false,       // true = imprime en la consola la URL de cada petición
    refreshMs: 3000,          // cada cuánto se consulta el API
    requestTimeoutMs: 15000,   // tiempo máximo de espera por consulta
    maxRecords: 3000,         // registros guardados en memoria (contador máximo)
    maxTableRows: 200,     
    maxRecords: 10000,   // filas visibles iniciales en la tabla de transacciones
    liveChartPoints: 90,   
    liveWindowMs: 60 * 60 * 1000,   // puntos de la gráfica en vivo
    topBlocks: 8,             // barras en "promedio por building block"
    topSlowest: 7,            // barras en "operaciones más lentas"
    responsesPerCycle: 2,     // sesiones cuyas respuestas se piden por ciclo
    tooltipTopApis: 5,        // APIs listadas en el tooltip de las gráficas
    responseConcurrency: 3,   // Máximo de peticiones simultáneas a searchResponses (no satura el server)

    // Modo histórico (cuando se elige una fecha de log en Configuración)
    historyResponsesPerCycle: 10,  // sesiones cuyas respuestas se piden por ciclo
    maxHistoricalRecords: 20000,   // registros máximos en memoria para un día anterior
    sendFromDateToResponses: true, // true = fromDate también se envía a searchResponses
    sendFromDateToWebhook: true,   // true = fromDate también se envía a webHookMessage
    sendFromDateToTaskData: false, // true = fromDate también se envía a getTaskData
    sendFromDateToSteps: false,    // true = fromDate también se envía a findStepProcesess

    slowMs: 1000,             // arriba de esto el tiempo se pinta amarillo
    verySlowMs: 3000,         // arriba de esto se pinta rojo

    locale: "es-MX",

    // Orden inicial de la tabla de transacciones.
    // field = cualquier campo del registro (ver normalizeBusinessItem)
    // direction = "asc" o "desc"
    defaultSort: { field: "receivedAt", direction: "desc" },
};

const COLORS = {
    brand: "#4F6BED", ok: "#22B07D", warn: "#F5A524", bad: "#EF5B5B",
    sky: "#2FB4F0", violet: "#8B5CF6", pink: "#EC6FA8", teal: "#14B8A6",
};
const PALETTE = [COLORS.brand, COLORS.sky, COLORS.violet, COLORS.ok,
COLORS.warn, COLORS.pink, COLORS.teal, COLORS.bad];


/* ==========================================================
   2. ESTADO
   ========================================================== */
let arrivalCounter = 0;
const state = {
    records: new Map(),       // llamadas de negocio: id -> registro
    newRecordIds: new Set(),
    responsesBySession: new Map(), // sessionId -> lista de respuestas
    sessionQueue: new Set(),  // sesiones pendientes de pedir respuestas
    env: CONFIG.defaultEnvironment,   // DEV | QA | PROD
    baseUrl: "",              // host del ambiente + reportsPath (lo calcula setEnvironment)
    demoMode: false,
    paused: false,
    activeTab: "dashboard",
    statusFilter: "all",      // all | 2 | 4 | 5
    sort: { ...CONFIG.defaultSort },       // orden de la pestaña Transacciones
    errorSort: { ...CONFIG.defaultSort },  // orden del panel de errores
    timesSort: { field: "p95", direction: "desc" }, //
    errorsPanelOpen: false,
    historyDate: "",          // "yyyyMMdd" si se eligió un día anterior; "" = tiempo real
    generation: 0,            // sube con cada "Aplicar": descarta consultas viejas en vuelo
    webhook: newWebhookState(),  // datos de la pestaña Webhook
    needsRender: true,
    pollTimer: null,
    charts: {},
    currentTransactionsLimit: CONFIG.maxTableRows, // Paginación
    searchResults: [],       // Registros correlacionados de la pestaña Búsqueda
};

const logPollState = {
    lastOffset: 0, // Inicia en null al cargar la página
    intervalId: null,
    isPolling: false,
    abortController: null,
};


/* ==========================================================
   3. UTILIDADES
   ========================================================== */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/** Evita que el texto del API se interprete como HTML. */
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
}

/** 1500 -> "1.50 s" | 320 -> "320 ms" */
function formatDuration(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : Math.round(ms) + " ms";
}

const MEXICO_TIME_FORMATTER = new Intl.DateTimeFormat(CONFIG.locale, {
    timeZone: "America/Mexico_City",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
});

/** Formatea milisegundos siempre en hora Centro de México (America/Mexico_City). */
function formatTime(timestamp) {
    if (!timestamp) return "—";
    return MEXICO_TIME_FORMATTER.format(timestamp);
}

/**
 * Convierte "23/11/2026 18:49:21.901" (hora servidor Virginia, America/New_York)
 * a milisegundos UTC reales para poder ordenarlos y pintarlos en hora de México.
 */
function parseVirginiaTimestampToMs(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    const str = String(value).trim();
    if (/^\d+$/.test(str)) return Number(str);

    // Captura formato DD/MM/YYYY HH:mm:ss(.SSS)
    const match = str.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    if (match) {
        const [, day, month, year, hour, minute, second, ms = "0"] = match;
        const milli = Number(ms.padEnd(3, "0").slice(0, 3));

        // Construimos la fecha con offset fijo de Centro de México (-06:00) para conservar exactamente la hora (ej. 18:49:21)
        const isoMexico = `${year}-${month}-${day}T${hour}:${minute}:${second}.${String(milli).padStart(3, "0")}-06:00`;
        return Date.parse(isoMexico);
    }

    const parsed = Date.parse(str);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/** Devuelve "ok", "warn", "bad" o "info" para pintar el código HTTP. */
function statusClass(status) {
    if (status >= 500) return "bad";
    if (status >= 400) return "warn";
    if (status >= 200 && status < 300) return "ok";
    return "info";
}

function average(numbers) {
    if (!numbers.length) return 0;
    return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

function percentile(numbers, p) {
    if (!numbers.length) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, index)];
}

/** Agrupa una lista: groupBy(rows, r => r.status) -> Map(status -> filas) */
function groupBy(list, getKey) {
    const groups = new Map();
    for (const item of list) {
        const key = getKey(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
}

/** Convierte un timestamp (número o texto de fecha) a milisegundos para poder ordenar. */
function parseTimestampToMs(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    const str = String(value).trim();
    if (/^\d+$/.test(str)) return Number(str);
    const parsed = Date.parse(str);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/** Nombre legible del API: la operación sin el prefijo "services:". */
function apiName(record) {
    return String(record.operation || "").replace(/^services:/, "") || record.type || "(sin nombre)";
}

/**
 * Líneas para el tooltip: las APIs más frecuentes de una lista de registros.
 * describe(nombre, registros) permite cambiar el texto de cada línea.
 */
function topApiLines(list, limit = CONFIG.tooltipTopApis,
    describe = (name, items) => `• ${name} (${items.length})`) {
    const groups = [...groupBy(list, apiName)].sort((a, b) => b[1].length - a[1].length);
    const lines = groups.slice(0, limit).map(([name, items]) => describe(name, items));
    if (groups.length > limit) lines.push(`… y ${groups.length - limit} más`);
    return lines;
}

function currentEnvironment() {
    return CONFIG.environments[state.env];
}

/** Cambia el ambiente activo y recalcula la URL base. */
function setEnvironment(name) {
    state.env = CONFIG.environments[name] ? name : CONFIG.defaultEnvironment;
    state.baseUrl = currentEnvironment().host + CONFIG.basePath;
}

/** Header Authorization (Basic) con las credenciales del ambiente activo. */
function buildAuthHeader() {
    const { user, password } = currentEnvironment();
    return "Basic " + btoa(user + ":" + password);
}

/** "2026-11-11" (input date) -> "20261111" (formato que espera el API: yyyyMMdd, sin barras) */
function isoToApiDate(iso) {
    const [year, month, day] = iso.split("-");
    return `${year}${month}${day}`;
}

/** Date -> "yyyy-mm-dd" en hora local (para limitar el calendario a hoy). */
function toIsoDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function setStatus(kind, text) {
    $("#statusDot").className = "dot " + kind;
    $("#statusText").textContent = text;
}

/** Debounce útil para inputs de búsqueda */
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}


/* ==========================================================
   4. SERIALIZACIÓN
   ========================================================== */

/** Quita espacios sobrantes (el API devuelve " 200", " post", etc.). */
function cleanValue(value) {
    return typeof value === "string" ? value.trim() : value;
}

/** "0.976s" -> 976 | "320ms" -> 320 | "1m" -> 60000 */
function parseDurationToMs(text) {
    const match = String(text ?? "").trim().match(/^([\d.]+)\s*(ms|s|m)?$/i);
    if (!match) return 0;
    const amount = parseFloat(match[1]);
    const unit = (match[2] || "ms").toLowerCase();
    if (unit === "s") return amount * 1000;
    if (unit === "m") return amount * 60000;
    return amount;
}

/** Un elemento de Items[] -> registro que usa toda la aplicación. */
function normalizeBusinessItem(item) {
    const raw = {};
    for (const key in item) raw[key] = cleanValue(item[key]);

    // Busca si el API /business trae algún campo de timestamp
    const rawTs = raw.timeStamp || raw.timestamp || raw.startTime || raw.txStartDate;

    return {
        id: raw.id,
        type: raw.type,
        api: raw.api,
        operation: raw.operation,
        method: String(raw.method || "").toUpperCase(),
        status: parseInt(raw.status, 10) || 0,
        durationMs: parseDurationToMs(raw.durationMs),
        processInstanceId: raw.processInstanceId || raw.processInstanceID,
        product: raw.product,
        stepId: String(raw.step || raw.stepId || raw.stepID || "").trim(),
        buildingBlock: raw.buildingBlock || "(sin bloque)",
        sessionId: raw.sessionDialogIdentification || raw.sessionDialogueIdentification,
        apiTimestamp: parseTimestampToMs(rawTs), // <--- NUEVO: timestamp propio si existe
        receivedAt: Date.now(),                  // respaldo: hora de llegada al navegador
    };
}

/** Un elemento de resultDocuments[] -> respuesta con el JSON ya formateado. */
function normalizeResponseDocument(doc) {
    const raw = {};
    for (const key in doc) raw[key] = cleanValue(doc[key]);

    let bodyText = String(raw.response ?? "");
    try {
        bodyText = JSON.stringify(JSON.parse(raw.response), null, 2);
    } catch (error) {
        // si no es JSON válido se muestra tal cual
    }

    const rawStartTime = raw.startTime || raw.timeStamp || "";
    const timestampMs = parseVirginiaTimestampToMs(rawStartTime);

    // Formateamos la fecha completa en hora Centro de México para las tarjetas de detalle
    const mexicoFullTime = timestampMs
        ? new Date(timestampMs).toLocaleString(CONFIG.locale, {
            timeZone: "America/Mexico_City",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }) + " (US-VA)"
        : rawStartTime;

    return {
        sessionId: raw.sessionDialogueIdentification || raw.sessionDialogIdentification,
        processInstanceId: raw.processInstanceID || raw.processInstanceId,
        status: parseInt(raw.status, 10) || 0,
        uuid: raw.uuid,                       // se correlaciona con el "id" del API de negocio
        apiName: raw.apiName || raw.apiname || "",
        startTime: mexicoFullTime,
        timestampMs,                          // milisegundos reales para ordenar y pintar en tabla
        body: bodyText,
    };
}


/* ==========================================================
   5. API
   ========================================================== */

/** GET con tiempo máximo de espera. Lanza error si falla. */
/** Con { auth: true } el request lleva el header Authorization del ambiente. */
/** GET con tiempo máximo de espera. Lanza error si falla. */
async function fetchJson(url, { auth = false } = {}) {
    if (CONFIG.logRequests || state.historyDate) console.info("[GET]", url);

    Loader.start(); // Enciende la barra global automáticamente

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    try {
        const headers = { Accept: "application/json" };
        if (auth) headers.Authorization = buildAuthHeader();

        const response = await fetch(url, { signal: controller.signal, headers });
        if (!response.ok) throw new Error("HTTP " + response.status);
        return await response.json();
    } finally {
        clearTimeout(timeout);
        Loader.stop(); // Apaga la barra cuando termina (éxito o error)
    }
}
/**
 * Agrega fromDate al final de la URL sin quitar lo que ya lleva:
 *   .../business?operation=convert  ->  .../business?operation=convert&fromDate=20261111
 * Si no hay fecha elegida (tiempo real) la URL no cambia.
 */
function withFromDate(url) {
    const todayApiDate = isoToApiDate(toIsoDate(new Date()));
    if (!state.historyDate || state.historyDate === todayApiDate) return url;

    const separator = url.includes("?") ? "&" : "?";
    return url + separator + "fromDate=" + encodeURIComponent(state.historyDate);
}

/** Lista de llamadas de negocio (viene en el objeto "Items"). */
async function getBusinessItems() {
    if (state.demoMode) {
        return buildDemoItems(state.historyDate ? 60 : 0);
    }

    const offsetParam = logPollState.lastOffset ? `&lastOffset=${encodeURIComponent(logPollState.lastOffset)}` : "&lastOffset=0";
    const url = withFromDate(state.baseUrl + CONFIG.endpoints.business + offsetParam);
    const data = await fetchJson(url, { auth: CONFIG.auth.business });

    // Solo actualiza lastOffset si el API devolvió un valor válido y no vacío
    const nextOffset = data?.nextOffset !== undefined ? data.nextOffset : data?.newText;
    if (nextOffset !== null && nextOffset !== undefined && String(nextOffset).trim() !== "") {
        logPollState.lastOffset = String(nextOffset).trim();
    }

    return data?.Items || data?.items || data?.results || [];
}

function buildResponsesUrl(sessionId) {
    const url = state.baseUrl + CONFIG.endpoints.responses + encodeURIComponent(sessionId);
    return CONFIG.sendFromDateToResponses ? withFromDate(url) : url;
}

/** Respuestas de una sesión (vienen en el objeto "resultDocuments"). */
async function getResponseDocuments(sessionId) {
    const data = state.demoMode
        ? { resultDocuments: buildDemoResponses(sessionId) }
        : await fetchJson(buildResponsesUrl(sessionId), { auth: CONFIG.auth.responses });
    return data.resultDocuments || data.results || [];
}

/** Devuelve las respuestas de una sesión usando caché, salvo que force sea true. */
async function loadResponses(sessionId, force = false) {
    if (!sessionId) return [];
    if (!force && state.responsesBySession.has(sessionId)) {
        return state.responsesBySession.get(sessionId);
    }
    const generation = state.generation;
    const documents = await getResponseDocuments(sessionId);
    const responses = documents.map(normalizeResponseDocument);
    // Si cambió la configuración mientras esperábamos, no se guarda en caché
    if (generation === state.generation) state.responsesBySession.set(sessionId, responses);
    return responses;
}

/* ----- Datos de demostración (solo para probar sin el API real) ----- */
const DEMO = {
    blocks: ["dt_bienvenida", "dt_pagos", "dt_consulta_saldo", "dt_onboarding", "dt_tarjetas"],
    operations: ["PUT_v1_onboardingDocumentation_execute", "POST_v1_payments_execute",
        "GET_v1_balance_query", "POST_v1_cards_activate"],
    products: ["2000", "3100", "4200"],
};
const randomItem = (list) => list[Math.floor(Math.random() * list.length)];
const randomHex = (length) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const randomGuid = () =>
    [8, 4, 4, 4, 12].map(randomHex).join("-");

function buildDemoItems(total) {
    const count = total || 1 + Math.floor(Math.random() * 3);
    return Array.from({ length: count }, () => {
        const dice = Math.random();
        const status = dice < 0.82 ? 200 : dice < 0.9 ? 201 : dice < 0.96 ? 400 : dice < 0.98 ? 404 : 500;
        const operation = randomItem(DEMO.operations);
        const slow = Math.random() < 0.1;
        return {
            id: randomHex(12),
            type: " busdemo_1_",
            api: " https://demo.example.com/v1/" + operation.split("_")[2],
            operation: " services:" + operation,
            method: " " + operation.split("_")[0].toLowerCase(),
            status: " " + status,
            durationMs: slow ? " " + (2 + Math.random() * 4).toFixed(3) + "s"
                : " " + (60 + Math.random() * 900).toFixed(0) + "ms",
            processInstanceId: " " + randomGuid(),
            product: " " + randomItem(DEMO.products),
            buildingBlock: " " + randomItem(DEMO.blocks),
            sessionDialogIdentification: " " + randomHex(24),
        };
    });
}

function buildDemoResponses(sessionId) {
    return [...state.records.values()]
        .filter((record) => record.sessionId === sessionId)
        .map((record) => ({
            sessionDialogueIdentification: record.sessionId,
            processInstanceID: randomGuid(),
            response: JSON.stringify({ status: record.status, message: record.status < 400 ? "Created" : "Error" }),
            status: String(record.status),
            uuid: record.id,          // misma llave que usa la correlación real
            apiName: record.type,
            startTime: new Date(record.receivedAt).toLocaleString(CONFIG.locale),
        }));
}


/* ==========================================================
   6. CONSULTA EN TIEMPO REAL
   ========================================================== */

// En Sección 6. CONSULTA EN TIEMPO REAL
let activeResponseWorkers = 0;

/**
 * Procesa la cola de sesiones con un máximo de `CONFIG.responseConcurrency`
 * peticiones en paralelo, sin esperar ciclos fijos de 3 segundos.
 */
function pumpResponseQueue() {
    if (state.paused) return;

    while (activeResponseWorkers < CONFIG.responseConcurrency && state.sessionQueue.size > 0) {
        // Toma la primera sesión pendiente
        const sessionId = state.sessionQueue.values().next().value;
        state.sessionQueue.delete(sessionId);

        // Si ya se cargó (por ejemplo, al abrir el detalle), pasa a la siguiente
        if (state.responsesBySession.has(sessionId)) continue;

        activeResponseWorkers++;
        loadResponses(sessionId)
            .then(() => {
                // Actualiza KPIs si estamos en Tablero, o repinta solo si hay fila visible sin timestamp
                if (state.activeTab === "dashboard") {
                    renderActiveTab();
                } else if (state.activeTab === "transactions") {
                    updateVisibleRowsTimestamps(sessionId);
                }
            })
            .catch(() => {
                state.responsesBySession.set(sessionId, []);
            })
            .finally(() => {
                activeResponseWorkers--;
                pumpResponseQueue(); // Toma la siguiente sesión al instante
            });
    }
}

/**
 * Actualiza únicamente la celda de Hora (td:first-child) en el DOM para las filas
 * de esa sesión sin reconstruir toda la tabla ni interrumpir animaciones.
 */
function updateVisibleRowsTimestamps(sessionId) {
    for (const r of state.records.values()) {
        if (r.sessionId !== sessionId) continue;
        const ts = getRecordEffectiveTimestamp(r);
        if (ts && r._cachedTs !== ts) {
            r._cachedTs = ts;
            r._cachedTime = formatTime(ts);
            const row = document.querySelector(`#transactionsBody tr[data-id="${CSS.escape(r.id)}"]`);
            if (row && row.firstElementChild) {
                row.firstElementChild.textContent = r._cachedTime;
            }
        }
    }
}

function addRecords(items) {
    if (!Array.isArray(items) || items.length === 0) return 0;

    const newEntries = [];
    const isIncremental = state.records.size > 0 && items.length <= 50;

    items.forEach((item, index) => {
        if (!item || (typeof item === "object" && Object.keys(item).length === 0) || (typeof item === "string" && item.trim() === "")) {
            return;
        }

        let parsedItem = item;
        if (typeof item === "string") {
            try {
                parsedItem = JSON.parse(item.trim());
            } catch (error) {
                return;
            }
        }

        if (!parsedItem || typeof parsedItem !== "object" || Array.isArray(parsedItem)) return;
        if (parsedItem.id === "id" || parsedItem.id === "ID" || parsedItem.operation === "operation") return;

        const record = normalizeBusinessItem(parsedItem);
        if (!record.id && !record.processInstanceId) {
            console.warn("[ADD] Descartado por falta de id:", parsedItem);
            return;
        }

        if (!record.id) record.id = `${record.processInstanceId}-${record.receivedAt}-${index}`;
        if (state.records.has(record.id)) {
            return;
        }

        record.arrivalSeq = ++arrivalCounter;
        newEntries.push([record.id, record]);

        // Marca el ID para animar solo si ya había datos cargados
        if (isIncremental && state.activeTab === "transactions") {
            state.newRecordIds.add(record.id);
        }

        if (record.sessionId && !state.responsesBySession.has(record.sessionId)) {
            state.sessionQueue.add(record.sessionId);
        }
    });

    if (newEntries.length === 0) return 0;

    // Pone los más nuevos al inicio del Map
    state.records = new Map([...newEntries.reverse(), ...state.records]);

    // Mantiene el límite de memoria eliminando los más antiguos al final
    const limit = state.historyDate ? CONFIG.maxHistoricalRecords : CONFIG.maxRecords;
    if (state.records.size > limit) {
        const keys = [...state.records.keys()];
        for (let i = limit; i < keys.length; i++) {
            state.records.delete(keys[i]);
        }
    }

    // Refresca la pestaña activa inmediatamente
    renderActiveTab();
    pumpResponseQueue();

    return newEntries.length;
}

/**
 * Ciclo principal.
 *  - Tiempo real: consulta, espera lo que falte para completar refreshMs y repite.
 *  - Histórico (hay fecha elegida): consulta UNA sola vez; esos datos ya no cambian.
 */
let isFetchingBusiness = false;

async function pollBusinessApi() {
    const generation = state.generation;
    const startedAt = performance.now();

    if (!state.paused) {
        try {
            const items = await getBusinessItems();

            if (generation !== state.generation) {
                console.warn("[POLL] Abortado por cambio de generation:", generation, state.generation);
                return;
            }

            const agregados = addRecords(items);

            if (state.historyDate) {
                setStatus("history", `Histórico ${state.historyDate} · ${state.records.size} registros`);
            } else {
                const where = state.demoMode ? "Demostración" : "En vivo";
                setStatus("ok", `${where} · ${state.records.size} registros`);
            }
        } catch (error) {
            console.error("[POLL] Error en consulta:", error);
            if (generation !== state.generation) return;
            const reason = error.name === "AbortError" ? "tiempo agotado" : error.message;
            setStatus("err", "Sin conexión: " + reason);
        }
    }

    if (state.historyDate) return;

    clearTimeout(state.pollTimer);
    const elapsed = performance.now() - startedAt;
    state.pollTimer = setTimeout(pollBusinessApi, Math.max(500, CONFIG.refreshMs - elapsed));
}

/** Pide en segundo plano las respuestas de las sesiones nuevas. */
function fetchQueuedResponses() {
    if (!state.paused) {
        const perCycle = state.historyDate ? CONFIG.historyResponsesPerCycle : CONFIG.responsesPerCycle;
        const sessions = [...state.sessionQueue].slice(0, perCycle);
        for (const sessionId of sessions) {
            state.sessionQueue.delete(sessionId);
            loadResponses(sessionId)
                .then(() => {
                    // Solo refresca si estamos en el Tablero (para actualizar el KPI de llamadas correlacionadas)
                    if (state.activeTab === "dashboard") {
                        renderActiveTab();
                    }
                })
                .catch(() => state.responsesBySession.set(sessionId, []));
        }
    }
    setTimeout(fetchQueuedResponses, CONFIG.refreshMs);
}


/* ==========================================================
   7. GRÁFICAS
   ========================================================== */
function createCharts() {
    Chart.defaults.font.family = "'Plus Jakarta Sans', system-ui, sans-serif";
    Chart.defaults.color = "#6B7A90";
    Chart.defaults.borderColor = "#E4E9F2";

    // Estilo del cuadro flotante (tooltip) que aparece junto al mouse
    Object.assign(Chart.defaults.plugins.tooltip, {
        backgroundColor: "#1D2939",
        padding: 12,
        cornerRadius: 12,
        boxPadding: 4,
        bodySpacing: 4,
        titleMarginBottom: 8,
    });

    const baseOptions = { responsive: true, maintainAspectRatio: false, animation: false };

    // Con "index" el tooltip aparece al pasar sobre cualquier parte de la columna/punto
    const hoverByIndex = { mode: "index", intersect: false };

    /**
     * Plugins de cada gráfica: leyenda opcional y tooltip.
     *  - formatValue(item): primera línea del tooltip (el valor).
     *  - Las líneas siguientes (nombres de API, etc.) salen de chart.$details,
     *    que se llena en updateChart() con un arreglo de líneas por cada dato.
     */
    const plugins = (formatValue, showLegend = false) => ({
        legend: showLegend
            ? { display: true, position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } }
            : { display: false },
        tooltip: {
            callbacks: {
                label: (item) => formatValue(item),
                afterBody: (items) => items[0].chart.$details?.[items[0].dataIndex] || [],
            },
        },
    });

    const verticalScales = {
        y: { beginAtZero: true, grid: { color: "#EEF2F8" } },
        x: { grid: { display: false } },
    };
    const areaGradient = (context) => {
        const gradient = context.chart.ctx.createLinearGradient(0, 0, 0, 280);
        gradient.addColorStop(0, "rgba(79, 107, 237, 0.45)");
        gradient.addColorStop(1, "rgba(79, 107, 237, 0.02)");
        return gradient;
    };
    const create = (canvasId, config) => new Chart($("#" + canvasId), config);

    // Área (montaña): tiempos en vivo
    state.charts.live = create("chartLive", {
        type: "line",
        data: {
            labels: [], datasets: [{
                data: [], fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2.5,
                pointHoverRadius: 5, pointHoverBackgroundColor: COLORS.brand,
                borderColor: COLORS.brand, backgroundColor: areaGradient,
            }]
        },
        options: {
            ...baseOptions, interaction: hoverByIndex,
            plugins: plugins((item) => `${item.parsed.y} ms`),
            scales: {
                y: { beginAtZero: true, grid: { color: "#EEF2F8" } },
                x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } },
            }
        },
    });

    // Dona: códigos de estado
    state.charts.status = create("chartStatus", {
        type: "doughnut",
        data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 3, borderColor: "#FFFFFF" }] },
        options: {
            ...baseOptions, cutout: "62%",
            plugins: plugins((item) => `${item.label}: ${item.parsed} llamadas`, true)
        },
    });

    // Barras: promedio por building block
    state.charts.blocks = create("chartBlocks", {
        type: "bar",
        data: { labels: [], datasets: [{ data: [], backgroundColor: PALETTE, borderRadius: 8, maxBarThickness: 38 }] },
        options: {
            ...baseOptions, interaction: hoverByIndex,
            plugins: plugins((item) => `${item.parsed.y} ms promedio`), scales: verticalScales
        },
    });

    // Pastel: llamadas por producto
    state.charts.products = create("chartProducts", {
        type: "pie",
        data: { labels: [], datasets: [{ data: [], backgroundColor: PALETTE, borderWidth: 3, borderColor: "#FFFFFF" }] },
        options: {
            ...baseOptions,
            plugins: plugins((item) => `${item.label}: ${item.parsed} llamadas`, true)
        },
    });

    // Barras: histograma de tiempos
    state.charts.histogram = create("chartHistogram", {
        type: "bar",
        data: {
            labels: ["<100 ms", "100–300", "300–600", "600 ms–1 s", "1–2 s", "2–5 s", ">5 s"],
            datasets: [{
                data: [], borderRadius: 8,
                backgroundColor: [COLORS.ok, COLORS.ok, COLORS.sky, COLORS.sky, COLORS.warn, COLORS.bad, COLORS.bad],
            }],
        },
        options: {
            ...baseOptions, interaction: hoverByIndex,
            plugins: plugins((item) => `${item.parsed.y} llamadas`), scales: verticalScales
        },
    });

    // Barras horizontales: operaciones más lentas
    state.charts.slowest = create("chartSlowest", {
        type: "bar",
        data: { labels: [], datasets: [{ data: [], backgroundColor: COLORS.violet, borderRadius: 8, maxBarThickness: 22 }] },
        options: {
            ...baseOptions, indexAxis: "y", interaction: hoverByIndex,
            plugins: plugins((item) => `${item.parsed.x} ms (P95)`),
            scales: {
                x: { beginAtZero: true, grid: { color: "#EEF2F8" } },
                y: { grid: { display: false } },
            }
        },
    });

    // Barras verticales: suma de durationMs por API única
    state.charts.apiTotalTime = create("chartApiTotalTime", {
        type: "bar",
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: COLORS.brand,
                borderRadius: 8,
                maxBarThickness: 42
            }]
        },
        options: {
            ...baseOptions,
            interaction: hoverByIndex,
            plugins: plugins((item) => `Duración acumulada (durationMs): ${formatDuration(item.parsed.y)}`),
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: "#EEF2F8" },
                    ticks: {
                        callback: (value) => formatDuration(value)
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        maxRotation: 35,
                        minRotation: 0
                    }
                }
            }
        }
    });
}

/**
 * Cambia etiquetas y datos de una gráfica y la redibuja sin animación.
 * details = arreglo (uno por dato) de líneas extra que se muestran en el tooltip.
 */
function updateChart(chart, labels, values, colors, details) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    if (colors) chart.data.datasets[0].backgroundColor = colors;
    chart.$details = details || [];
    chart.update("none");
}


/* ==========================================================
   8. RENDER DE PESTAÑAS
   ========================================================== */

/** Solo se dibuja la pestaña que está visible. */
function renderActiveTab() {
    state.needsRender = false;
    const records = [...state.records.values()];

    if (state.activeTab === "dashboard") renderDashboard(records);
    else if (state.activeTab === "times") renderTimes(records);
    else if (state.activeTab === "transactions") renderTransactions();
    else if (state.activeTab === "webhook") renderWebhook();
}

/**
 * Llamadas "reales": solo las del API de negocio cuyo id aparece como uuid
 * en alguna respuesta de searchResponses (ambos logs describen la misma llamada).
 */
function getCorrelatedRecords(records) {
    const responseUuids = new Set();
    for (const responses of state.responsesBySession.values()) {
        for (const response of responses) {
            if (response.uuid) responseUuids.add(response.uuid);
        }
    }
    return records.filter((record) => responseUuids.has(record.id));
}

/* ----- Pestaña: Tablero ----- */
function renderDashboard(records) {
    const durations = records.map((r) => r.durationMs);
    const successCount = records.filter((r) => r.status >= 200 && r.status < 400).length;
    const errorCount = records.filter((r) => r.status >= 400).length;

    // KPIs
    $("#kpiTotal").textContent = getCorrelatedRecords(records).length.toLocaleString(CONFIG.locale);
    $("#kpiAverage").textContent = formatDuration(average(durations));
    $("#kpiP95").textContent = formatDuration(percentile(durations, 95));
    $("#kpiSuccess").textContent = records.length
        ? ((successCount / records.length) * 100).toFixed(1) + "%" : "—";
    $("#kpiErrors").textContent = errorCount;

    // Área en vivo: el tooltip muestra API, bloque y estado de cada punto
    const timedRecords = records
        .map((r) => ({ record: r, ts: getRecordEffectiveTimestamp(r) }))
        .filter(({ ts }) => ts > 0)
        .sort((a, b) => a.ts - b.ts); // Orden cronológico real (de izquierda a derecha)

    const latestTs = timedRecords.length
        ? timedRecords[timedRecords.length - 1].ts
        : 0;
    const windowStartTs = latestTs - CONFIG.liveWindowMs;

    // Conserva todos los puntos dentro de la ventana de 1 hora respecto al último dato en memoria
    const liveWindowRecords = timedRecords.filter(({ ts }) => ts >= windowStartTs);

    updateChart(
        state.charts.live,
        liveWindowRecords.map(({ ts }) => formatTime(ts)),
        liveWindowRecords.map(({ record }) => Math.round(record.durationMs)),
        undefined,
        liveWindowRecords.map(({ record }) => [
            "API: " + apiName(record),
            "Bloque: " + record.buildingBlock,
            `Estado: ${record.status} ${record.method}`,
        ])
    );
    // Dona de códigos de estado: el tooltip lista las APIs con ese código
    const byStatus = groupBy(records, (r) => r.status);
    const statusCodes = [...byStatus.keys()].sort();
    const statusColors = { ok: COLORS.ok, warn: COLORS.warn, bad: COLORS.bad, info: COLORS.sky };
    updateChart(
        state.charts.status,
        statusCodes.map((code) => "HTTP " + code),
        statusCodes.map((code) => byStatus.get(code).length),
        statusCodes.map((code) => statusColors[statusClass(code)]),
        statusCodes.map((code) => topApiLines(byStatus.get(code)))
    );

    // Barras: promedio por building block (los más lentos primero)
    const blocks = [...groupBy(records, (r) => r.buildingBlock)]
        .map(([name, list]) => ({ name, list, avg: average(list.map((r) => r.durationMs)) }))
        .sort((a, b) => b.avg - a.avg)
        .slice(0, CONFIG.topBlocks);
    updateChart(
        state.charts.blocks,
        blocks.map((b) => b.name),
        blocks.map((b) => Math.round(b.avg)),
        undefined,
        blocks.map((b) => topApiLines(b.list, CONFIG.tooltipTopApis, (name, items) =>
            `• ${name}: ${formatDuration(average(items.map((r) => r.durationMs)))} (${items.length})`))
    );

    // Definimos los productos permitidos para limpiar variables sin resolver o basura
    const allowedProducts = ["2000", "6400"];

    const products = [...groupBy(records, (r) => r.product || "—")]
        .filter(([name]) => allowedProducts.includes(String(name).trim()));

    updateChart(
        state.charts.products,
        products.map(([name]) => "Producto " + name),
        products.map(([, list]) => list.length),
        undefined,
        products.map(([, list]) => topApiLines(list))
    );

    // Panel de errores (solo si el usuario lo abrió)
    if (state.errorsPanelOpen) renderErrorsPanel(records);
}

/* ----- Panel de errores (se abre al hacer clic en el KPI "Errores") ----- */
function renderErrorsPanel(records) {
    const errors = sortRecords(
        records.filter((r) => r.status >= 400),
        state.errorSort.field,
        state.errorSort.direction
    );
    $("#errorPanelCount").textContent = errors.length;
    updateSortIndicators("#errorsHeader", state.errorSort);
    $("#errorsBody").innerHTML = buildTransactionRows(errors.slice(0, CONFIG.maxTableRows));
}


function renderTimes(records) {
    // Toma los datos recientes en memoria (ventana de 1 hora respecto al registro más reciente)
    const timed = records
        .map((r) => ({ record: r, ts: getRecordEffectiveTimestamp(r) }))
        .filter(({ ts }) => ts > 0);

    const latestTs = timed.reduce((max, item) => (item.ts > max ? item.ts : max), 0);
    const windowStart = latestTs - (CONFIG.liveWindowMs || 60 * 60 * 1000);

    const activeRecords = timed
        .filter(({ ts }) => ts >= windowStart)
        .map(({ record }) => record);

    const limits = [100, 300, 600, 1000, 2000, 5000];
    const buckets = Array.from({ length: limits.length + 1 }, () => []);
    for (const record of activeRecords) {
        const index = limits.findIndex((limit) => record.durationMs < limit);
        buckets[index === -1 ? limits.length : index].push(record);
    }

    updateChart(
        state.charts.histogram,
        ["<100 ms", "100–300", "300–600", "600 ms–1 s", "1–2 s", "2–5 s", ">5 s"],
        buckets.map((list) => list.length),
        undefined,
        buckets.map((list) => topApiLines(list))
    );
    
    

    let stats = [...groupBy(records, (r) => r.buildingBlock + "||" + r.operation)].map(([key, list]) => {
        const [block, operation] = key.split("||");
        const durations = list.map((r) => r.durationMs);
        return { 
            block, 
            operation: operation.replace(/^services:/, ""), 
            calls: list.length, 
            average: average(durations), 
            p95: percentile(durations, 95), 
            max: Math.max(...durations), 
            errors: list.filter((r) => r.status >= 400).length 
        };
    });

    const slowest = [...stats].sort((a, b) => b.p95 - a.p95).slice(0, CONFIG.topSlowest);
    updateChart(state.charts.slowest, slowest.map((s) => s.block + " · " + s.operation.slice(0, 22)), slowest.map((s) => Math.round(s.p95)), undefined, slowest.map((s) => ["API: " + s.operation, "Bloque: " + s.block, `Llamadas: ${s.calls} · Errores: ${s.errors}`, `Promedio: ${formatDuration(s.average)} · Máx: ${formatDuration(s.max)}`]));

   
    stats = TableEngine.process("timesHeader", stats, {
        // Opcional: para que los filtros muestren valores formateados como en la tabla
        average: (s) => formatDuration(s.average),
        p95: (s) => formatDuration(s.p95),
        max: (s) => formatDuration(s.max)
    });

    const highestP95 = Math.max(1, ...stats.map((s) => s.p95));
    $("#timesTableBody").innerHTML = stats.map((s) => {
        const barColor = s.p95 > CONFIG.verySlowMs ? COLORS.bad : s.p95 > CONFIG.slowMs ? COLORS.warn : COLORS.ok;
        return `<tr><td><b>${escapeHtml(s.block)}</b></td><td title="${escapeHtml(s.operation)}">${escapeHtml(s.operation)}</td><td>${s.calls}</td><td>${formatDuration(s.average)}</td><td>${formatDuration(s.p95)}</td><td>${formatDuration(s.max)}</td><td><span class="pill ${s.errors ? "bad" : "ok"}">${s.errors}</span></td><td><div class="load-bar"><span style="width:${(s.p95 / highestP95) * 100}%; background:${barColor}"></span></div></td></tr>`;
    }).join("") || '<tr><td colspan="8" class="empty">Esperando datos…</td></tr>';

    // Agrupación por API única sumando la métrica durationMs de cada llamada en el log
    const apiTotals = [...groupBy(records, apiName)]
        .map(([name, list]) => {
            const totalDurationMs = list.reduce((sum, r) => sum + (Number(r.durationMs) || 0), 0);
            const avgMs = average(list.map((r) => r.durationMs));
            const maxMs = Math.max(...list.map((r) => r.durationMs));
            const errors = list.filter((r) => r.status >= 400).length;
            const blocks = [...new Set(list.map((r) => r.buildingBlock))].join(", ");
            return { name, totalDurationMs, calls: list.length, avgMs, maxMs, errors, blocks };
        })
        .sort((a, b) => b.totalDurationMs - a.totalDurationMs);

    updateChart(
        state.charts.apiTotalTime,
        apiTotals.map((a) => a.name),
        apiTotals.map((a) => Math.round(a.totalDurationMs)),
        apiTotals.map((a) =>
            a.totalDurationMs > CONFIG.verySlowMs * 2 ? COLORS.bad :
            a.totalDurationMs > CONFIG.slowMs * 2 ? COLORS.warn : COLORS.brand
        ),
        apiTotals.map((a) => [
            `Ejecuciones: ${a.calls}`,
            `Promedio durationMs: ${formatDuration(a.avgMs)} · Máx: ${formatDuration(a.maxMs)}`,
            `Errores: ${a.errors}`,
            `Building block(s): ${a.blocks}`
        ])
    );
}


/**
 * Devuelve el timestamp real en ms correlacionando id <-> uuid:
 * 1. Si el registro de /business ya trae timeStamp, lo usa.
 * 2. Si no, busca su respuesta en searchResponses por uuid === id y toma su timeStamp/startTime.
 * 3. Como último recurso, usa receivedAt (hora de llegada).
 */
function getRecordEffectiveTimestamp(record) {
    if (record.apiTimestamp > 0) return record.apiTimestamp;

    if (record.sessionId && state.responsesBySession.has(record.sessionId)) {
        const responses = state.responsesBySession.get(record.sessionId);
        const match = responses.find((r) => r.uuid && r.uuid === record.id);
        if (match && match.timestampMs > 0) {
            // Lo cacheamos en el registro para no buscarlo repetidamente
            record.apiTimestamp = match.timestampMs;
            return match.timestampMs;
        }
    }
    return record.receivedAt;
}
/* ----- Pestaña: Transacciones ----- */


function sortRecords(records, field, direction) {
    const factor = direction === "asc" ? 1 : -1;
    return [...records].sort((a, b) => {
        if (field === "receivedAt") {
            const diff = getRecordEffectiveTimestamp(a) - getRecordEffectiveTimestamp(b);
            // Si ocurrieron en el mismo segundo o uno aún no tiene startTime, desempata por orden de llegada del log
            if (Math.abs(diff) < 1000) {
                return ((a.arrivalSeq || 0) - (b.arrivalSeq || 0)) * factor;
            }
            return diff * factor;
        }

        const left = a[field] ?? "";
        const right = b[field] ?? "";
        if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
        return String(left).localeCompare(String(right), CONFIG.locale) * factor;
    });
}
function fillBlockSelect() {
    const select = $("#selectBlock");
    const blocks = [...new Set([...state.records.values()].map((r) => r.buildingBlock))].sort();
    if (select.options.length - 1 === blocks.length) return;   // sin cambios

    const selected = select.value;
    select.innerHTML = '<option value="">Todos los bloques</option>' + blocks.map((block) =>
        `<option ${block === selected ? "selected" : ""}>${escapeHtml(block)}</option>`).join("");
}

/** Marca con ▲/▼ la columna por la que está ordenada una tabla. */
function updateSortIndicators(headerSelector, sort) {
    $$(headerSelector + " th").forEach((th) => {
        th.classList.remove("sorted-asc", "sorted-desc");
        if (th.dataset.sort === sort.field) th.classList.add("sorted-" + sort.direction);
    });
}

/** Filas <tr> con el mismo formato para la pestaña Transacciones y el panel de errores. */
function buildTransactionRows(rows) {
    return rows.map((r) => {
        const isNew = state.newRecordIds.has(r.id);

        // Si aún no tiene hora formateada o ya se actualizó su apiTimestamp, la calcula y cachea
        const ts = getRecordEffectiveTimestamp(r);
        if (!r._cachedTime || r._cachedTs !== ts) {
            r._cachedTs = ts;
            r._cachedTime = formatTime(ts);
        }

        return `
        <tr class="clickable ${isNew ? "row-new" : ""}" data-id="${escapeHtml(r.id)}">
            <td>${r._cachedTime}</td>
            <td><b>${escapeHtml(r.buildingBlock)}</b></td>
            <td title="${escapeHtml(r.operation)}">${escapeHtml(apiName(r))}</td>
            <td>${escapeHtml(r.method)}</td>
            <td><span class="pill ${statusClass(r.status)}">${r.status}</span></td>
            <td>${formatDuration(r.durationMs)}</td>
            <td>${escapeHtml(r.product)}</td>
            <td>${escapeHtml(r.sessionId)}</td>
        </tr>`;
    }).join("") || '<tr><td colspan="8" class="empty">Sin resultados.</td></tr>';
}
// filter operation in tab transacciones

function getVisibleTransactions() {
    const text = $("#inputFilterText").value.trim().toLowerCase();
    const blockSelect = $("#selectBlock").value;

    const filtered = [...state.records.values()].filter((record) => {
        const statusMatches = state.statusFilter === "all" || String(record.status).charAt(0) === state.statusFilter;
        const blockSelectMatches = !blockSelect || record.buildingBlock === blockSelect;
        const textMatches = !text || [
            record.operation, record.buildingBlock, record.product,
            record.sessionId, record.processInstanceId, record.api
        ].join(" ").toLowerCase().includes(text);

        return statusMatches && blockSelectMatches && textMatches;
    });

    return TableEngine.process("transactionsHeader", filtered, {
        operation: (r) => apiName(r),
        // Ordena por secuencia de llegada del streamLogger (más nuevo = mayor arrivalSeq = fila #1 en desc)
        receivedAt_sort: (r) => r.arrivalSeq || 0
    });
}



function renderTransactions() {
    fillBlockSelect();

    const visibleRecords = getVisibleTransactions();
    const recordsToShow = visibleRecords.slice(0, state.currentTransactionsLimit);

    $("#transactionsBody").innerHTML = buildTransactionRows(recordsToShow);

    // Limpia los IDs ya animados para que no vuelvan a parpadear al filtrar u ordenar
    state.newRecordIds.clear();

    const btnLoadMore = $("#btnLoadMoreTransactions");
    if (visibleRecords.length > state.currentTransactionsLimit) {
        btnLoadMore.style.display = "inline-block";
        btnLoadMore.textContent = `Cargar más (${visibleRecords.length - state.currentTransactionsLimit} restantes)`;
    } else {
        btnLoadMore.style.display = "none";
    }
}

function loadMoreTransactions() {
    state.currentTransactionsLimit += 200;
    renderTransactions();
}


/** Ejemplo de botón nuevo: descarga la tabla filtrada como CSV. */
function exportTransactionsCsv() {
    const columns = ["receivedAt", "buildingBlock", "operation", "method", "status",
        "durationMs", "product", "sessionId", "processInstanceId"];
    const lines = getVisibleTransactions().map((record) =>
        columns.map((column) => `"${String(record[column] ?? "").replace(/"/g, '""')}"`).join(","));

    const csv = [columns.join(","), ...lines].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = "transacciones.csv";
    link.click();
    URL.revokeObjectURL(link.href);
}


/* ==========================================================
   9. DETALLE Y BÚSQUEDA
   ========================================================== */
function buildRecordCard(record) {
    return `
        <div class="card result-card">
            <dl class="details">
                <dt>Building block</dt><dd><b>${escapeHtml(record.buildingBlock)}</b></dd>
                <dt>Estado</dt><dd><span class="pill ${statusClass(record.status)}">${record.status}</span> ${escapeHtml(record.method)}</dd>
                <dt>Duración</dt><dd>${formatDuration(record.durationMs)}</dd>
                <dt>Operación</dt><dd>${escapeHtml(record.operation)}</dd>
                <dt>API</dt><dd>${escapeHtml(record.api)}</dd>
                <dt>Producto</dt><dd>${escapeHtml(record.product)}</dd>
                <dt>processInstanceId</dt><dd>${escapeHtml(record.processInstanceId)}</dd>
                <dt>Sesión</dt><dd>${escapeHtml(record.sessionId)}</dd>
            </dl>
        </div>`;
}

function buildResponseCards(responses) {
    if (!responses.length) return '<div class="empty">Sin respuestas registradas para esta sesión.</div>';

    return responses.map((r) => `
        <div class="card result-card">
            <h3>Respuesta <span class="pill ${statusClass(r.status)}">${r.status}</span></h3>
            <dl class="details">
                <dt>processInstanceID</dt><dd>${escapeHtml(r.processInstanceId)}</dd>
                <dt>uuid</dt><dd>${escapeHtml(r.uuid)}</dd>
                <dt>Inicio</dt><dd>${escapeHtml(r.startTime)}</dd>
            </dl>
            <pre>${escapeHtml(r.body)}</pre>
        </div>`).join("");
}

/**
 * CORRELACIÓN entre APIs:
 *   API de negocio (Items[].id)  <->  searchResponses (resultDocuments[].uuid)
 * Devuelve la respuesta cuyo uuid sea igual al id de la llamada, o null.
 */
function findCorrelatedResponse(record, responses) {
    return responses.find((response) => response.uuid && response.uuid === record.id) || null;
}

/** Tarjeta única con los datos de ambos APIs ya combinados. */
function buildCorrelatedCard(record, response) {
    const apiName = (response && response.apiName) || record.type;

    const responseSection = response ? `
        <h3 style="margin:18px 0 0">Respuesta
            <span class="pill ${statusClass(response.status)}">${response.status}</span>
        </h3>
        ${formatInteractiveJsonPre(response.body)}`
        : `<p class="error-text" style="margin-top:14px">
               No hay respuesta en searchResponses con uuid = ${escapeHtml(record.id)}.
           </p>`;

    return `
        <div class="card result-card">
            <dl class="details">
                <dt>Inicio (startTime)</dt><dd>${escapeHtml(response ? response.startTime : "—")}</dd>
                <dt>apiName</dt><dd>${escapeHtml(apiName)}</dd>
                <dt>API</dt><dd>${escapeHtml(record.api)}</dd>
                <dt>Operación</dt><dd>${escapeHtml(record.operation)}</dd>
                <dt>Building block</dt><dd><b>${escapeHtml(record.buildingBlock)}</b></dd>
                <dt>Estado</dt><dd><span class="pill ${statusClass(record.status)}">${record.status}</span> ${escapeHtml(record.method)}</dd>
                <dt>Duración</dt><dd>${formatDuration(record.durationMs)}</dd>
                <dt>Producto</dt><dd>${escapeHtml(record.product)}</dd>
                <dt>SessionDialogue</dt><dd style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <span class="mono">${escapeHtml(record.sessionId || "—")}</span>
                    ${record.sessionId ? `
                        <button type="button" class="view-btn" data-copy-text="${escapeHtml(record.sessionId)}" title="Copiar sessionDialog">
                            Copy <span class="material-symbols-outlined copyJson" style="font-size:13px;">content_copy</span>
                        </button>` : ""}
                </dd>
                <dt>processInstanceId</dt><dd>${escapeHtml(record.processInstanceId)}</dd>
                <dt>id / uuid</dt><dd>${escapeHtml(record.id)}</dd>
            </dl>
            ${responseSection}
            <button class="btn mt" data-webhook-session="${escapeHtml(record.sessionId)}">Ver mensajes webhook</button>
        </div>`;
}


/** Convierte un texto JSON en líneas HTML coloreadas y con bloques colapsables dentro de <pre>. */
function formatInteractiveJsonPre(rawBody) {
    let parsed;
    try {
        parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    } catch (e) {
        // Si no es JSON válido, lo muestra en consola oscura tal cual
        return `<pre class="json-console">${escapeHtml(rawBody)}</pre>`;
    }

    function buildLines(val, indent = 0, key = null, isLast = true) {
        const pad = "  ".repeat(indent);
        const comma = isLast ? "" : '<span class="j-punct">,</span>';
        const keyPart = key !== null ? `<span class="j-key">"${escapeHtml(key)}"</span><span class="j-punct">: </span>` : "";

        // Valores primitivos (string, number, boolean, null)
        if (val === null || typeof val !== "object") {
            let valHtml = "";
            if (val === null) valHtml = `<span class="j-null">null</span>`;
            else if (typeof val === "boolean") valHtml = `<span class="j-bool">${val}</span>`;
            else if (typeof val === "number") valHtml = `<span class="j-num">${val}</span>`;
            else valHtml = `<span class="j-str">"${escapeHtml(val)}"</span>`;
            return `${pad}${keyPart}${valHtml}${comma}\n`;
        }

        // Objetos y Arreglos
        const isArr = Array.isArray(val);
        const entries = isArr ? val.map((v, i) => [null, v]) : Object.entries(val);
        const openB = isArr ? "[" : "{";
        const closeB = isArr ? "]" : "}";

        if (entries.length === 0) {
            return `${pad}${keyPart}<span class="j-punct">${openB}${closeB}</span>${comma}\n`;
        }

        const inner = entries
            .map(([k, v], idx) => buildLines(v, indent + 1, k, idx === entries.length - 1))
            .join("");

        return `${pad}<span class="j-fold"><button type="button" class="j-toggle" title="Colapsar/Expandir">▼</button>${keyPart}<span class="j-punct">${openB}</span><span class="j-ellipsis"> … </span><span class="j-block">\n${inner}${pad}</span><span class="j-punct">${closeB}</span>${comma}</span>\n`;
    }

    const cleanJson = JSON.stringify(parsed, null, 2);

    return `
        <div class="json-console-wrap" data-raw-json="${escapeHtml(cleanJson)}">
            <div class="json-console-bar">
                <span>JSON Response</span>
                <div class="json-console-btns">
                    <button type="button" data-j-cmd="copy">Copy <span class="material-symbols-outlined copyJson">content_copy</span></button>
                    <button type="button" data-j-cmd="expand">Expandir</button>
                    <button type="button" data-j-cmd="collapse">Colapsar</button>
                </div>
            </div>
            <pre class="json-console">${buildLines(parsed)}</pre>
        </div>`;
}

async function openDetail(recordId) {
    // Busca primero en memoria general y si no está, en los resultados de Búsqueda
    const record = state.records.get(recordId)
        || state.searchResults.find((r) => r.id === recordId);
    if (!record) return;

    const drawer = $("#drawer");

    drawer.innerHTML = `
        <button class="btn" id="btnCloseDrawer">Cerrar</button>
        <h3 style="margin:16px 0">Detalle de la llamada</h3>
        <div id="drawerResponses">${Loader.spinner("Buscando respuestas...")}</div>`;

    drawer.classList.add("open");
    $("#btnCloseDrawer").onclick = closeDetail;

    try {
        const responses = await loadResponses(record.sessionId, true);
        const response = findCorrelatedResponse(record, responses) || record.correlatedResponse || null;
        $("#drawerResponses").innerHTML = buildCorrelatedCard(record, response);
    } catch (error) {
        $("#drawerResponses").innerHTML = buildCorrelatedCard(record, record.correlatedResponse || null)
            + `<p class="error-text">No se pudo consultar searchResponses: ${escapeHtml(error.message)}</p>`;
    }
}
function closeDetail() {
    $("#drawer").classList.remove("open");
}

/**
 * Busca por sessionDialogIdentification, processInstanceId (hijo) o customProcessId (padre)
 * correlacionando /business, /searchResponses y /webHookMessage (si aplica para el customProcessId).
 */
async function searchById() {
    const query = $("#inputSearch").value.trim();
    if (!query) return;

    const emptyBox = $("#searchEmptyState");
    const dashboard = $("#searchDashboard");
    dashboard.hidden = true;
    emptyBox.hidden = false;
    emptyBox.innerHTML = Loader.spinner("Correlacionando llamadas, procesos y respuestas...");

    try {
        const allRecords = [...state.records.values()];
        const sessions = new Set();
        const childProcessIds = new Set();
        let resolvedCustomId = "";

        // 1. Buscar coincidencias directas en registros de /business en memoria
        for (const r of allRecords) {
            const customId = r.customProcessId || r.customProcessInstanceId || "";
            if (r.sessionId === query || r.processInstanceId === query || customId === query) {
                if (r.sessionId) sessions.add(r.sessionId);
                if (r.processInstanceId) childProcessIds.add(r.processInstanceId);
                if (customId === query) resolvedCustomId = customId;
            }
        }

        // 2. Buscar en respuestas ya cacheadas de /searchResponses
        for (const [sessionId, responses] of state.responsesBySession) {
            if (responses.some((res) => res.processInstanceId === query || res.sessionId === query)) {
                sessions.add(sessionId);
            }
        }

        // 3. Si el query parece un sessionDialog (24 hex) y aún no está, agregarlo
        if (!sessions.size && /^[0-9a-f]{24}$/i.test(query)) {
            sessions.add(query);
        }

        // 4. Si se ingresó un customProcessId (o queremos enriquecer los hijos con su padre),
        // consultamos findStepProcesess o webHookMessage si hay sesiones disponibles
        for (const sessionId of sessions) {
            try {
                const whItems = await getWebhookMessages(sessionId);
                const normalizedWh = whItems.map(normalizeWebhookMessage);
                for (const m of normalizedWh) {
                    if (m.customProcessInstanceId) {
                        if (!resolvedCustomId && (m.customProcessInstanceId === query || childProcessIds.has(m.processInstanceId) || sessions.has(m.sessionId))) {
                            resolvedCustomId = m.customProcessInstanceId;
                        }
                        if (m.customProcessInstanceId === query && m.processInstanceId) {
                            childProcessIds.add(m.processInstanceId);
                        }
                    }
                }
            } catch (_) { /* Ignorar si webhook no devuelve datos para esa sesión */ }
        }

        // 5. Consultar /searchResponses para todas las sesiones descubiertas
        const responsesMap = new Map(); // uuid -> responseDoc
        const allResponsesList = [];

        for (const sessionId of sessions) {
            try {
                const responses = await loadResponses(sessionId, true);
                for (const res of responses) {
                    allResponsesList.push(res);
                    if (res.uuid) responsesMap.set(res.uuid, res);
                    if (res.processInstanceId === query && res.sessionId) {
                        sessions.add(res.sessionId);
                    }
                }
            } catch (err) {
                console.warn("[SEARCH] Error consultando searchResponses:", err);
            }
        }

        // 6. Construir la lista unificada de llamadas de /business filtradas por el criterio
        let matchedRecords = allRecords.filter((r) => {
            const hasBlock = r.buildingBlock && r.buildingBlock !== "(sin bloque)";
            if (!hasBlock) return false;

            const customId = r.customProcessId || r.customProcessInstanceId || "";
            return (
                r.sessionId === query ||
                r.processInstanceId === query ||
                customId === query ||
                sessions.has(r.sessionId) ||
                childProcessIds.has(r.processInstanceId)
            );
        });

        // Si en /business aún no estaban todos los registros pero sí vinieron en /searchResponses,
        // reconstruimos entradas base para no perder visibilidad en las gráficas
        const existingIds = new Set(matchedRecords.map((r) => r.id));
        for (const res of allResponsesList) {
            if (res.uuid && !existingIds.has(res.uuid)) {
                matchedRecords.push({
                    id: res.uuid,
                    type: res.apiName || "API",
                    api: res.apiName || "",
                    operation: res.apiName || "(sin operación)",
                    method: "POST",
                    status: res.status || 200,
                    durationMs: 0,
                    processInstanceId: res.processInstanceId || "",
                    customProcessId: resolvedCustomId || (customProcessIdCandidate(query, sessions, childProcessIds)),
                    product: "—",
                    buildingBlock: "(sin bloque)",
                    sessionId: res.sessionId || "",
                    apiTimestamp: res.timestampMs || 0,
                    receivedAt: res.timestampMs || Date.now(),
                });
            }
        }

        // Enriquecer cada registro con customProcessId resuelto y su respuesta correlacionada
        state.searchResults = matchedRecords.map((r) => ({
            ...r,
            customProcessId: r.customProcessId || r.customProcessInstanceId || resolvedCustomId || "—",
            correlatedResponse: responsesMap.get(r.id) || null
        }));

       if (!state.searchResults.length) {
            emptyBox.innerHTML = '<div class="empty">No se encontraron llamadas ni respuestas para el identificador proporcionado.</div>';
            return;
        }

        emptyBox.hidden = true;
        dashboard.hidden = false;

        TableEngine.resetFilters("searchHeader");
        renderSearchSummary(query, state.searchResults);
        renderSearchCharts(state.searchResults);
        renderSearchTable();

    } catch (error) {
        emptyBox.innerHTML = `<p class="error-text">Error al realizar la búsqueda: ${escapeHtml(error.message)}</p>`;
    }
}


function customProcessIdCandidate(query, sessions, childIds) {
    return (!sessions.has(query) && !childIds.has(query)) ? query : "—";
}

/** Renderiza las tarjetas KPI y llaves correlacionadas (sessionDialog, processInstanceId, customProcessId) */
/** Renderiza las tarjetas KPI con ventana de movimiento vertical para los identificadores */
function renderSearchSummary(query, records) {
    const uniqueSessions = [...new Set(records.map((r) => r.sessionId).filter(Boolean))];
    const uniqueBlocks = [...new Set(records.map((r) => r.buildingBlock).filter((b) => b && b !== "(sin bloque)"))];
    const uniqueCustom = [...new Set(records.map((r) => r.customProcessId).filter((v) => v && v !== "—"))];
    const totalSec = (records.reduce((acc, r) => acc + r.durationMs, 0) / 1000).toFixed(2);

    const displaySession = uniqueSessions.join(", ") || "—";
    const displayCustom = uniqueCustom.join(", ") || "—";

    $("#searchKeysSummary").innerHTML = `
        <div class="card kpi kpi-brand">
            <small>Total APIs ejecutadas</small>
            <b>${records.length}</b>
        </div>
        <div class="card kpi kpi-sky">
            <small>Tiempo total acumulado</small>
            <b>${totalSec} s</b>
        </div>
        <div class="card kpi kpi-violet">
            <small>sessionDialogIdentification</small>
            <div class="kpi-scroll-window" title="${escapeHtml(displaySession)}">
                <b class="kpi-id-value">${escapeHtml(displaySession)}</b>
            </div>
        </div>
        <div class="card kpi kpi-ok">
            <small>Building block</small>
            <b>${uniqueBlocks.length}</b>
        </div>
        <div class="card kpi kpi-warn">
            <small>customProcessId</small>
            <div class="kpi-scroll-window" title="${escapeHtml(displayCustom)}">
                <b class="kpi-id-value">${escapeHtml(displayCustom)}</b>
            </div>
        </div>
    `;
}

/** Construye y actualiza las 4 gráficas de la pestaña Búsqueda */
function renderSearchCharts(records) {
    // Destruir instancias previas si existen
    ["searchApiTimes", "searchBlockCount", "searchBlockPie", "searchTrend", "searchHttpRadar"].forEach((key) => {
        if (state.charts[key]) {
            state.charts[key].destroy();
            delete state.charts[key];
        }
    });

    // Orden cronológico para tendencia y lectura
    const ordered = [...records].sort((a, b) => getRecordEffectiveTimestamp(a) - getRecordEffectiveTimestamp(b));

    // --- 1. GRÁFICA IZQUIERDA (2 GRID VERTICAL): Barras horizontales (X: segundos, Y: API) ---
    const apiLabels = ordered.map((r, idx) => `${idx + 1}. ${apiName(r)}`);
    const apiSeconds = ordered.map((r) => Number((r.durationMs / 1000).toFixed(3)));

    state.charts.searchApiTimes = new Chart($("#chartSearchApiTimes"), {
        type: "bar",
        data: {
            labels: apiLabels,
            datasets: [{
                label: "Tiempo de ejecución (s)",
                data: apiSeconds,
                backgroundColor: ordered.map((r) =>
                    r.status >= 400 ? COLORS.bad : r.durationMs > CONFIG.slowMs ? COLORS.warn : COLORS.brand
                ),
                borderRadius: 6,
                maxBarThickness: 26,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: "y",
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.x} s`,
                        afterBody: (items) => {
                            const r = ordered[items[0].dataIndex];
                            return [
                                `Building Block: ${r.buildingBlock}`,
                                `HTTP: ${r.status} (${r.method})`,
                                `processInstanceId: ${r.processInstanceId || "—"}`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    title: { display: true, text: "Tiempo (segundos)" },
                    grid: { color: "#EEF2F8" }
                },
                y: { grid: { display: false } }
            }
        }
    });

    // --- Agrupación por Building Block para las 2 gráficas de la derecha ---
    const byBlock = [...groupBy(ordered, (r) => r.buildingBlock)];
    const blockNames = byBlock.map(([name]) => name);
    const blockCounts = byBlock.map(([, list]) => list.length);
    const blockTotalSeconds = byBlock.map(([, list]) =>
        Number((list.reduce((sum, item) => sum + item.durationMs, 0) / 1000).toFixed(3))
    );

    // --- 2. DERECHA GRID 1: Relación de cantidad de APIs por Building Block ---
    state.charts.searchBlockCount = new Chart($("#chartSearchBlockCount"), {
        type: "bar",
        data: {
            labels: blockNames,
            datasets: [{
                label: "Llamadas API",
                data: blockCounts,
                backgroundColor: PALETTE,
                borderRadius: 6,
                maxBarThickness: 36
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y} APIs ejecutadas`,
                        afterBody: (items) => topApiLines(byBlock[items[0].dataIndex][1])
                    }
                }
            },
            scales: {
                y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: "#EEF2F8" } },
                x: { grid: { display: false } }
            }
        }
    });

    // --- 3. DERECHA GRID 2: Pastel de tiempo acumulado (s) por Building Block ---
    state.charts.searchBlockPie = new Chart($("#chartSearchBlockPie"), {
        type: "pie",
        data: {
            labels: blockNames,
            datasets: [{
                data: blockTotalSeconds,
                backgroundColor: PALETTE,
                borderWidth: 2,
                borderColor: "#FFFFFF"
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.label}: ${ctx.parsed} s totales`,
                        afterBody: (items) => topApiLines(byBlock[items[0].dataIndex][1], 5, (name, list) => {
                            const sec = (list.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(2);
                            return `• ${name}: ${sec} s`;
                        })
                    }
                }
            }
        }
    });

    // --- 4. INFERIOR FULL WIDTH 1: Barras verticales + Línea de tendencia ---
    // Cálculo de regresión lineal simple para la línea de tendencia
    const n = apiSeconds.length;
    const sumX = apiSeconds.reduce((acc, _, i) => acc + i, 0);
    const sumY = apiSeconds.reduce((acc, val) => acc + val, 0);
    const sumXY = apiSeconds.reduce((acc, val, i) => acc + i * val, 0);
    const sumXX = apiSeconds.reduce((acc, _, i) => acc + i * i, 0);
    const slope = n > 1 ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) : 0;
    const intercept = n > 0 ? (sumY - slope * sumX) / n : 0;
    const trendData = apiSeconds.map((_, i) => Number((intercept + slope * i).toFixed(3)));

    state.charts.searchTrend = new Chart($("#chartSearchTrend"), {
        data: {
            labels: ordered.map((r) => apiName(r)),
            datasets: [
                {
                    type: "bar",
                    label: "Tiempo de respuesta (s)",
                    data: apiSeconds,
                    backgroundColor: "rgba(99, 71, 209, 0.72)",
                    borderRadius: 6,
                    maxBarThickness: 38,
                    order: 2
                },
                {
                    type: "line",
                    label: "Tendencia (s)",
                    data: trendData,
                    borderColor: COLORS.bad,
                    backgroundColor: COLORS.bad,
                    borderWidth: 2.5,
                    pointRadius: 3,
                    tension: 0.2,
                    fill: false,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: true, position: "top" },
                tooltip: {
                    callbacks: {
                        afterBody: (items) => {
                            const r = ordered[items[0].dataIndex];
                            return [`Hora: ${formatTime(getRecordEffectiveTimestamp(r))}`, `Bloque: ${r.buildingBlock}`];
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: "Segundos" },
                    grid: { color: "#EEF2F8" }
                },
                x: { grid: { display: false } }
            }
        }
    });

    // --- 5. INFERIOR FULL WIDTH 2: Gráfica Radar de APIs vs Códigos HTTP estándar ---
    const standardHttpCodes = [200, 201, 204, 400, 401, 403, 404, 408, 409, 422, 500, 502, 503, 504];
    const detectedCodes = [...new Set(ordered.map((r) => r.status).filter((s) => s > 0))];
    const radarAxisCodes = [...new Set([...standardHttpCodes, ...detectedCodes])].sort((a, b) => a - b);

    const byUniqueApi = [...groupBy(ordered, apiName)];
    const radarDatasets = byUniqueApi.map(([name, list], idx) => {
        const color = PALETTE[idx % PALETTE.length];
        return {
            label: name,
            data: radarAxisCodes.map((code) => list.filter((r) => r.status === code).length),
            borderColor: color,
            backgroundColor: color + "26", // ~15% opacidad
            borderWidth: 2,
            pointRadius: 3.5,
            pointBackgroundColor: color
        };
    });

    state.charts.searchHttpRadar = new Chart($("#chartSearchHttpRadar"), {
        type: "radar",
        data: {
            labels: radarAxisCodes.map((c) => `HTTP ${c}`),
            datasets: radarDatasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "right", labels: { usePointStyle: true, boxWidth: 8 } }
            },
            scales: {
                r: {
                    beginAtZero: true,
                    ticks: { stepSize: 1, backdropColor: "transparent" },
                    grid: { color: "#E2E5E9" },
                    angleLines: { color: "#E2E5E9" }
                }
            }
        }
    });
}

/** Renderiza la tabla de Búsqueda procesada con TableEngine (filtros tipo Excel + ordenamiento) */
function renderSearchTable() {
    const processed = TableEngine.process("searchHeader", state.searchResults, {
        operation: (r) => apiName(r),
        receivedAt_sort: (r) => getRecordEffectiveTimestamp(r)
    });

    $("#searchTableCount").textContent = `${processed.length} registros`;

    $("#searchTableBody").innerHTML = processed.map((r) => {
        const ts = getRecordEffectiveTimestamp(r);
        return `
            <tr class="clickable" data-id="${escapeHtml(r.id)}">
                <td>${formatTime(ts)}</td>
                <td><b>${escapeHtml(r.buildingBlock)}</b></td>
                <td title="${escapeHtml(r.operation)}">${escapeHtml(apiName(r))}</td>
                <td>${escapeHtml(r.method)}</td>
                <td><span class="pill ${statusClass(r.status)}">${r.status}</span></td>
                <td>${formatDuration(r.durationMs)}</td>
                <td class="mono">${escapeHtml(r.sessionId || "—")}</td>
                <td class="mono">${escapeHtml(r.processInstanceId || "—")}</td>
                <td class="mono">${escapeHtml(r.customProcessId || "—")}</td>
            </tr>`;
    }).join("") || '<tr><td colspan="9" class="empty">Sin registros que coincidan con el filtro.</td></tr>';
}


/* ==========================================================
   9B. WEBHOOK (pestaña "Webhook")
   API: GET webHookMessage?sessionDialogueIdentification=...   (sin autenticación)
   ========================================================== */

/** Estado inicial de la pestaña (también se usa para limpiarla). */
function newWebhookState() {
    return { sessionId: "", messages: [], status: "idle", error: "", filter: "all" };
}

let webhookRequestId = 0;   // evita que una búsqueda lenta pise a una más reciente

/** Campos que ya tienen su propia columna; el resto se muestra como "extra". */
const WEBHOOK_KNOWN_FIELDS = [
    "sessionDialogueIdentification", "sessionDialogIdentification",
    "processInstanceId", "processInstanceID", "customProcessInstanceId",
    "exitCode", "channelScreen", "taskId", "txId",
    "startTime", "txStartDate", "processDefinitionName", "product",
];

/** Si un valor de texto contiene un JSON, lo convierte para mostrarlo formateado. */
function expandJsonStrings(object) {
    const result = {};
    for (const key in object) {
        const value = object[key];
        const looksLikeJson = typeof value === "string" && /^[\[{]/.test(value.trim());
        try {
            result[key] = looksLikeJson ? JSON.parse(value) : value;
        } catch (error) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * El API entrega los campos dentro de un grupo:
 *   { "dt_ContextoTransaccional": { "exitCode": "9999", "channelScreen": "OFFICE", ... } }
 * Esta función los sube al primer nivel y recuerda el nombre del grupo.
 */
function flattenWebhookItem(item) {
    const flat = {};
    const origins = [];
    for (const key in item) {
        const value = item[key];
        const isGroup = value && typeof value === "object" && !Array.isArray(value);
        if (isGroup) {
            Object.assign(flat, value);
            origins.push(key);
        } else {
            flat[key] = value;
        }
    }
    return { flat, origins };
}

/** Un mensaje del API -> objeto limpio que usa la pestaña. */
function normalizeWebhookMessage(item, index) {
    const { flat, origins } = flattenWebhookItem(item);
    const raw = {};
    for (const key in flat) raw[key] = cleanValue(flat[key]);

    const extra = Object.keys(raw)
        .filter((key) => !WEBHOOK_KNOWN_FIELDS.includes(key))
        .map((key) => [key, typeof raw[key] === "object" && raw[key] !== null
            ? JSON.stringify(raw[key]) : String(raw[key] ?? "")]);
    if (origins.length) extra.unshift(["origen", origins.join(", ")]);

    // txId llega como "%dt_ContextoTransaccional/txId%" cuando la variable no se resolvió
    const rawTaskId = String(raw.taskId ?? raw.txId ?? "").trim();
    const taskId = /^%.*%$/.test(rawTaskId) ? "" : rawTaskId;

    return {
        index,
        sessionId: raw.sessionDialogueIdentification || raw.sessionDialogIdentification || "",
        processInstanceId: raw.processInstanceId || raw.processInstanceID || "",
        customProcessInstanceId: raw.customProcessInstanceId || "",
        exitCode: String(raw.exitCode ?? "").trim(),        // "" = el mensaje no trae exitCode
        channelScreen: String(raw.channelScreen ?? "").trim(),
        taskId,
        startTime: String(raw.startTime ?? raw.txStartDate ?? "").trim(),
        processName: String(raw.processDefinitionName ?? "").trim(),
        product: String(raw.product ?? "").trim(),
        extra,                                              // [[campo, valor], ...]
        rawJson: JSON.stringify(expandJsonStrings(item), null, 2),
    };
}

/** Saca la lista del JSON, sin importar cómo la nombre el API. */
function extractWebhookList(data) {
    if (Array.isArray(data)) return data;
    const list = data?.Items || data?.items || data?.resultDocuments || data?.results || data?.messages;
    if (Array.isArray(list)) return list;
    const isSingleMessage = data && (data.exitCode !== undefined || data.channelScreen || data.taskId);
    return isSingleMessage ? [data] : [];
}

/** GET webHookMessage con el sessionDialogueIdentification en la URL. */
async function getWebhookMessages(sessionId) {
    if (state.demoMode) return buildDemoWebhookMessages(sessionId);

    let url = state.baseUrl + CONFIG.endpoints.webhook + encodeURIComponent(sessionId);
    if (CONFIG.sendFromDateToWebhook) url = withFromDate(url);
    return extractWebhookList(await fetchJson(url, { auth: CONFIG.auth.webhook }));
}

function buildDemoWebhookMessages(sessionId) {
    const screens = ["WEB", "OFFICE", "MOBILE", "ATM"];
    const exits = ["0000", "9999", "5001"];
    const parentId = randomGuid();   // proceso padre end-to-end (customProcessInstanceId)
    const children = [["SP_PerfilTransaccional", randomGuid()], ["SP_ValidacionTelefono", randomGuid()]];

    // Misma forma que el API real: los campos dentro de dt_ContextoTransaccional
    return screens.map((screen, index) => {
        const [processName, childId] = children[index % 2];
        return {
            dt_ContextoTransaccional: {
                txId: randomHex(16),
                sessionDialogueIdentification: sessionId,
                txStartDate: new Date().toLocaleString(CONFIG.locale),
                processDefinitionName: processName,
                processInstanceID: childId,
                customProcessInstanceId: parentId,
                stepId: "S" + (index * 3 + 4),
                channelScreen: screen,
                pntFront: "pnt_" + screen.toLowerCase(),
                taskId: String(30790 + index),
                product: randomItem(DEMO.products),
                exitCode: index >= 2 ? randomItem(exits) : "",
            }
        };
    });
}

/** Busca los mensajes de una sesión. Sin argumento usa el texto del campo. */
async function searchWebhook(sessionId) {
    const query = String(sessionId ?? $("#inputWebhookSession").value).trim();
    if (!query) return;
    $("#inputWebhookSession").value = query;

    const requestId = ++webhookRequestId;
    state.webhook = { ...newWebhookState(), sessionId: query, status: "loading" };
    renderWebhook();

    try {
        const items = await getWebhookMessages(query);
        if (requestId !== webhookRequestId) return;
        state.webhook.messages = items.map(normalizeWebhookMessage);
        state.webhook.status = "done";
    } catch (error) {
        if (requestId !== webhookRequestId) return;
        state.webhook.status = "error";
        state.webhook.error = error.name === "AbortError" ? "tiempo agotado" : error.message;
    }
    renderWebhook();
}

function setWebhookFilter(filter) {
    state.webhook.filter = filter;
    renderWebhook();
}

function renderWebhook() {
    const webhook = state.webhook;
    const summary = $("#webhookSummary");
    const results = $("#webhookResults");

    summary.innerHTML = "";
    $("#webhookToolbar").hidden = webhook.status !== "done";

    if (webhook.status === "idle") {
        results.innerHTML = '<div class="empty">Escribe un sessionDialogueIdentification para ver sus mensajes webhook.</div>';
        return;
    }
    if (webhook.status === "loading") {
        results.innerHTML = '<div class="empty">Consultando webHookMessage…</div>';
        return;
    }
    if (webhook.status === "error") {
        results.innerHTML = `<p class="error-text">No se pudo consultar webHookMessage: ${escapeHtml(webhook.error)}</p>`;
        return;
    }

    const withExit = webhook.messages.filter((m) => m.exitCode !== "");
    const screens = new Set(webhook.messages.map((m) => m.channelScreen).filter(Boolean));
    const lastExit = withExit[withExit.length - 1];

    // KPIs + aviso con el último exitCode recibido (lo más importante)
    summary.innerHTML = `
        <div class="grid kpi-grid">
            <div class="card kpi kpi-brand"><small>Mensajes</small><b>${webhook.messages.length}</b></div>
            <div class="card kpi kpi-violet"><small>Con exitCode</small><b>${withExit.length}</b></div>
            <div class="card kpi kpi-sky"><small>Pantallas distintas</small><b>${screens.size}</b></div>
        </div>
        ${lastExit ? `
        <div class="exit-banner">
            <span class="pill exit big">${escapeHtml(lastExit.exitCode)}</span>
            <span>exitCode recibido en
                <button class="screen-link" data-action="screen" data-index="${lastExit.index}">
                    ${escapeHtml(lastExit.channelScreen || "(sin pantalla)")}
                </button>
            </span>
        </div>` : ""}`;

    $$("[data-webhook-filter]").forEach((chip) =>
        chip.classList.toggle("active", chip.dataset.webhookFilter === webhook.filter));

    const visible = webhook.filter === "exit" ? withExit : webhook.messages;
    results.innerHTML = `
        <div class="card">
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Hora</th>
                            <th>exitCode</th>
                            <th>channelScreen</th>
                            <th>Proceso</th>
                            <th>Producto</th>
                            <th>taskId</th>
                            <th>processInstanceId</th>
                            <th>customProcessInstanceId</th>
                        </tr>
                    </thead>
                    <tbody>${visible.map(buildWebhookRow).join("")
        || '<tr><td colspan="8" class="empty">Sin mensajes para mostrar.</td></tr>'}</tbody>
                </table>
            </div>
        </div>`;
}

function buildWebhookRow(message) {
    const hasExit = message.exitCode !== "";
    return `
        <tr class="${hasExit ? "has-exit" : ""}">
            <td>${escapeHtml(message.startTime || "—")}</td>
            <td>${hasExit ? `<span class="pill exit">${escapeHtml(message.exitCode)}</span>` : "—"}</td>
            <td>${message.channelScreen
            ? `<button class="screen-link" data-action="screen" data-index="${message.index}">${escapeHtml(message.channelScreen)}</button>`
            : "—"}</td>
            <td title="${escapeHtml(message.processName)}">${escapeHtml(message.processName || "—")}</td>
            <td>${escapeHtml(message.product || "—")}</td>
            ${buildIdCell(message.taskId, viewTaskButton(message))}
            ${buildIdCell(message.processInstanceId, viewStepsButton(message, "processInstanceId"))}
            ${buildIdCell(message.customProcessInstanceId, viewStepsButton(message, "customProcessInstanceId"))}
        </tr>`;
}

/* ----- Cuadro de diálogo con el detalle de la pantalla ----- */
function buildScreenDialogHtml(message) {
    const extraRows = message.extra.map(([key, value]) =>
        `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");

    return `
        <div class="screen-highlight">
            <div>
                <small>exitCode</small>
                ${message.exitCode !== ""
            ? `<span class="pill exit big">${escapeHtml(message.exitCode)}</span>`
            : '<span class="muted-text">Sin exitCode</span>'}
            </div>
            <div>
                <small>channelScreen</small>
                <b>${escapeHtml(message.channelScreen || "—")}</b>
            </div>
            <div>
                <small>taskId</small>
                <span class="mono">${escapeHtml(message.taskId || "—")}</span>
                ${viewTaskButton(message)}
            </div>
        </div>

        <dl class="details">
            <dt>Sesión</dt><dd>${escapeHtml(message.sessionId)}</dd>
            <dt>processInstanceId</dt><dd>${escapeHtml(message.processInstanceId || "—")} ${viewStepsButton(message, "processInstanceId")}</dd>
            <dt>customProcessInstanceId</dt><dd>${escapeHtml(message.customProcessInstanceId || "—")} ${viewStepsButton(message, "customProcessInstanceId")}</dd>
            <dt>Hora</dt><dd>${escapeHtml(message.startTime)}</dd>
            <dt>Proceso</dt><dd>${escapeHtml(message.processName)}</dd>
            <dt>Producto</dt><dd>${escapeHtml(message.product)}</dd>
            ${extraRows}
        </dl>

        <h4 class="dialog-subtitle">Contenido completo del mensaje</h4>
        <pre>${escapeHtml(message.rawJson)}</pre>`;
}

function openScreenDialog(index) {
    const message = state.webhook.messages[index];
    if (!message) return;

    $("#screenDialogTitle").textContent = message.channelScreen || "Detalle de la pantalla";
    $("#screenDialogBody").innerHTML = buildScreenDialogHtml(message);
    const dialog = $("#screenDialog");
    if (!dialog.open) dialog.showModal();
}

/* ----- Datos de la tarea (API getTaskData) ----- */
const EYE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

let taskRequestId = 0;   // evita que una respuesta lenta pise a una más reciente

/** Botón "Ver" (ojo) genérico. No se dibuja si el campo está vacío. */
function viewButton(action, message, field, title) {
    if (!message[field]) return "";
    return `<button class="view-btn" data-action="${action}" data-index="${message.index}" `
        + `data-field="${field}" title="${title}">${EYE_ICON} Ver</button>`;
}

/** Ver datos de la tarea (getTaskData) a partir del taskId. */
function viewTaskButton(message) {
    return viewButton("task", message, "taskId", "Ver datos de la tarea");
}

/** Ver pasos del proceso (findStepProcesess). field = processInstanceId | customProcessInstanceId */
function viewStepsButton(message, field) {
    return viewButton("steps", message, field, "Ver pasos del proceso");
}

/** Celda de tabla con un identificador largo recortado y su botón Ver. */
function buildIdCell(value, buttonHtml) {
    return `<td><div class="id-cell">
                <span class="mono id-text" title="${escapeHtml(value)}">${escapeHtml(value || "—")}</span>
                ${buttonHtml}
            </div></td>`;
}

/** Mismo host que la URL base, otro path: .../getTaskData?taskId=... */
function buildTaskDataUrl(taskId) {
    const origin = currentEnvironment().host;
    const url = origin + CONFIG.endpoints.taskData + "?taskId=" + encodeURIComponent(taskId);
    return CONFIG.sendFromDateToTaskData ? withFromDate(url) : url;
}

async function getTaskData(taskId) {
    if (state.demoMode) {
        return {
            results: [{
                taskId,
                taskName: "Validar identidad del cliente",
                status: "COMPLETED",
                assignee: "system",
                createdAt: new Date().toLocaleString(CONFIG.locale),
                payload: JSON.stringify({ documento: "INE", intentos: 1 }),
            }]
        };
    }
    return fetchJson(buildTaskDataUrl(taskId), { auth: CONFIG.auth.taskData });
}

/** Campos simples en lista clave/valor; objetos y arreglos en bloques de JSON. */
function buildFieldsCard(object) {
    const scalars = [];
    const nested = [];
    for (const [key, value] of Object.entries(object)) {
        if (value !== null && typeof value === "object") nested.push([key, value]);
        else scalars.push([key, value]);
    }
    const list = scalars.map(([key, value]) =>
        `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
    const blocks = nested.map(([key, value]) =>
        `<h4 class="dialog-subtitle">${escapeHtml(key)}</h4><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`).join("");

    return `<div class="card result-card">${list ? `<dl class="details">${list}</dl>` : ""}${blocks}</div>`;
}

function buildTaskDataHtml(data) {
    // La lista puede venir en results / Items / resultDocuments, o ser el objeto directo
    const list = Array.isArray(data) ? data : (data?.results || data?.Items || data?.items || data?.resultDocuments);
    const items = Array.isArray(list) ? list : [data];
    if (!items.length) return '<div class="empty">getTaskData no devolvió información para este taskId.</div>';

    return items.map((item) => buildFieldsCard(expandJsonStrings(item))).join("")
        + `<details class="raw-json"><summary>JSON completo</summary>
               <pre>${escapeHtml(JSON.stringify(expandJsonStrings(data), null, 2))}</pre></details>`;
}

/** Abre el panel derecho (el mismo de Transacciones) con los datos de la tarea. */
async function openTaskData(message) {
    const requestId = ++taskRequestId;
    const drawer = $("#drawer");
    drawer.innerHTML = `
        <button class="btn" id="btnCloseDrawer">Cerrar</button>
        <h3 style="margin:16px 0">Datos de la tarea</h3>
        <div class="card result-card">
            <dl class="details">
                <dt>taskId</dt><dd class="mono">${escapeHtml(message.taskId)}</dd>
                <dt>channelScreen</dt><dd><b>${escapeHtml(message.channelScreen || "—")}</b></dd>
                <dt>exitCode</dt><dd>${message.exitCode !== ""
            ? `<span class="pill exit">${escapeHtml(message.exitCode)}</span>` : "—"}</dd>
                <dt>Sesión</dt><dd>${escapeHtml(message.sessionId)}</dd>
            </dl>
        </div>
        <div id="drawerTask">Consultando getTaskData…</div>`;
    drawer.classList.add("open");
    $("#btnCloseDrawer").onclick = closeDetail;

    try {
        const data = await getTaskData(message.taskId);
        if (requestId !== taskRequestId) return;
        $("#drawerTask").innerHTML = buildTaskDataHtml(data);
    } catch (error) {
        if (requestId !== taskRequestId) return;
        $("#drawerTask").innerHTML =
            `<p class="error-text">No se pudo consultar getTaskData: ${escapeHtml(error.message)}</p>`;
    }
}

/* ----- Pasos del proceso (API findStepProcesess) ----- */
let stepsRequestId = 0;   // evita que una respuesta lenta pise a una más reciente

/** Mismo host que la URL base, otro path: .../findStepProcesess?instanceID=... */
function buildStepsUrl(instanceId) {
    const url = currentEnvironment().host + CONFIG.endpoints.findSteps
        + "?instanceID=" + encodeURIComponent(instanceId);
    return CONFIG.sendFromDateToSteps ? withFromDate(url) : url;
}

async function getInstanceSteps(instanceId) {
    if (state.demoMode) {
        // Dos variantes para probar el diagrama: una termina bien y la otra se rompe en un servicio
        const broken = "89abcdef".includes(instanceId.charAt(0).toLowerCase());
        const flow = [
            ["EVI.Inicio del trámite", "Concluida", "PRT"],
            ["TS.ConsultarCliente", "Concluida", "PRT"],
            ["COD.tipoCliente", "Concluida", "PRT"],
            ["TU.Capturar INE", "Concluida", "WF"],
            broken ? ["TS.ValidarINE", "Error", "PRT"] : ["TS.RegistrarAprobacion", "Concluida", "PRT"],
            ...(broken ? [] : [["COC.fin validaciones", "Concluida", "PRT"], ["EVF.Trámite finalizado", "Concluida", "PRT"]]),
        ];
        const now = Date.now();
        return {
            response: {
                instanceSteps: flow.map(([label, status, system], i) => ({
                    AUDITTIMESTAMP: now + i * 1500,
                    AUDITTIMESTRING: new Date(now + i * 1500).toISOString().replace("T", " ").replace("Z", " UTC"),
                    INSTANCEID: instanceId, INSTANCEITERATION: 1, STEPID: "S" + (i + 1), STEPITERATION: 1,
                    STATUS: status === "Concluida" ? 2 : 3, USERNAME: null, ROLENAME: null, SYSTEM_: 1,
                    STEPLABEL: label, STATUSDECODE: status, SYSTEMDECODE: system,
                }))
            }
        };
    }
    return fetchJson(buildStepsUrl(instanceId), { auth: CONFIG.auth.findSteps });
}

/** Un paso del API (campos en MAYÚSCULAS) -> objeto limpio. */
function normalizeStep(rawStep) {
    const f = {};
    for (const key in rawStep) f[key.toUpperCase()] = rawStep[key];
    const text = (value) => String(value ?? "").trim();

    return {
        timestamp: Number(f.AUDITTIMESTAMP) || 0,
        time: text(f.AUDITTIMESTRING),
        instanceId: text(f.INSTANCEID),
        instanceIteration: text(f.INSTANCEITERATION),
        stepId: text(f.STEPID),
        stepIteration: text(f.STEPITERATION),
        status: text(f.STATUS),
        statusText: text(f.STATUSDECODE),
        user: text(f.USERNAME),
        role: text(f.ROLENAME),
        system: text(f.SYSTEM_),
        systemText: text(f.SYSTEMDECODE),
        label: text(f.STEPLABEL),
        simulation: String(f.SIMULATION).toLowerCase() === "true" || f.SIMULATION === true
    };
}

/**
 * Saca los pasos de la respuesta. Formatos aceptados:
 *   { response: { instanceSteps: [...] } }        <- el actual
 *   { results: [ { instanceSteps: [...] } ] }     <- el anterior
 * Devuelve los pasos ordenados del más antiguo al más reciente.
 */
function extractInstanceSteps(data) {
    let body = data?.response ?? data;
    if (typeof body === "string") {            // por si "response" llega como texto JSON
        try { body = JSON.parse(body); } catch (error) { body = {}; }
    }

    const rawSteps = [];
    if (Array.isArray(body?.instanceSteps)) rawSteps.push(...body.instanceSteps);

    if (!rawSteps.length) {
        const results = Array.isArray(body) ? body : (body?.results || body?.Items || body?.items || []);
        for (const item of Array.isArray(results) ? results : []) {
            if (Array.isArray(item?.instanceSteps)) {
                rawSteps.push(...item.instanceSteps);
            } else if (item && Object.keys(item).some((key) => key.toUpperCase() === "STEPID")) {
                rawSteps.push(item);               // results[] ya son pasos
            }
        }
    }
    return rawSteps.map(normalizeStep).sort((a, b) => a.timestamp - b.timestamp);
}

/** Color del paso según el texto de STATUSDECODE (ajusta las palabras a tu catálogo). */
function stepStatusClass(step) {
    const text = step.statusText.toLowerCase();
    if (/cancel|error|fall|rechaz/.test(text)) return "bad";
    if (/conclu|complet|finaliz|termin/.test(text)) return "ok";
    if (/inici|proceso|curso|activ|pend|espera/.test(text)) return "warn";
    return "info";
}

function buildStepsHtml(steps, data) {
    if (!steps.length) {
        return '<div class="empty">findStepProcesess no devolvió pasos para este instanceID.</div>';
    }

    const items = steps.map((step) => {
        const color = stepStatusClass(step);
        const extras = [
            step.stepIteration ? `Iteración del paso: ${step.stepIteration}` : "",
            step.instanceIteration ? `Iteración de la instancia: ${step.instanceIteration}` : "",
            step.user ? `Usuario: ${step.user}` : "",
            step.role ? `Rol: ${step.role}` : "",
        ].filter(Boolean).join(" · ");

        return `
            <li class="step">
                <span class="step-dot ${color}"></span>
                <div class="step-body">
                    <div class="step-head">
                        <span class="step-id">${escapeHtml(step.stepId)}</span>
                        <span class="step-label">${escapeHtml(step.label || "(sin etiqueta)")}</span>
                    </div>
                    <div class="step-meta">
                        <span class="pill ${color}">${escapeHtml(step.statusText || step.status || "—")}</span>
                        ${step.systemText ? `<span class="pill info">${escapeHtml(step.systemText)}</span>` : ""}
                        <small>${escapeHtml(step.time)}</small>
                    </div>
                    <small class="step-extra">${escapeHtml(extras)}</small>
                </div>
            </li>`;
    }).join("");

    return `
        <div class="card result-card">
            <h3>${steps.length} ${steps.length === 1 ? "paso" : "pasos"}</h3>
            <ol class="steps">${items}</ol>
        </div>
        <details class="raw-json"><summary>JSON completo</summary>
            <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;
}

/** Abre el panel derecho con los pasos del proceso de un instanceID. */
async function openInstanceSteps(message, field) {
    const instanceId = message[field];
    const requestId = ++stepsRequestId;
    const drawer = $("#drawer");
    drawer.innerHTML = `
        <button class="btn" id="btnCloseDrawer">Cerrar</button>
        <h3 style="margin:16px 0">Pasos del proceso</h3>
        <div class="card result-card">
            <dl class="details">
                <dt>instanceID</dt><dd class="mono">${escapeHtml(instanceId)}</dd>
                <dt>Origen</dt><dd>${escapeHtml(field)}</dd>
                <dt>channelScreen</dt><dd><b>${escapeHtml(message.channelScreen || "—")}</b></dd>
                <dt>Sesión</dt><dd>${escapeHtml(message.sessionId)}</dd>
            </dl>
        </div>
        <button class="btn mt" data-bpm-query="${escapeHtml(instanceId)}">Ver diagrama BPM</button>
        <div id="drawerSteps" style="margin-top:14px">Consultando findStepProcesess…</div>`;
    drawer.classList.add("open");
    $("#btnCloseDrawer").onclick = closeDetail;

    try {
        const data = await getInstanceSteps(instanceId);
        if (requestId !== stepsRequestId) return;
        $("#drawerSteps").innerHTML = buildStepsHtml(extractInstanceSteps(data), data);
    } catch (error) {
        if (requestId !== stepsRequestId) return;
        $("#drawerSteps").innerHTML =
            `<p class="error-text">No se pudo consultar findStepProcesess: ${escapeHtml(error.message)}</p>`;
    }
}

/** Un solo manejador de clics para la pestaña y para el diálogo. */
function handleWebhookClick(event) {
    const element = event.target.closest("[data-action]");
    if (!element) return;

    const message = state.webhook.messages[Number(element.dataset.index)];
    if (!message) return;

    if (element.dataset.action === "screen") openScreenDialog(message.index);
    const action = element.dataset.action;
    if (action === "task" || action === "steps") {
        if ($("#screenDialog").open) $("#screenDialog").close();   // deja libre el panel derecho
        if (action === "task") openTaskData(message);
        else openInstanceSteps(message, element.dataset.field);
    }
}


/* ==========================================================
   10. EVENTOS
   Para agregar un botón: ponlo en index.html y conéctalo aquí.
   ========================================================== */
function showTab(tabName) {
    state.activeTab = tabName;
    $$(".tab-button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + tabName));

    // resetear limite de transacciones si se cambia de tab
    if (tabName !== "transactions") {
        state.currentTransactionsLimit = CONFIG.maxTableRows;
    }

    renderActiveTab();
    Object.values(state.charts).forEach((chart) => chart.resize());
}

function togglePause() {
    state.paused = !state.paused;
    $("#btnPause").textContent = state.paused ? "Reanudar" : "Pausar";
    if (state.paused) setStatus("err", "En pausa");
    else pumpResponseQueue();
}

/** Guarda la configuración, vacía los datos y reinicia la consulta. */
function applyConfig() {
    setEnvironment($(".env-btn.active")?.dataset.env);
    state.demoMode = false;

    const selectedDate = $("#inputDate").value;
    const isToday = selectedDate === toIsoDate(new Date());

    // Solo guarda fecha histórica si es un día anterior a hoy
    state.historyDate = (selectedDate && !isToday) ? isoToApiDate(selectedDate) : "";

    try {
        localStorage.setItem("obs-config", JSON.stringify({ env: state.env, demoMode: state.demoMode }));
    } catch (error) { /* el navegador puede bloquear el almacenamiento */ }

    showEnvironment();
    state.generation++;
    state.paused = false;
    $("#btnPause").textContent = "Pausar";
    $("#btnPause").disabled = !!state.historyDate;

    clearData();
    clearTimeout(state.pollTimer);
    pollBusinessApi();
}

document.addEventListener("click", (event) => {
    ["dropdownOperacion", "dropdownTxBlock", "dropdownTimesOperacion", "dropdownTimesBlock"].forEach(id => {
        const dropdown = document.getElementById(id);
        if (dropdown && dropdown.classList.contains("show")) {
            if (!event.target.closest("th[data-sort]")) {
                dropdown.classList.remove("show");
            }
        }
    });
});

/** Botón "Hoy (en vivo)": quita la fecha y vuelve al tiempo real. */
function backToLive() {
    $("#inputDate").value = "";
    applyConfig();
}

function clearData() {
    state.records.clear();
    state.newRecordIds.clear(); // Garantiza que la siguiente carga inicial no anime
    state.responsesBySession.clear();
    state.sessionQueue.clear();
    state.webhook = newWebhookState();
    webhookRequestId++;
    arrivalCounter = 0;
    logPollState.lastOffset = 0;
    state.needsRender = true;
    state.currentTransactionsLimit = CONFIG.maxTableRows;
    renderActiveTab();
}

function setStatusFilter(button) {
    state.statusFilter = button.dataset.status;
    $$(".chip[data-status]").forEach((chip) => chip.classList.toggle("active", chip === button));
    renderActiveTab();
}

/** Clic en un encabezado: ordena por esa columna; otro clic invierte el orden. */
function sortByColumn(sortState, field) {
    if (sortState.field === field) {
        sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
    } else {
        sortState.field = field;
        sortState.direction = "asc";
    }
    renderActiveTab();
}

/** Abre o cierra el panel de errores que está debajo de las gráficas del tablero. */
function toggleErrorsPanel(open = !state.errorsPanelOpen) {
    state.errorsPanelOpen = open;
    $("#errorPanel").hidden = !open;
    $("#kpiErrorsCard").setAttribute("aria-expanded", String(open));
    $("#kpiErrorsCard").classList.toggle("active", open);
    renderActiveTab();
    if (open) $("#errorPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}


/** Alterna entre tema oscuro y tema claro, persistiendo en localStorage */

function toggleTheme() {
    const body = document.body;
    const isDark = body.getAttribute("data-theme") === "dark";
    const nextTheme = isDark ? "light" : "dark";

    body.setAttribute("data-theme", nextTheme);
    try {
        localStorage.setItem("obs-theme", nextTheme);
    } catch (e) { /* ignorar si está bloqueado */ }

    updateThemeUI(nextTheme);
}

function updateThemeUI(theme) {
    const isDark = theme === "dark";
    const icon = isDark ? "☀️" : "🌙";
    const headerIcon = $("#themeIcon");
    const sidebarIcon = $("#sidebarThemeIcon");
    const sidebarText = $("#sidebarThemeText");

    if (headerIcon) headerIcon.textContent = icon;
    if (sidebarIcon) sidebarIcon.textContent = icon;
    if (sidebarText) sidebarText.textContent = isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro";
}

function bindEvents() {
    $$(".tab-button").forEach((button) =>
        button.addEventListener("click", () => showTab(button.dataset.tab)));

    $("#btnPause").addEventListener("click", togglePause);// Dentro de bindEvents() en app.js:
    const toggleConfigSidebar = (forceState) => {
        const panel = $("#configPanel");
        const backdrop = $("#configBackdrop");
        const isOpen = typeof forceState === "boolean" ? forceState : !panel.classList.contains("open");
        panel.classList.toggle("open", isOpen);
        backdrop.classList.toggle("open", isOpen);
    };

    $("#btnConfig").addEventListener("click", () => toggleConfigSidebar());
    $("#btnCloseConfig")?.addEventListener("click", () => toggleConfigSidebar(false));
    $("#configBackdrop")?.addEventListener("click", () => toggleConfigSidebar(false));
    $("#btnApply").addEventListener("click", applyConfig);
    $("#btnClear").addEventListener("click", clearData);
    $("#btnToday").addEventListener("click", backToLive);

    // Cambiar de ambiente aplica de inmediato (limpia los datos y vuelve a consultar)
    $$(".env-btn").forEach((button) => button.addEventListener("click", () => {
        $$(".env-btn").forEach((b) => b.classList.toggle("active", b === button));
        applyConfig();
    }));

    // Tablero: KPI de errores y su panel
    $("#kpiErrorsCard").addEventListener("click", () => toggleErrorsPanel());
    $("#kpiErrorsCard").addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleErrorsPanel();
        }
    });

    // Botón Refresh en la esquina superior derecha de la gráfica de tiempos
    $("#btnRefreshHistogram")?.addEventListener("click", async () => {
        const btn = $("#btnRefreshHistogram");
        if (btn) btn.disabled = true;

        try {
            // Si está en modo en vivo, fuerza una consulta inmediata de nuevos registros al API
            if (!state.historyDate) {
                clearTimeout(state.pollTimer);
                await pollBusinessApi();
            }
            // Fuerza el redibujado de la gráfica y la tabla con los datos actuales en memoria
            renderActiveTab();
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    // Dentro de bindEvents()
    document.addEventListener("visibilitychange", () => {
        // Si el usuario vuelve a la pestaña y no está en pausa ni en modo histórico,
        // dispara una consulta inmediata sin esperar al timer dormido
        if (!document.hidden && !state.paused && !state.historyDate) {
            clearTimeout(state.pollTimer);
            pollBusinessApi();
        }
    });

    $("#searchTableBody").addEventListener("click", (event) => {
        const row = event.target.closest("tr[data-id]");
        if (row) openDetail(row.dataset.id);
    });

    $("#btnCloseErrors").addEventListener("click", () => toggleErrorsPanel(false));
    $("#errorsHeader").addEventListener("click", (event) => {
        const th = event.target.closest("th[data-sort]");
        if (th) sortByColumn(state.errorSort, th.dataset.sort);
    });
    $("#errorsBody").addEventListener("click", (event) => {
        const row = event.target.closest("tr[data-id]");
        if (row) openDetail(row.dataset.id);
    });

    // Transacciones
    $$(".chip[data-status]").forEach((chip) => chip.addEventListener("click", () => setStatusFilter(chip)));

    // Filtros de columna tipo Excel (Transacciones y Tiempos)
    const filterInputIds = [
        "#inputFilterText",
    ];

    filterInputIds.forEach((selector) => {
        const input = $(selector);
        if (!input) return;

        // 1. Mientras escribe (espera 300ms)
        input.addEventListener("input", debounce(renderActiveTab, 300));

        // 2. Al presionar Enter: filtra de inmediato y cierra el desplegable (si está dentro de uno)
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                renderActiveTab();
                const dropdown = input.closest(".show");
                if (dropdown) dropdown.classList.remove("show");
            }
        });

        // 3. Al quitar el foco (blur) o confirmar cambio: filtra de inmediato
        input.addEventListener("blur", renderActiveTab);
        input.addEventListener("change", renderActiveTab);

        // Evita que hacer clic dentro del input dispare el ordenamiento del <th>
        input.addEventListener("click", (event) => event.stopPropagation());
    });

    $("#selectBlock").addEventListener("change", renderActiveTab);
    $("#btnExport").addEventListener("click", exportTransactionsCsv);
    $("#btnLoadMoreTransactions").addEventListener("click", loadMoreTransactions);


    $("#transactionsBody").addEventListener("click", (event) => {
        const row = event.target.closest("tr[data-id]");
        if (row) openDetail(row.dataset.id);
    });

    // Webhook
    $("#btnWebhookSearch").addEventListener("click", () => searchWebhook());
    $("#inputWebhookSession").addEventListener("keydown", (event) => {
        if (event.key === "Enter") searchWebhook();
    });
    $$("[data-webhook-filter]").forEach((chip) =>
        chip.addEventListener("click", () => setWebhookFilter(chip.dataset.webhookFilter)));
    $("#tab-webhook").addEventListener("click", handleWebhookClick);
    $("#screenDialogBody").addEventListener("click", handleWebhookClick);
    $("#btnCloseDialog").addEventListener("click", () => $("#screenDialog").close());
    $("#screenDialog").addEventListener("click", (event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();   // clic en el fondo
    });

    // Panel lateral (#drawer): colapsar JSON, copiar JSON, copiar sessionDialog e ir a Webhook
    $("#drawer").addEventListener("click", (event) => {
        // 1. Controles individuales ▼ / ▶ del árbol JSON
        const toggleBtn = event.target.closest(".j-toggle");
        if (toggleBtn) {
            const fold = toggleBtn.closest(".j-fold");
            const isCollapsed = fold.classList.toggle("is-collapsed");
            toggleBtn.textContent = isCollapsed ? "▶" : "▼";
            return;
        }

        // 2. Botones de la barra superior del JSON (Copy / Expandir / Colapsar)
        const cmdBtn = event.target.closest("[data-j-cmd]");
        if (cmdBtn) {
            const wrap = cmdBtn.closest(".json-console-wrap");
            const cmd = cmdBtn.dataset.jCmd;

            if (cmd === "copy") {
                const rawJson = wrap?.dataset.rawJson || wrap?.querySelector("pre")?.textContent || "";
                copyToClipboard(rawJson, cmdBtn);
                return;
            }

            const expand = cmd === "expand";
            wrap.querySelectorAll(".j-fold").forEach((fold, idx) => {
                const shouldCollapse = !expand && idx > 0;
                fold.classList.toggle("is-collapsed", shouldCollapse);
                const btn = fold.querySelector(":scope > .j-toggle");
                if (btn) btn.textContent = shouldCollapse ? "▶" : "▼";
            });
            return;
        }

        // 3. Copiar identificadores como sessionDialog
        const copyBtn = event.target.closest("[data-copy-text]");
        if (copyBtn) {
            copyToClipboard(copyBtn.dataset.copyText, copyBtn);
            return;
        }

        // 4. Botón "Ver mensajes webhook"
        const webhookBtn = event.target.closest("[data-webhook-session]");
        if (webhookBtn) {
            closeDetail();
            showTab("webhook");
            searchWebhook(webhookBtn.dataset.webhookSession);
        }
    });

    // Búsqueda
    $("#btnSearch").addEventListener("click", searchById);
    $("#inputSearch").addEventListener("keydown", (event) => {
        if (event.key === "Enter") searchById();
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeDetail();
    });
}

/** Abre/Cierra el filtro de columna tipo Excel */
function toggleColumnFilter(event, dropdownId) {
    event.stopPropagation();
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    const isShowing = dropdown.classList.toggle("show");
    if (isShowing) {
        dropdown.querySelector("input").focus();
    }
}

// Cierra el filtro automáticamente si haces clic fuera de la cabecera
document.addEventListener("click", (event) => {
    ["dropdownOperacion", "dropdownTimesOperacion", "dropdownTimesBlock"].forEach(id => {
        const dropdown = document.getElementById(id);
        if (dropdown && dropdown.classList.contains("show")) {
            if (!event.target.closest("th[data-sort]")) {
                dropdown.classList.remove("show");
            }
        }
    });
});


/** Utilidad transversal para animaciones de carga */
const Loader = {
    activeRequests: 0,

    // Inicia la barra de carga superior
    start: () => {
        Loader.activeRequests++;
        const bar = $("#globalLoader");
        if (bar && Loader.activeRequests === 1) {
            bar.classList.add("is-loading");
        }
    },

    // Detiene la barra superior cuando no hay peticiones pendientes
    stop: () => {
        Loader.activeRequests = Math.max(0, Loader.activeRequests - 1);
        const bar = $("#globalLoader");
        if (bar && Loader.activeRequests === 0) {
            bar.classList.remove("is-loading");
        }
    },

    // Genera el HTML de un spinner circular para insertarlo en paneles
    spinner: (texto = "Cargando...") => `
        <div class="spinner-container">
            <div class="spinner"></div>
            <small>${escapeHtml(texto)}</small>
        </div>`
};


/* ==========================================================
   11. INICIO
   ========================================================== */
/** Refleja el ambiente activo en el panel de configuración y en la etiqueta del encabezado. */
function showEnvironment() {
    $$(".env-btn").forEach((button) =>
        button.classList.toggle("active", button.dataset.env === state.env));
    $("#inputBaseUrl").value = state.baseUrl;
    $("#envBadge").textContent = state.env;
    $("#envBadge").dataset.env = state.env;
}

function loadSavedConfig() {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem("obs-config") || "{}");
    } catch (error) { /* se usan los valores por defecto */ }

    setEnvironment(saved.env);        // sin valor guardado usa CONFIG.defaultEnvironment
    state.demoMode = !!saved.demoMode;

    const savedTheme = localStorage.getItem("obs-theme") || "dark";
    document.body.setAttribute("data-theme", savedTheme);
    updateThemeUI(savedTheme);

    showEnvironment();
    $("#inputDate").max = toIsoDate(new Date());   // no se pueden elegir días futuros

}

function init() {
    loadSavedConfig();
    createCharts();

    // Registrar las tablas en el motor homologado
    TableEngine.register("timesHeader", {
        defaultSort: { field: "p95", direction: "desc" },
        onChange: () => renderActiveTab()
    });

    TableEngine.register("transactionsHeader", {
        defaultSort: CONFIG.defaultSort,
        onChange: () => renderActiveTab()
    });

    TableEngine.register("searchHeader", {
    defaultSort: { field: "receivedAt", direction: "asc" },
    onChange: () => renderSearchTable()
});

    bindEvents();
    pollBusinessApi();
    setInterval(() => { if (state.needsRender) renderActiveTab(); }, CONFIG.refreshMs);
}

init();