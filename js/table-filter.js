"use strict";

/* ==========================================================
   MOTOR UNIVERSAL DE FILTROS TIPO EXCEL Y ORDENAMIENTO
   Uso en HTML: <th data-sort="campo" data-filter="campo">Nombre</th>
   ========================================================== */
const TableEngine = {
    tables: new Map(), // tableId -> { filters: Map(field -> Set(selectedValues)), sort: { field, direction }, onChange }
    activeDropdown: null,

    /**
     * Inicializa una tabla por el ID de su <thead> (ej. "timesHeader", "transactionsHeader", "instancesHeader")
     */
    register(headerId, { defaultSort = null, onChange = () => {} } = {}) {
        const headerRow = document.getElementById(headerId);
        if (!headerRow) return;

        const tableState = {
            filters: new Map(),
            sort: defaultSort ? { ...defaultSort } : { field: "", direction: "asc" },
            onChange
        };
        this.tables.set(headerId, tableState);

        // 1. Transformar automáticamente cada <th> con data-filter
        headerRow.querySelectorAll("th[data-filter]").forEach((th) => {
            const field = th.dataset.filter;
            const titleText = th.textContent.trim();

            th.innerHTML = `
                <div class="th-filter-header">
                    <span class="th-title">${escapeHtml(titleText)}</span>
                    <button type="button" class="btn-filter-icon" data-filter-btn="${escapeHtml(field)}" title="Filtrar ${escapeHtml(titleText)}">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                        </svg>
                    </button>
                </div>`;
        });

        // 2. Delegación de eventos en el encabezado (Ordenar vs Abrir Filtro)
        headerRow.addEventListener("click", (event) => {
            const filterBtn = event.target.closest("[data-filter-btn]");
            if (filterBtn) {
                event.stopPropagation();
                this.toggleDropdown(headerId, filterBtn.dataset.filterBtn, filterBtn);
                return;
            }

            const th = event.target.closest("th[data-sort]");
            if (th) {
                const field = th.dataset.sort;
                if (tableState.sort.field === field) {
                    tableState.sort.direction = tableState.sort.direction === "asc" ? "desc" : "asc";
                } else {
                    tableState.sort.field = field;
                    tableState.sort.direction = "asc";
                }
                this.updateSortUI(headerId);
                tableState.onChange();
            }
        });

        this.updateSortUI(headerId);
    },

    /**
     * Filtra y ordena un arreglo de datos según la configuración actual de la tabla.
     * valueExtractors permite personalizar cómo se lee un campo (ej. formatTime o apiName).
     */
    process(headerId, dataList, valueExtractors = {}) {
        const tableState = this.tables.get(headerId);
        if (!tableState) return dataList;

        // Guardamos los últimos datos crudos para poblar los checkboxes con valores reales
        tableState.lastRawData = dataList;
        tableState.extractors = valueExtractors;

        // 1. Filtrado por checkboxes seleccionados
        const filtered = dataList.filter((item) => {
            for (const [field, allowedSet] of tableState.filters.entries()) {
                if (!allowedSet || allowedSet.size === 0) continue; // Sin filtro activo
                const rawVal = this.extractValue(item, field, valueExtractors);
                if (!allowedSet.has(rawVal)) return false;
            }
            return true;
        });

        // 2. Ordenamiento
        const { field, direction } = tableState.sort;
        if (!field) return filtered;

        const factor = direction === "asc" ? 1 : -1;
        return [...filtered].sort((a, b) => {
            const left = valueExtractors[field + "_sort"]
                ? valueExtractors[field + "_sort"](a)
                : (a[field] ?? "");
            const right = valueExtractors[field + "_sort"]
                ? valueExtractors[field + "_sort"](b)
                : (b[field] ?? "");

            if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
            return String(left).localeCompare(String(right), CONFIG.locale) * factor;
        });
    },

    extractValue(item, field, extractors = {}) {
        const val = extractors[field] ? extractors[field](item) : item[field];
        const str = String(val ?? "").trim();
        return str === "" ? "(Vacío)" : str;
    },

    /** Abre el menú flotante de checkboxes posicionado debajo del botón embudo */
    toggleDropdown(headerId, field, buttonEl) {
        if (this.activeDropdown && this.activeDropdown.headerId === headerId && this.activeDropdown.field === field) {
            this.closeDropdown();
            return;
        }
        this.closeDropdown();

        const tableState = this.tables.get(headerId);
        const rawData = tableState.lastRawData || [];
        const extractors = tableState.extractors || {};

        // Obtener valores únicos ordenados
       const uniqueValues = [...new Set(rawData.map((row) => this.extractValue(row, field, extractors)))]
                .sort((a, b) => a.localeCompare(b, CONFIG.locale, { numeric: true }));

        const currentSelected = tableState.filters.get(field); // undefined = todos seleccionados

        // Crear el popover en el body (evita que overflow-x: auto de .table-wrap lo corte)
        const popover = document.createElement("div");
        popover.className = "excel-filter-popover";
        popover.innerHTML = `
            <input type="text" class="excel-filter-search" placeholder="Buscar valor..." autocomplete="off">
            <label class="excel-filter-item select-all">
                <input type="checkbox" data-check-all ${!currentSelected ? "checked" : ""}>
                <span>(Seleccionar todo)</span>
            </label>
            <div class="excel-filter-list">
                ${uniqueValues.map((val) => {
                    const checked = !currentSelected || currentSelected.has(val) ? "checked" : "";
                    return `
                        <label class="excel-filter-item" data-val-text="${escapeHtml(val.toLowerCase())}">
                            <input type="checkbox" value="${escapeHtml(val)}" ${checked}>
                            <span title="${escapeHtml(val)}">${escapeHtml(val)}</span>
                        </label>`;
                }).join("") || '<div class="muted-text" style="padding:8px;font-size:12px;">Sin valores</div>'}
            </div>
            <div class="excel-filter-actions">
                <button type="button" class="btn" data-action="clear">Limpiar</button>
                <button type="button" class="btn btn-solid" data-action="apply">Aplicar</button>
            </div>
        `;

        document.body.appendChild(popover);

        // Posicionar justo debajo del botón embudo
        const rect = buttonEl.getBoundingClientRect();
        const top = rect.bottom + window.scrollY + 6;
        let left = rect.left + window.scrollX - 180 + rect.width;
        if (left < 10) left = 10;
        popover.style.top = `${top}px`;
        popover.style.left = `${left}px`;

        // Eventos internos del popover
        const searchInput = popover.querySelector(".excel-filter-search");
        const checkAll = popover.querySelector("[data-check-all]");
        const itemCheckboxes = () => [...popover.querySelectorAll(".excel-filter-list input[type='checkbox']")];

        searchInput.focus();
        searchInput.addEventListener("input", () => {
            const q = searchInput.value.trim().toLowerCase();
            popover.querySelectorAll(".excel-filter-list .excel-filter-item").forEach((lbl) => {
                lbl.style.display = lbl.dataset.valText.includes(q) ? "flex" : "none";
            });
        });

        checkAll.addEventListener("change", () => {
            itemCheckboxes().forEach((cb) => {
                if (cb.closest(".excel-filter-item").style.display !== "none") {
                    cb.checked = checkAll.checked;
                }
            });
        });

        popover.querySelector('[data-action="clear"]').addEventListener("click", () => {
            tableState.filters.delete(field);
            this.updateFilterIconUI(headerId, field, false);
            this.closeDropdown();
            tableState.onChange();
        });

        popover.querySelector('[data-action="apply"]').addEventListener("click", () => {
            const allCbs = itemCheckboxes();
            const checkedCbs = allCbs.filter((cb) => cb.checked);

            if (checkedCbs.length === 0 || checkedCbs.length === allCbs.length) {
                tableState.filters.delete(field);
                this.updateFilterIconUI(headerId, field, false);
            } else {
                tableState.filters.set(field, new Set(checkedCbs.map((cb) => cb.value)));
                this.updateFilterIconUI(headerId, field, true);
            }
            this.closeDropdown();
            tableState.onChange();
        });

        popover.addEventListener("click", (e) => e.stopPropagation());
        this.activeDropdown = { headerId, field, element: popover };
    },

    closeDropdown() {
        if (this.activeDropdown) {
            this.activeDropdown.element.remove();
            this.activeDropdown = null;
        }
    },

    updateFilterIconUI(headerId, field, isActive) {
        const btn = document.querySelector(`#${headerId} [data-filter-btn="${field}"]`);
        if (btn) btn.classList.toggle("is-filtered", isActive);
    },

    updateSortUI(headerId) {
        const tableState = this.tables.get(headerId);
        if (!tableState) return;
        document.querySelectorAll(`#${headerId} th`).forEach((th) => {
            th.classList.remove("sorted-asc", "sorted-desc");
            if (th.dataset.sort === tableState.sort.field) {
                th.classList.add("sorted-" + tableState.sort.direction);
            }
        });
    },

    resetFilters(headerId) {
        const tableState = this.tables.get(headerId);
        if (!tableState) return;
        tableState.filters.clear();
        document.querySelectorAll(`#${headerId} .btn-filter-icon`).forEach((btn) => btn.classList.remove("is-filtered"));
    }
};

// Cerrar el menú flotante al hacer clic fuera o presionar Escape
document.addEventListener("click", () => TableEngine.closeDropdown());
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") TableEngine.closeDropdown();
});