// poll-worker.js
"use strict";

let timerId = null;
let abortController = null;
let config = {
    url: "",
    authHeader: "",
    useAuth: false,
    refreshMs: 3000,
    timeoutMs: 15000,
    lastOffset: "0",
    paused: false,
    running: false,
    generation: 0
};

async function tick() {
    if (!config.running || config.paused) return;

    const currentGen = config.generation;
    const startedAt = performance.now();

    abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);

    try {
        const separator = config.url.includes("?") ? "&" : "?";
        const fullUrl = `${config.url}${separator}lastOffset=${encodeURIComponent(config.lastOffset || "0")}`;

        const headers = { Accept: "application/json" };
        if (config.useAuth && config.authHeader) {
            headers.Authorization = config.authHeader;
        }

        const response = await fetch(fullUrl, {
            signal: abortController.signal,
            headers
        });

        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();

        // Ignorar respuesta si hubo un cambio de ambiente/fecha mientras viajaba
        if (currentGen !== config.generation) return;

        // Actualizar offset internamente en el worker
        const nextOffset = data?.nextOffset !== undefined ? data.nextOffset : data?.newText;
        if (nextOffset !== null && nextOffset !== undefined && String(nextOffset).trim() !== "") {
            config.lastOffset = String(nextOffset).trim();
        }

        const items = data?.Items || data?.items || data?.results || [];
        self.postMessage({ type: "DATA", items, generation: currentGen });

    } catch (error) {
        if (currentGen !== config.generation) return;
        const reason = error.name === "AbortError" ? "tiempo agotado" : error.message;
        self.postMessage({ type: "ERROR", reason, generation: currentGen });
    } finally {
        clearTimeout(timeout);
        if (config.running && !config.paused && currentGen === config.generation) {
            const elapsed = performance.now() - startedAt;
            clearTimeout(timerId);
            timerId = setTimeout(tick, Math.max(500, config.refreshMs - elapsed));
        }
    }
}

self.onmessage = (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case "START":
            clearTimeout(timerId);
            if (abortController) abortController.abort();
            Object.assign(config, payload, { running: true });
            tick();
            break;

        case "PAUSE":
            config.paused = payload.paused;
            clearTimeout(timerId);
            if (!config.paused && config.running) {
                tick();
            }
            break;

        case "RESET_OFFSET":
            config.lastOffset = "0";
            break;

        case "STOP":
            config.running = false;
            clearTimeout(timerId);
            if (abortController) abortController.abort();
            break;
    }
};