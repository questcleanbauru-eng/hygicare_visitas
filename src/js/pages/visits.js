import { state, navigateTo, addDocumentClickListener } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, getSyncTimestamp, setSyncTimestamp, mergeById, attemptOrQueue } from '../api.js';
import {
    escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, parseInputDate,
    groupVisitsByMonth, formatMonthKey, normalizeVisit, compareVisitsByDateDesc, visitTypeClass,
    formatDateForDisplay, formatDateForInput, formatTimeForInput, formatInputDateFromDisplay,
    formatDateFieldValue, normalizeDisplayDateValue, formatTimeFieldValue, normalizeTimeValue,
    normalizeProposal
} from '../utils/format.js';
import {
    debounce, downloadCSV, rebuildFilterOptions, initializeSearchableInput, renderDetailRow,
    showToast, showFieldError, clearFieldError, openExternal, skeletonList, skeletonDetail,
    loadingState, showRefreshIndicator, hideRefreshIndicator, addFabAndScrollTop
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, ensureStyles } from '../utils/ui.js';
import { getProposals } from './proposals.js';
import { getFunil } from './funil.js';

export function fillVisitsContent(container, visits) {
    let normalizedVisits = (visits || [])
        .map((visit) => normalizeVisit(visit))
        .sort((a, b) => compareVisitsByDateDesc(a, b));

    if (normalizedVisits.length === 0) {
        const scopeIsLimited = state.visitsScope && state.visitsScope !== 'all';
        container.innerHTML = `
            ${scopeIsLimited ? `
            <div class="scope-banner scope-days-ctrl">
                <label for="scope-dias-input">Período:</label>
                <input type="number" id="scope-dias-input" class="scope-dias-input" value="${state.loadDias || 90}" min="1" max="365">
                <span>dias</span>
                <button type="button" id="scope-load-days" class="scope-days-load-btn">Carregar</button>
                <button type="button" id="scope-load-all" class="scope-load-btn">Ver tudo</button>
            </div>` : ''}
            <div class="empty-state">
                <span class="empty-state-icon">📋</span>
                <p>${scopeIsLimited ? `Nenhuma visita nos últimos ${state.loadDias || 90} dias.` : 'Nenhuma visita registrada ainda.'}</p>
                <button type="button" class="btn-add" id="empty-new-visit">+ Nova Visita</button>
            </div>
        `;
        document.getElementById('empty-new-visit')?.addEventListener('click', () => navigateTo('visit-new'));
        if (scopeIsLimited) {
            document.getElementById('scope-load-days')?.addEventListener('click', () => {
                const v = parseInt(document.getElementById('scope-dias-input')?.value, 10);
                if (v > 0) { state.loadDias = v; saveCache('visits', null); navigateTo('visits'); }
            });
            document.getElementById('scope-load-all')?.addEventListener('click', async () => {
                container.innerHTML = `<div class="scope-loading">Carregando histórico completo...</div>`;
                try {
                    const r = await callAPI('getVisits', { user: state.currentUser, meses: 0 });
                    if (r.status === 'success') {
                        state.visits = r.visits || [];
                        state.visitsScope = 'all';
                        saveCache('visits_all', state.visits);
                        fillVisitsContent(container, state.visits);
                    }
                } catch(e) {}
            });
        }
        return;
    }

    const availableTypes   = Array.from(new Set(normalizedVisits.map((v) => v.tipoVisita).filter(Boolean))).sort();
    const availableCities  = Array.from(new Set(normalizedVisits.map((v) => v.cidade).filter(Boolean))).sort();
    const isAdmGer         = isAdminOrGerenteUser();
    const isAdmin          = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const availableVendors = isAdmGer
        ? Array.from(new Set(normalizedVisits.map((v) => v.vendedorGerente).filter(Boolean))).sort()
        : [];

    container.innerHTML = `
        <div class="search-bar-wrapper">
            <span class="search-bar-icon">🔍</span>
            <input type="text" id="visit-filter-search" placeholder="Buscar cliente, contato ou cidade..." class="form-input">
            ${isAdmin ? `<button type="button" class="csv-export-btn" id="visits-csv-btn" title="Exportar CSV">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v13M8 11l4 4 4-4"/><path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/></svg>
                CSV
            </button>` : ''}
        </div>
        <div class="card visits-filter-card">
            <div class="visits-filter-header">
                <div><strong>Filtros</strong></div>
                <div class="visits-filter-header-actions">
                    <button type="button" class="mini-button" id="visit-filters-clear">Limpar</button>
                    <button type="button" class="mini-button visits-filter-toggle" id="visit-filters-toggle" aria-expanded="true" aria-controls="visit-filters-panel">Ocultar</button>
                </div>
            </div>
            <div class="visits-filter-grid" id="visit-filters-panel">
                <div class="form-group">
                    <label for="visit-filter-period">Período</label>
                    <select id="visit-filter-period">
                        <option value="">Todos</option>
                        <option value="mes-atual">Mês atual</option>
                        <option value="ultimos-3m">Últimos 3 meses</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="visit-filter-type">Tipo da Visita</label>
                    <select id="visit-filter-type">
                        <option value="">Todos</option>
                        ${availableTypes.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label for="visit-filter-city">Cidade</label>
                    <select id="visit-filter-city">
                        <option value="">Todas</option>
                        ${availableCities.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label for="visit-filter-prospeccao">Prospecção</label>
                    <select id="visit-filter-prospeccao">
                        <option value="">Todas</option>
                        <option value="Sim">Sim</option>
                        <option value="Nao">Não</option>
                    </select>
                </div>
                ${isAdmGer && availableVendors.length > 0 ? `
                <div class="form-group">
                    <label for="visit-filter-vendor">Vendedor</label>
                    <select id="visit-filter-vendor">
                        <option value="">Todos</option>
                        ${availableVendors.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}
                    </select>
                </div>` : ''}
                <div class="form-group">
                    <label for="visit-filter-date-from">Data inicial</label>
                    <input type="date" id="visit-filter-date-from">
                </div>
                <div class="form-group">
                    <label for="visit-filter-date-to">Data final</label>
                    <input type="date" id="visit-filter-date-to">
                </div>
            </div>
        </div>
        <div class="scope-banner scope-days-ctrl">
            <label for="scope-dias-input">Período:</label>
            <input type="number" id="scope-dias-input" class="scope-dias-input" value="${state.loadDias || 90}" min="1" max="365">
            <span>dias</span>
            <button type="button" id="scope-load-days" class="scope-days-load-btn">Carregar</button>
            <button type="button" id="scope-load-all" class="scope-load-btn">Ver tudo</button>
        </div>
        <div id="visits-list-container"></div>
    `;

    const filtersToggleButton = document.getElementById('visit-filters-toggle');
    const filtersPanel = document.getElementById('visit-filters-panel');
    const isMobileViewport = window.matchMedia('(max-width: 640px)').matches;

    const setFiltersCollapsed = (collapsed) => {
        if (!filtersPanel || !filtersToggleButton) {
            return;
        }

        filtersPanel.classList.toggle('collapsed', collapsed);
        filtersToggleButton.setAttribute('aria-expanded', String(!collapsed));
        filtersToggleButton.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    };

    setFiltersCollapsed(isMobileViewport);

    filtersToggleButton?.addEventListener('click', () => {
        setFiltersCollapsed(!filtersPanel.classList.contains('collapsed'));
    });

    const renderFilteredVisits = async () => {
        const dateFromCheck = document.getElementById('visit-filter-date-from')?.value || '';
        if (state.visitsScope !== 'all' && dateFromCheck) {
            const cutoff3m = new Date();
            cutoff3m.setMonth(cutoff3m.getMonth() - 3);
            if (new Date(dateFromCheck) < cutoff3m) {
                const listEl = document.getElementById('visits-list-container');
                if (listEl) listEl.innerHTML = `<div class="scope-loading">Carregando histórico completo...</div>`;
                try {
                    const r = await callAPI('getVisits', { user: state.currentUser, meses: 0 });
                    if (r.status === 'success') {
                        state.visits = r.visits || [];
                        state.visitsScope = 'all';
                        saveCache('visits_all', state.visits);
                        normalizedVisits = state.visits.map((v) => normalizeVisit(v)).sort((a, b) => compareVisitsByDateDesc(a, b));
                    }
                } catch(e) {}
            }
        }
        const searchValue     = String(document.getElementById('visit-filter-search')?.value || '').trim().toLowerCase();
        const typeValue       = document.getElementById('visit-filter-type')?.value || '';
        const cityValue       = document.getElementById('visit-filter-city')?.value || '';
        const prospectionValue = document.getElementById('visit-filter-prospeccao')?.value || '';
        const periodValue     = document.getElementById('visit-filter-period')?.value || '';
        const vendorValue     = document.getElementById('visit-filter-vendor')?.value || '';
        const dateFromValue   = document.getElementById('visit-filter-date-from')?.value || '';
        const dateToValue     = document.getElementById('visit-filter-date-to')?.value || '';
        const { start: periodStart, end: periodEnd } = getDateRangeForPeriod(periodValue);

        const filteredVisits = normalizedVisits.filter((visit) => {
            const matchesSearch = !searchValue || [visit.cliente, visit.contato, visit.observacao, visit.tipoVisita, visit.cidade, visit.vendedorGerente]
                .some((value) => String(value || '').toLowerCase().includes(searchValue));
            const matchesType   = !typeValue || visit.tipoVisita === typeValue;
            const matchesCity   = !cityValue || visit.cidade === cityValue;
            const matchesProspection = !prospectionValue || visit.prospeccao === prospectionValue;
            const matchesVendor = !vendorValue || visit.vendedorGerente === vendorValue;
            const visitDate     = parseDisplayDate(visit.dataVisita);
            const matchesPeriod = !periodStart || (visitDate && visitDate >= periodStart && visitDate <= periodEnd);
            const matchesDateFrom = !dateFromValue || (visitDate && visitDate >= parseInputDate(dateFromValue));
            const matchesDateTo   = !dateToValue   || (visitDate && visitDate <= parseInputDate(dateToValue));

            return matchesSearch && matchesType && matchesCity && matchesProspection && matchesVendor && matchesPeriod && matchesDateFrom && matchesDateTo;
        });

        const visitsListContainer = document.getElementById('visits-list-container');
        if (!visitsListContainer) {
            return;
        }

        if (filteredVisits.length === 0) {
            visitsListContainer.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhuma visita para os filtros selecionados.</p></div>`;
            return;
        }

        const visitsByMonth = groupVisitsByMonth(filteredVisits);
        visitsListContainer.innerHTML = Object.keys(visitsByMonth).sort((firstKey, secondKey) => secondKey.localeCompare(firstKey)).map((monthKey) => `
            <section class="visit-month-group">
                <div class="visit-month-header">
                    <h3>${escapeHtml(formatMonthKey(monthKey))}</h3>
                    <span>${escapeHtml(String(visitsByMonth[monthKey].length))} visita(s)</span>
                </div>
                <div class="visits-list">
                    ${visitsByMonth[monthKey].map((visit) => `
                        <div class="visit-card-wrap">
                            <button class="visit-card" type="button" data-visit-id="${escapeHtml(visit.id)}">
                                <div class="visit-card-header">
                                    <strong>${escapeHtml(visit.cliente || 'Cliente não informado')}</strong>
                                    <span class="visit-date">${visit._pending ? '<span class="pending-badge" title="Aguardando conexão para enviar">⏳ Pendente</span>' : escapeHtml(visit.dataVisita || '')}</span>
                                </div>
                                <div class="visit-card-body">
                                    <span class="${visitTypeClass(visit.tipoVisita)}">${escapeHtml(visit.tipoVisita || '-')}</span>
                                    <span>${escapeHtml(visit.cidade || '-')}</span>
                                    <span>${escapeHtml(visit.horario || '-')}</span>
                                    ${isAdmGer && visit.vendedorGerente ? `<span style="color:var(--primary);font-weight:600">${escapeHtml(visit.vendedorGerente)}</span>` : ''}
                                </div>
                            </button>
                            <button class="visit-share-btn" type="button" data-share-id="${escapeHtml(visit.id)}" title="Compartilhar" aria-label="Compartilhar visita">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                            </button>
                        </div>
                    `).join('')}
                </div>
            </section>
        `).join('');

        visitsListContainer.querySelectorAll('[data-visit-id]').forEach((button) => {
            button.addEventListener('click', () => navigateTo('visit-detail', { id: button.dataset.visitId }));
        });
        visitsListContainer.querySelectorAll('[data-share-id]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const v = (state.visits || []).map(normalizeVisit).find(x => String(x.id) === btn.dataset.shareId);
                if (v) shareVisit(v);
            });
        });
    };

    const _visitFilterIds = ['visit-filter-search', 'visit-filter-type', 'visit-filter-city', 'visit-filter-prospeccao',
        'visit-filter-period', 'visit-filter-vendor', 'visit-filter-date-from', 'visit-filter-date-to'];
    const _debouncedVisitFilter = debounce(renderFilteredVisits, 250);
    _visitFilterIds.forEach((id) => {
            const element = document.getElementById(id);
            if (!element) {
                return;
            }
            element.addEventListener(id === 'visit-filter-search' ? 'input' : 'change',
                id === 'visit-filter-search' ? _debouncedVisitFilter : renderFilteredVisits);
        });

    document.getElementById('visit-filters-clear')?.addEventListener('click', () => {
        _visitFilterIds.forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; } });
        renderFilteredVisits();
    });

    document.getElementById('visits-csv-btn')?.addEventListener('click', () => {
        downloadCSV(normalizedVisits, 'visitas.csv', [
            { key: 'dataVisita', label: 'Data' },
            { key: 'cliente', label: 'Cliente' },
            { key: 'tipoVisita', label: 'Tipo' },
            { key: 'cidade', label: 'Cidade' },
            { key: 'vendedorGerente', label: 'Vendedor' },
            { key: 'observacao', label: 'Observação' }
        ]);
    });

    document.getElementById('scope-load-days')?.addEventListener('click', () => {
        const v = parseInt(document.getElementById('scope-dias-input')?.value, 10);
        if (v > 0) { state.loadDias = v; saveCache('visits', null); navigateTo('visits'); }
    });

    document.getElementById('scope-load-all')?.addEventListener('click', async () => {
        const listEl = document.getElementById('visits-list-container');
        if (listEl) listEl.innerHTML = `<div class="scope-loading">Carregando histórico completo...</div>`;
        try {
            const r = await callAPI('getVisits', { user: state.currentUser, meses: 0 });
            if (r.status === 'success') {
                state.visits = r.visits || [];
                state.visitsScope = 'all';
                saveCache('visits_all', state.visits);
                normalizedVisits = state.visits.map((v) => normalizeVisit(v)).sort((a, b) => compareVisitsByDateDesc(a, b));
                document.querySelector('.scope-banner')?.remove();
                rebuildFilterOptions('#visit-filter-type', Array.from(new Set(normalizedVisits.map((v) => v.tipoVisita).filter(Boolean))).sort());
                rebuildFilterOptions('#visit-filter-city', Array.from(new Set(normalizedVisits.map((v) => v.cidade).filter(Boolean))).sort());
                if (isAdmGer) rebuildFilterOptions('#visit-filter-vendor', Array.from(new Set(normalizedVisits.map((v) => v.vendedorGerente).filter(Boolean))).sort());
                renderFilteredVisits();
            }
        } catch(e) {}
    });

    renderFilteredVisits();
}


export async function renderVisitsPage() {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    const cachedAll = loadCache('visits_all');
    const cached3m  = loadCache('visits');
    const cachedVisits = cachedAll || cached3m;
    mainContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Visitas</h2>
                <p class="page-subtitle">Historico e registro de visitas</p>
            </div>
            <button class="btn-add" id="btn-new-visit" type="button">+ Nova Visita</button>
        </div>
        <div id="visits-content">${cachedVisits ? '' : loadingState('📋', 'Carregando suas visitas...')}</div>
    `;
    document.getElementById('btn-new-visit').addEventListener('click', () => navigateTo('visit-new'));

    if (cachedVisits) {
        state.visitsScope = cachedAll ? 'all' : '3m';
        state.visits = cachedVisits;
        const visitsContent = document.getElementById('visits-content');
        if (visitsContent) { fillVisitsContent(visitsContent, state.visits); }
        addFabAndScrollTop('Nova Visita', () => navigateTo('visit-new'));
        initPullToRefresh(() => { saveCache('visits', null); saveCache('visits_all', null); navigateTo('visits'); });
        getVisits(cachedAll ? 0 : 3);
        return;
    }

    const result = await getVisits();
    state.visitsScope = result.scope || 'all';
    const visitsContent = document.getElementById('visits-content');
    if (!visitsContent) { return; }
    if (!result || result.status !== 'success') {
        visitsContent.innerHTML = `<p class="error-message">Erro ao carregar visitas: ${escapeHtml(result ? result.message : 'Falha na conexão.')}</p>`;
        return;
    }
    state.visits = result.visits || [];
    fillVisitsContent(visitsContent, state.visits);
    addFabAndScrollTop('Nova Visita', () => navigateTo('visit-new'));
    initPullToRefresh(() => { saveCache('visits', null); saveCache('visits_all', null); navigateTo('visits'); });
}


export async function renderCalendarPage() {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = skeletonList(5);

    if (!state.visits || state.visits.length === 0) {
        const r = await getVisits();
        if (r.status === 'success') { state.visits = r.visits || []; }
    }
    if (!state.proposals || state.proposals.length === 0) {
        const r = await getProposals();
        if (r.status === 'success') { state.proposals = r.proposals || []; }
    }
    if (!state.funil || state.funil.length === 0) {
        const r = await getFunil();
        if (r.status === 'success') { state.funil = r.funil || []; }
    }

    const visits    = state.visits.map(normalizeVisit);
    const proposals = (state.proposals || []).map(normalizeProposal);
    const funil     = (state.funil || []);

    const VISIT_COLORS = [
        '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
        '#06b6d4','#f97316','#84cc16','#ec4899','#6366f1'
    ];
    const typeColorMap = {};
    const types = Array.from(new Set(visits.map((v) => v.tipoVisita).filter(Boolean)));
    types.forEach((t, i) => { typeColorMap[t] = VISIT_COLORS[i % VISIT_COLORS.length]; });

    const PROPOSAL_COLOR = '#0ea5e9';
    const FUNIL_COLOR    = '#22c55e';

    let viewYear  = new Date().getFullYear();
    let viewMonth = new Date().getMonth();

    const render = () => {
        const firstDay  = new Date(viewYear, viewMonth, 1);
        const lastDay   = new Date(viewYear, viewMonth + 1, 0);
        const startDow  = firstDay.getDay();
        const monthName = firstDay.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

        const visitsByDay    = {};
        const proposalsByDay = {};
        const funilByDay     = {};

        visits.forEach((v) => {
            const d = parseDisplayDate(v.dataVisita);
            if (!d || d.getFullYear() !== viewYear || d.getMonth() !== viewMonth) { return; }
            const key = d.getDate();
            if (!visitsByDay[key]) { visitsByDay[key] = []; }
            visitsByDay[key].push(v);
        });
        proposals.forEach((p) => {
            const d = parseDisplayDate(p.data || p.atualizacao);
            if (!d || d.getFullYear() !== viewYear || d.getMonth() !== viewMonth) { return; }
            const key = d.getDate();
            if (!proposalsByDay[key]) { proposalsByDay[key] = []; }
            proposalsByDay[key].push(p);
        });
        funil.forEach((f) => {
            const d = parseDisplayDate(f.data || f.atualizacao);
            if (!d || d.getFullYear() !== viewYear || d.getMonth() !== viewMonth) { return; }
            const key = d.getDate();
            if (!funilByDay[key]) { funilByDay[key] = []; }
            funilByDay[key].push(f);
        });

        const todayStr = new Date().toDateString();
        const cells = [];
        for (let i = 0; i < startDow; i++) { cells.push(`<div class="cal-cell cal-cell-empty"></div>`); }
        for (let d = 1; d <= lastDay.getDate(); d++) {
            const dayVisits    = visitsByDay[d]    || [];
            const dayProposals = proposalsByDay[d] || [];
            const dayFunil     = funilByDay[d]     || [];
            const hasAny = dayVisits.length || dayProposals.length || dayFunil.length;
            const isToday = new Date(viewYear, viewMonth, d).toDateString() === todayStr;

            const allDots = [
                ...dayVisits.slice(0, 2).map((v) => `<span class="cal-dot" style="background:${typeColorMap[v.tipoVisita] || '#3b82f6'}" title="Visita: ${escapeHtml(v.cliente)}"></span>`),
                ...dayProposals.slice(0, 1).map(() => `<span class="cal-dot" style="background:${PROPOSAL_COLOR}" title="Proposta"></span>`),
                ...dayFunil.slice(0, 1).map(() => `<span class="cal-dot" style="background:${FUNIL_COLOR}" title="Funil"></span>`)
            ];
            const totalExtra = dayVisits.length + dayProposals.length + dayFunil.length - allDots.length;
            const more = totalExtra > 0 ? `<span class="cal-more">+${totalExtra}</span>` : '';

            cells.push(`
                <button type="button" class="cal-cell ${isToday ? 'cal-today' : ''} ${hasAny ? 'cal-has-visits' : ''}" data-day="${d}">
                    <span class="cal-day-num">${d}</span>
                    <div class="cal-dots">${allDots.join('')}${more}</div>
                </button>`);
        }

        const legendHtml = [
            ...types.map((t) => `<span class="cal-legend-item"><span class="cal-legend-dot" style="background:${typeColorMap[t]}"></span>${escapeHtml(t)}</span>`),
            `<span class="cal-legend-item"><span class="cal-legend-dot" style="background:${PROPOSAL_COLOR}"></span>Proposta</span>`,
            `<span class="cal-legend-item"><span class="cal-legend-dot" style="background:${FUNIL_COLOR}"></span>Funil</span>`
        ].join('');

        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Agenda</h2><p class="page-subtitle">Visitas, Propostas e Funil</p></div>
                <button type="button" class="btn-add" id="cal-new-visit">+ Visita</button>
            </div>
            <div class="card cal-card">
                <div class="cal-nav">
                    <button type="button" class="mini-button" id="cal-prev">&#8592;</button>
                    <strong class="cal-month-title">${escapeHtml(monthName.charAt(0).toUpperCase() + monthName.slice(1))}</strong>
                    <button type="button" class="mini-button" id="cal-next">&#8594;</button>
                </div>
                <div class="cal-grid">
                    <div class="cal-header-cell">Dom</div>
                    <div class="cal-header-cell">Seg</div>
                    <div class="cal-header-cell">Ter</div>
                    <div class="cal-header-cell">Qua</div>
                    <div class="cal-header-cell">Qui</div>
                    <div class="cal-header-cell">Sex</div>
                    <div class="cal-header-cell">Sab</div>
                    ${cells.join('')}
                </div>
                <div class="cal-legend">${legendHtml}</div>
            </div>
            <div id="cal-day-panel"></div>
        `;

        document.getElementById('cal-prev').addEventListener('click', () => {
            viewMonth--;
            if (viewMonth < 0) { viewMonth = 11; viewYear--; }
            render();
        });
        document.getElementById('cal-next').addEventListener('click', () => {
            viewMonth++;
            if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            render();
        });
        document.getElementById('cal-new-visit')?.addEventListener('click', () => navigateTo('visit-new'));

        mainContent.querySelectorAll('[data-day]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const day = Number(btn.dataset.day);
                const dayVisits    = visitsByDay[day]    || [];
                const dayProposals = proposalsByDay[day] || [];
                const dayFunil     = funilByDay[day]     || [];
                const panel = document.getElementById('cal-day-panel');
                if (!panel) { return; }
                if (!dayVisits.length && !dayProposals.length && !dayFunil.length) {
                    panel.innerHTML = `<p class="helper-text" style="text-align:center;padding:1rem">Sem registros neste dia.</p>`;
                    return;
                }
                const dateLabel = new Date(viewYear, viewMonth, day).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
                const total = dayVisits.length + dayProposals.length + dayFunil.length;
                panel.innerHTML = `
                    <div class="visit-month-header" style="margin-top:1rem">
                        <h3>${escapeHtml(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1))}</h3>
                        <span>${total} registro(s)</span>
                    </div>
                    <div class="visits-list">
                        ${dayVisits.map((v) => `
                        <button type="button" class="visit-card" data-visit-id="${escapeHtml(v.id)}" style="border-left:4px solid ${typeColorMap[v.tipoVisita] || '#3b82f6'}">
                            <div class="visit-card-header">
                                <strong>${escapeHtml(v.cliente || '-')}</strong>
                                <span class="visit-date">${escapeHtml(v.horario || '')}</span>
                            </div>
                            <div class="visit-card-body">
                                <span class="tag" style="background:${typeColorMap[v.tipoVisita] || '#3b82f6'}20;color:${typeColorMap[v.tipoVisita] || '#2563eb'}">${escapeHtml(v.tipoVisita || 'Visita')}</span>
                                <span>${escapeHtml(v.cidade || '-')}</span>
                            </div>
                        </button>`).join('')}
                        ${dayProposals.map((p) => `
                        <button type="button" class="visit-card" data-proposal-id="${escapeHtml(p.id)}" style="border-left:4px solid ${PROPOSAL_COLOR}">
                            <div class="visit-card-header">
                                <strong>${escapeHtml(p.cliente || '-')}</strong>
                                <span class="visit-date">${escapeHtml(p.data || '-')}</span>
                            </div>
                            <div class="visit-card-body">
                                <span class="tag" style="background:${PROPOSAL_COLOR}20;color:${PROPOSAL_COLOR}">Proposta</span>
                                ${p.foco ? `<span>${escapeHtml(p.foco)}</span>` : ''}
                                <span class="status-pill">${escapeHtml(p.status || '-')}</span>
                            </div>
                        </button>`).join('')}
                        ${dayFunil.map((f) => `
                        <button type="button" class="visit-card" data-funil-id="${escapeHtml(f.id)}" style="border-left:4px solid ${FUNIL_COLOR}">
                            <div class="visit-card-header">
                                <strong>${escapeHtml(f.cliente || '-')}</strong>
                                <span class="visit-date">${escapeHtml(f.data || '-')}</span>
                            </div>
                            <div class="visit-card-body">
                                <span class="tag" style="background:${FUNIL_COLOR}20;color:#16a34a">Funil</span>
                                ${f.foco ? `<span>${escapeHtml(f.foco)}</span>` : ''}
                                <span class="status-pill">${escapeHtml(f.status || '-')}</span>
                            </div>
                        </button>`).join('')}
                    </div>
                `;
                panel.querySelectorAll('[data-visit-id]').forEach((b) => {
                    b.addEventListener('click', () => navigateTo('visit-detail', { id: b.dataset.visitId }));
                });
                panel.querySelectorAll('[data-proposal-id]').forEach((b) => {
                    b.addEventListener('click', () => navigateTo('proposal-detail', { id: b.dataset.proposalId }));
                });
                panel.querySelectorAll('[data-funil-id]').forEach((b) => {
                    b.addEventListener('click', () => navigateTo('funil-detail', { id: b.dataset.funilId }));
                });
            });
        });

        if (visitsByDay[new Date().getDate()] && viewYear === new Date().getFullYear() && viewMonth === new Date().getMonth()) {
            mainContent.querySelector(`[data-day="${new Date().getDate()}"]`)?.click();
        }
    };

    render();
}


export async function renderVisitFormPage(visit = null) {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    const isEdit = Boolean(visit && (visit.ID || visit.id));
    const normalizedVisit = visit ? normalizeVisit(visit) : null;

    if (!state.formData) {
        mainContent.innerHTML = `
            <div class="page-header compact-header">
                <button type="button" class="mini-button" id="back-to-visits-overlay">Voltar</button>
                <h2>${isEdit ? 'Editar Visita' : 'Nova Visita'}</h2>
            </div>
            <div class="card form-card" style="position:relative;min-height:200px;">
                <div class="form-loading-overlay">
                    <div class="form-loading-spinner"></div>
                    <span>Carregando formulario...</span>
                </div>
            </div>
        `;
        document.getElementById('back-to-visits-overlay')?.addEventListener('click', () => navigateTo('visits'));
    }

    const formDataResult = await ensureFormData();
    if (formDataResult.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(formDataResult.message || 'Nao foi possivel carregar o formulario.')}</p>`;
        return;
    }

    const formData = state.formData;
    const now = new Date();
    const currentProspection = normalizedVisit ? normalizedVisit.prospeccao : 'Sim';
    const currentClient = normalizedVisit ? normalizedVisit.cliente : '';

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-to-visits">Voltar</button>
            <h2>${isEdit ? 'Editar Visita' : 'Nova Visita'}</h2>
        </div>
        <form id="visit-form" class="card form-card form-layout visit-form-layout">
            <input type="hidden" id="visit-id" value="${escapeHtml(normalizedVisit ? normalizedVisit.id : '')}">
            <div class="form-group full-width">
                <label>Prospecção</label>
                <div class="radio-group" id="prospeccao-group">
                    <label class="radio-pill">
                        <input type="radio" name="prospeccao" value="Sim" ${currentProspection === 'Sim' ? 'checked' : ''}>
                        <span>Sim</span>
                    </label>
                    <label class="radio-pill">
                        <input type="radio" name="prospeccao" value="Nao" ${currentProspection === 'Nao' ? 'checked' : ''}>
                        <span>Não</span>
                    </label>
                </div>
            </div>

            <div class="form-group client-select-group">
                <label for="cliente-existente">Cliente cadastrado</label>
                <div class="searchable-select">
                    <input
                        type="text"
                        id="cliente-existente"
                        placeholder="Pesquise um cliente"
                        value="${escapeHtml(currentProspection === 'Nao' ? currentClient : '')}"
                        autocomplete="off"
                    >
                    <div class="searchable-select-menu" id="cliente-existente-menu"></div>
                </div>
            </div>

            <div class="form-group readonly-group full-width">
                <label for="vendedor-gerente">Vendedor / Gerente</label>
                <input type="text" id="vendedor-gerente" value="${escapeHtml(state.currentUser.name || '')}" readonly>
            </div>
            <div class="form-row-pair full-width">
                <div class="form-group">
                    <label for="data-visita">Data da Visita</label>
                    <div class="date-input-group">
                        <input type="text" id="data-visita" value="${escapeHtml(normalizedVisit ? normalizedVisit.dataVisita : formatDateForDisplay(now))}" placeholder="dd/mm/aaaa" inputmode="numeric" maxlength="10" required>
                        <button type="button" class="date-picker-button" id="open-date-picker" aria-label="Abrir calendario">📅</button>
                        <div class="picker-menu" id="data-visita-menu">
                            <input type="date" id="data-visita-picker" class="picker-native-input" value="${escapeHtml(normalizedVisit ? (normalizedVisit.dataVisitaInput || formatInputDateFromDisplay(normalizedVisit.dataVisita)) : formatDateForInput(now))}">
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="horario">Horário</label>
                    <div class="date-input-group">
                        <input type="text" id="horario" value="${escapeHtml(normalizedVisit ? normalizedVisit.horario : formatTimeForInput(now))}" placeholder="hh:mm" inputmode="numeric" maxlength="5" required>
                        <button type="button" class="date-picker-button" id="open-time-picker" aria-label="Abrir horario">🕒</button>
                        <div class="picker-menu" id="horario-menu">
                            <input type="time" id="horario-picker" class="picker-native-input" value="${escapeHtml(normalizedVisit ? normalizedVisit.horario : formatTimeForInput(now))}">
                        </div>
                    </div>
                </div>
            </div>
            <div class="form-row-pair full-width">
                <div class="form-group" id="cliente-group">
                    <label for="cliente">Cliente</label>
                    <input type="text" id="cliente" value="${escapeHtml(currentClient)}" required>
                </div>
                <div class="form-group">
                    <label for="contato">Contato</label>
                    <input type="text" id="contato" value="${escapeHtml(normalizedVisit ? normalizedVisit.contato : '')}">
                </div>
            </div>
            <div class="form-group">
                <label for="cidade">Cidade</label>
                <div class="searchable-select">
                    <input type="text" id="cidade" value="${escapeHtml(normalizedVisit ? normalizedVisit.cidade : '')}" placeholder="Pesquise a cidade" required autocomplete="off">
                    <div class="searchable-select-menu" id="cidade-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="area-atuacao">Área de Atuação</label>
                <div class="searchable-select">
                    <input type="text" id="area-atuacao" value="${escapeHtml(normalizedVisit ? normalizedVisit.areaAtuacao : '')}" placeholder="Pesquise a area" required autocomplete="off">
                    <div class="searchable-select-menu" id="area-atuacao-menu"></div>
                </div>
            </div>
            <div class="form-group potential-field-group">
                <label for="potencial-cliente">Potencial do Cliente</label>
                <div class="searchable-select">
                    <input type="text" id="potencial-cliente" value="${escapeHtml(normalizedVisit ? normalizedVisit.potencialCliente : '')}" placeholder="Pesquise o potencial" autocomplete="off">
                    <div class="searchable-select-menu" id="potencial-cliente-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="tipo-visita">Tipo da Visita${isEdit ? '' : ' (ate 3)'}</label>
                <div class="searchable-select${isEdit ? '' : ' multi-select'}">
                    <input type="text" id="tipo-visita" value="${escapeHtml(normalizedVisit ? normalizedVisit.tipoVisita : '')}" placeholder="${isEdit ? 'Pesquise o tipo da visita' : 'Pesquise e selecione ate 3 tipos'}" ${isEdit ? 'required' : ''} autocomplete="off">
                    <div class="searchable-select-menu" id="tipo-visita-menu"></div>
                </div>
                ${isEdit ? '' : '<div class="selected-types" id="selected-visit-types"></div>'}
                ${isEdit ? '' : '<p class="field-helper-text">Cada tipo selecionado cria uma visita separada com os mesmos dados.</p>'}
            </div>
            <div class="form-group full-width">
                <label>Qual o Veículo?</label>
                <div class="radio-group" id="veiculo-group">
                    ${renderVehicleOptions(normalizedVisit ? normalizedVisit.veiculo : 'Particular')}
                </div>
            </div>
            <div class="form-group full-width">
                <div class="obs-label-row">
                    <label for="observacao">Observação</label>
                    <button type="button" id="obs-dictate-btn" class="obs-dictate-btn" style="display:none" aria-label="Ditar observação por voz">🎤 Ditar</button>
                </div>
                <textarea id="observacao" rows="4" maxlength="1000" placeholder="Digite detalhes relevantes da visita">${escapeHtml(normalizedVisit ? normalizedVisit.observacao : '')}</textarea>
                <div class="obs-char-counter" id="obs-char-counter">0/500</div>
            </div>
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-visit">Cancelar</button>
                <button type="submit" id="save-visit">${isEdit ? 'Salvar Alterações' : 'Salvar Visita'}</button>
            </div>
        </form>
    `;

    document.getElementById('back-to-visits').addEventListener('click', () => navigateTo('visits'));
    document.getElementById('cancel-visit').addEventListener('click', () => navigateTo(isEdit ? 'visit-detail' : 'visits', isEdit ? { id: normalizedVisit.id } : {}));

    const prospeccaoSelect = { get value() { return document.querySelector('input[name="prospeccao"]:checked')?.value || 'Sim'; } };
    const clienteSelect = document.getElementById('cliente-existente');
    const clienteInput = document.getElementById('cliente');
    const contatoInput = document.getElementById('contato');
    const dataVisitaInput = document.getElementById('data-visita');
    const dataVisitaPicker = document.getElementById('data-visita-picker');
    const openDatePickerButton = document.getElementById('open-date-picker');
    const dataVisitaMenu = document.getElementById('data-visita-menu');
    const horarioInput = document.getElementById('horario');
    const horarioPicker = document.getElementById('horario-picker');
    const openTimePickerButton = document.getElementById('open-time-picker');
    const horarioMenu = document.getElementById('horario-menu');
    const cidadeSelect = document.getElementById('cidade');
    const areaSelect = document.getElementById('area-atuacao');
    const potencialSelect = document.getElementById('potencial-cliente');
    const tipoVisitaInput = document.getElementById('tipo-visita');
    const potentialFieldGroup = document.querySelector('.potential-field-group');
    const selectedTypesContainer = document.getElementById('selected-visit-types');
    const selectedVisitTypes = isEdit && normalizedVisit && normalizedVisit.tipoVisita ? [normalizedVisit.tipoVisita] : [];

    initializeSearchableInput({
        input: clienteSelect,
        menu: document.getElementById('cliente-existente-menu'),
        items: formData.clientes.map((client) => client.nome),
        onSelect: (value) => fillClientData(value)
    });
    initializeSearchableInput({
        input: cidadeSelect,
        menu: document.getElementById('cidade-menu'),
        items: formData.cidades
    });
    initializeSearchableInput({
        input: areaSelect,
        menu: document.getElementById('area-atuacao-menu'),
        items: formData.areasAtuacao
    });
    initializeSearchableInput({
        input: potencialSelect,
        menu: document.getElementById('potencial-cliente-menu'),
        items: formData.potenciaisCliente
    });
    initializeSearchableInput({
        input: tipoVisitaInput,
        menu: document.getElementById('tipo-visita-menu'),
        items: formData.tiposVisita.map((item) => item.tipo),
        multiSelect: !isEdit,
        maxSelections: 3,
        selectedItems: selectedVisitTypes,
        selectedContainer: selectedTypesContainer,
        selectionLabel: 'tipo',
        onSelectionChange: (items) => {
            tipoVisitaInput.value = isEdit ? (items[0] || '') : '';
        }
    });

    const syncProspectionMode = () => {
        const isProspection = prospeccaoSelect.value === 'Sim';
        document.querySelector('.client-select-group').style.display = isProspection ? 'none' : 'block';
        const clienteGroup = document.getElementById('cliente-group');
        if (clienteGroup) { clienteGroup.style.display = isProspection ? '' : 'none'; }
        clienteInput.readOnly = !isProspection;
        cidadeSelect.disabled = !isProspection;
        areaSelect.disabled = !isProspection;
        potencialSelect.disabled = !isProspection;
        potencialSelect.required = isProspection;
        if (potentialFieldGroup) {
            potentialFieldGroup.style.display = isProspection ? 'block' : 'none';
        }

        if (!isProspection) {
            potencialSelect.value = '';
        }

        if (!isProspection && clienteSelect.value) {
            fillClientData(clienteSelect.value);
        }
    };

    const fillClientData = (clientName) => {
        const normalizedName = String(clientName || '').trim().toLowerCase();
        const client = state.formData.clientes.find((item) => String(item.nome || '').trim().toLowerCase() === normalizedName);
        if (!client) {
            contatoInput.disabled = false;
            return;
        }
        clienteInput.value = client.nome || '';
        if (client.contato) {
            contatoInput.value = client.contato;
            contatoInput.disabled = false;
            contatoInput.classList.add('autofilled');
            setTimeout(() => contatoInput.classList.remove('autofilled'), 1500);
        } else {
            contatoInput.disabled = false;
        }
        cidadeSelect.value = client.cidade || '';
        areaSelect.value = client.areaAtuacao || '';
        if (prospeccaoSelect.value === 'Sim') {
            potencialSelect.value = client.potencialCliente || '';
        }
    };

    // Track dirty state so navigateTo can warn before abandoning
    document.getElementById('visit-form').addEventListener('input', () => { state.formDirty = true; });
    document.getElementById('visit-form').addEventListener('change', () => { state.formDirty = true; });

    initObservacaoField();

    document.querySelectorAll('input[name="prospeccao"]').forEach((radio) => radio.addEventListener('change', syncProspectionMode));
    clienteSelect.addEventListener('change', () => fillClientData(clienteSelect.value));
    clienteSelect.addEventListener('input', () => fillClientData(clienteSelect.value));
    clienteInput.addEventListener('blur', () => {
        if (prospeccaoSelect.value === 'Sim' && !clienteInput.value.trim()) {
            showFieldError(clienteInput, 'Informe o nome do cliente.');
        } else {
            clearFieldError(clienteInput);
        }
    });
    clienteInput.addEventListener('input', () => clearFieldError(clienteInput));
    dataVisitaInput.addEventListener('input', () => {
        dataVisitaInput.value = formatDateFieldValue(dataVisitaInput.value);
    });
    dataVisitaInput.addEventListener('blur', () => {
        const normalizedDate = normalizeDisplayDateValue(dataVisitaInput.value);
        if (normalizedDate) {
            dataVisitaInput.value = normalizedDate;
            dataVisitaPicker.value = formatInputDateFromDisplay(normalizedDate);
            clearFieldError(dataVisitaInput);
        } else if (dataVisitaInput.value.trim()) {
            showFieldError(dataVisitaInput, 'Data inválida. Use dd/mm/aaaa.');
        }
    });
    const closePickerMenus = () => {
        dataVisitaMenu.classList.remove('visible');
        horarioMenu.classList.remove('visible');
    };

    openDatePickerButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const shouldOpen = !dataVisitaMenu.classList.contains('visible');
        closePickerMenus();
        if (shouldOpen) {
            dataVisitaMenu.classList.add('visible');
            dataVisitaPicker.focus();
        }
    });
    dataVisitaPicker.addEventListener('change', () => {
        if (!dataVisitaPicker.value) {
            return;
        }
        const selectedDate = new Date(`${dataVisitaPicker.value}T00:00:00`);
        if (!Number.isNaN(selectedDate.getTime())) {
            dataVisitaInput.value = formatDateForDisplay(selectedDate);
            dataVisitaMenu.classList.remove('visible');
        }
    });
    horarioInput.addEventListener('input', () => {
        horarioInput.value = formatTimeFieldValue(horarioInput.value);
    });
    horarioInput.addEventListener('blur', () => {
        const normalizedTime = normalizeTimeValue(horarioInput.value);
        if (normalizedTime) {
            horarioInput.value = normalizedTime;
            horarioPicker.value = normalizedTime;
            clearFieldError(horarioInput);
        } else if (horarioInput.value.trim()) {
            showFieldError(horarioInput, 'Horário inválido. Use hh:mm.');
        }
    });
    openTimePickerButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const shouldOpen = !horarioMenu.classList.contains('visible');
        closePickerMenus();
        if (shouldOpen) {
            horarioMenu.classList.add('visible');
            horarioPicker.focus();
        }
    });
    horarioPicker.addEventListener('change', () => {
        if (!horarioPicker.value) {
            return;
        }
        horarioInput.value = horarioPicker.value;
        horarioMenu.classList.remove('visible');
    });
    addDocumentClickListener((event) => {
        if (!dataVisitaMenu.contains(event.target) && event.target !== openDatePickerButton) {
            dataVisitaMenu.classList.remove('visible');
        }
        if (!horarioMenu.contains(event.target) && event.target !== openTimePickerButton) {
            horarioMenu.classList.remove('visible');
        }
    });
    syncProspectionMode();

    if (!isEdit) {
        const draftKey = 'apv_draft_visit_' + (state.currentUser && state.currentUser.email || '');
        const savedDraft = (() => { try { return JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch(e) { return null; } })();
        if (savedDraft) {
            if (savedDraft.cliente) clienteInput.value = savedDraft.cliente;
            if (savedDraft.observacao) document.getElementById('observacao').value = savedDraft.observacao;
        }
        const saveDraft = debounce(function() {
            try {
                localStorage.setItem(draftKey, JSON.stringify({
                    cliente: clienteInput.value,
                    observacao: document.getElementById('observacao')?.value || ''
                }));
            } catch(e) {}
        }, 800);
        document.getElementById('visit-form').addEventListener('input', saveDraft);
        document.getElementById('visit-form')._draftKey = draftKey;
    }

    document.getElementById('visit-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const saveButton = document.getElementById('save-visit');
        saveButton.disabled = true;
        saveButton.textContent = isEdit ? 'Salvando...' : 'Criando...';

        const normalizedVisitDate = normalizeDisplayDateValue(dataVisitaInput.value);
        if (!normalizedVisitDate) {
            showToast('Informe a data no formato dd/mm/aaaa.', true);
            saveButton.disabled = false;
            saveButton.textContent = isEdit ? 'Salvar Alterações' : 'Salvar Visita';
            dataVisitaInput.focus();
            return;
        }

        const normalizedHorario = normalizeTimeValue(horarioInput.value);
        if (!normalizedHorario) {
            showToast('Informe o horário no formato hh:mm.', true);
            saveButton.disabled = false;
            saveButton.textContent = isEdit ? 'Salvar Alterações' : 'Salvar Visita';
            horarioInput.focus();
            return;
        }

        const payload = {
            id: document.getElementById('visit-id').value,
            prospeccao: prospeccaoSelect.value,
            vendedorGerente: state.currentUser.name,
            gerencia: state.currentUser.gerencia,
            dataVisita: normalizedVisitDate,
            horario: normalizedHorario,
            cliente: clienteInput.value.trim(),
            contato: contatoInput.value.trim(),
            cidade: cidadeSelect.value,
            areaAtuacao: areaSelect.value,
            potencialCliente: prospeccaoSelect.value === 'Sim' ? potencialSelect.value : '',
            tipoVisita: isEdit ? tipoVisitaInput.value : '',
            tiposVisita: isEdit ? [tipoVisitaInput.value].filter(Boolean) : selectedVisitTypes.slice(),
            veiculo: document.querySelector('input[name="veiculo"]:checked')?.value || 'Particular',
            observacao: document.getElementById('observacao').value.trim(),
            clienteId: (() => {
                const selectedClient = state.formData.clientes.find((item) => String(item.nome || '').trim().toLowerCase() === String(clienteSelect.value || '').trim().toLowerCase());
                return selectedClient ? selectedClient.id : '';
            })(),
            user: state.currentUser
        };

        if (!isEdit && payload.tiposVisita.length === 0) {
            showToast('Selecione pelo menos um tipo de visita.', true);
            saveButton.disabled = false;
            saveButton.textContent = 'Salvar Visita';
            tipoVisitaInput.focus();
            return;
        }

        if (isEdit && !payload.tipoVisita) {
            showToast('Selecione um tipo de visita.', true);
            saveButton.disabled = false;
            saveButton.textContent = 'Salvar Alterações';
            tipoVisitaInput.focus();
            return;
        }

        if (isEdit) {
            const idx = state.visits.findIndex(v => String(v.id) === String(payload.id));
            const original = idx >= 0 ? { ...state.visits[idx] } : null;
            const updatedVisit = normalizeVisit({
                ID: payload.id,
                'Prospecção': payload.prospeccao,
                'Vendedor/Gerente': payload.vendedorGerente,
                'Data da Visita': payload.dataVisita,
                'Horário': payload.horario,
                'Cliente': payload.cliente,
                'Contato': payload.contato,
                'Cidade': payload.cidade,
                'Área de Atuação': payload.areaAtuacao,
                'Potencial do Cliente': payload.potencialCliente,
                'Tipo da Visita': payload.tipoVisita,
                'Gerência': payload.gerencia,
                'Qual o Veículo?': payload.veiculo,
                'Observação': payload.observacao
            });
            if (idx >= 0) { state.visits[idx] = updatedVisit; saveCache('visits', state.visits); }
            state.currentVisit = updatedVisit;

            const waConfigEdit = getWhatsappConfigForVisit(payload.tipoVisita);
            if (waConfigEdit && waConfigEdit.obrigatorio) {
                await showMandatoryWhatsappModal(waConfigEdit, updatedVisit);
            }

            state.formDirty = false;
            showToast('Visita atualizada com sucesso.');
            navigateTo('visit-detail', { id: payload.id });

            attemptOrQueue('updateVisit', payload, { entity: 'visits', tempId: payload.id })
                .then(res => {
                    if (res && res.status === 'success') {
                        const real = normalizeVisit(res.visit || payload);
                        state.visits = state.visits.map(v => String(v.id) === String(payload.id) ? real : v);
                        saveCache('visits', state.visits);
                    } else if (res && res.status === 'queued') {
                        const pendingVisit = { ...updatedVisit, _pending: true };
                        state.visits = state.visits.map(v => String(v.id) === String(payload.id) ? pendingVisit : v);
                        saveCache('visits', state.visits);
                        showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                    } else {
                        if (idx >= 0 && original) { state.visits[idx] = original; saveCache('visits', state.visits); }
                        showToast((res && res.message) || 'Erro ao salvar. Tente novamente.', true);
                    }
                })
                .catch(() => {
                    if (idx >= 0 && original) { state.visits[idx] = original; saveCache('visits', state.visits); }
                    showToast('Erro ao salvar. Tente novamente.', true);
                });

            saveButton.disabled = false;
            saveButton.textContent = 'Salvar Alterações';
            return;
        }

        // Detecção de duplicata: mesmo cliente na mesma semana
        if (payload.cliente) {
            const _vDate = parseDisplayDate(payload.dataVisita);
            if (_vDate) {
                const _wkStart = new Date(_vDate.getTime());
                _wkStart.setDate(_wkStart.getDate() - _wkStart.getDay());
                _wkStart.setHours(0,0,0,0);
                const _wkEnd = new Date(_wkStart.getTime() + 7 * 86400000);
                const _dupe = state.visits.find(v => {
                    const n = normalizeVisit(v);
                    const d = parseDisplayDate(n.dataVisita);
                    return d && d >= _wkStart && d < _wkEnd &&
                        n.cliente.trim().toLowerCase() === payload.cliente.trim().toLowerCase();
                });
                if (_dupe) {
                    const _dupeDate = normalizeVisit(_dupe).dataVisita;
                    if (!confirm(`Já existe uma visita para "${payload.cliente}" nesta semana (${_dupeDate}). Registrar mesmo assim?`)) {
                        saveButton.disabled = false;
                        saveButton.textContent = 'Salvar Visita';
                        return;
                    }
                }
            }
        }

        // CREATE — createVisit já faz insert otimístico em state.visits
        const result = await createVisit(payload);
        if (result && (result.status === 'success' || result.status === 'queued')) {
            const createdVisits = Array.isArray(result.visits) ? result.visits.map(v => normalizeVisit(v)) : [];
            state.currentVisit = normalizeVisit(result.visit || createdVisits[0] || payload);
            const tipoAtual = (payload.tiposVisita || [])[0];
            const waConfig = getWhatsappConfigForVisit(tipoAtual);
            if (waConfig && waConfig.obrigatorio) {
                await showMandatoryWhatsappModal(waConfig, state.currentVisit);
            }
            state.formDirty = false;
            const _dk = document.getElementById('visit-form')?._draftKey;
            if (_dk) { try { localStorage.removeItem(_dk); } catch(e) {} }
            if (result.status === 'queued') {
                showToast('Sem conexão — a visita foi salva no aparelho e será enviada quando a conexão voltar.');
            } else {
                const _visitMsg = createdVisits.length > 1 ? `${createdVisits.length} visitas criadas` : 'Visita criada com sucesso';
                showToast(_visitMsg, false, () => navigateTo('visit-new'));
                // Renomear botão "Desfazer" para "Nova Visita"
                const _toastBtn = document.getElementById('app-toast')?.querySelector('.toast-undo-btn');
                if (_toastBtn) _toastBtn.textContent = '+ Nova Visita';
            }
            await navigateTo('visits');
        } else {
            showToast((result && result.message) || 'Não foi possível salvar a visita.', true);
        }

        saveButton.disabled = false;
        saveButton.textContent = 'Salvar Visita';
    });
}


export async function renderVisitDetailPage(id) {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    if (!state.visits.find(v => String(v.ID || v.id) === String(id))) {
        mainContent.innerHTML = skeletonDetail(10);
    }

    const result = await getVisitById(id);
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Visita não encontrada.')}</p>`;
        return;
    }

    const visit = normalizeVisit(result.visit);
    state.currentVisit = visit;
    const whatsappInfo = getWhatsappConfigForVisit(visit.tipoVisita);

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Visitas', page: 'visits' }, { label: visit.cliente || 'Visita' }])}
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-visits">Voltar</button>
            <h2>Detalhes da Visita</h2>
            <button type="button" class="mini-button" id="edit-visit">Editar</button>
        </div>
        <div class="card detail-card">
            ${renderDetailRow('ID', visit.id)}
            ${renderDetailRow('Prospecção', visit.prospeccao)}
            ${renderDetailRow('Vendedor/Gerente', visit.vendedorGerente)}
            ${renderDetailRow('Data da Visita', visit.dataVisita)}
            ${renderDetailRow('Horário', visit.horario)}
            ${renderDetailRow('Cliente', visit.cliente)}
            ${renderDetailRow('Contato', visit.contato)}
            ${renderDetailRow('Cidade', visit.cidade)}
            ${renderDetailRow('Área de Atuação', visit.areaAtuacao)}
            ${renderDetailRow('Potencial do Cliente', visit.potencialCliente)}
            ${renderDetailRow('Tipo da Visita', visit.tipoVisita)}
            ${renderDetailRow('Gerência', visit.gerencia)}
            ${renderDetailRow('Veículo', visit.veiculo)}
            ${renderDetailRow('Observação', visit.observacao || '-')}
        </div>
        <div class="detail-actions">
            <button type="button" class="whatsapp-button" id="share-whatsapp">Compartilhar no WhatsApp</button>
            ${state.canDelete ? '<button type="button" class="danger-button" id="delete-visit">Apagar</button>' : ''}
        </div>
    `;

    document.getElementById('back-visits').addEventListener('click', () => navigateTo('visits'));
    document.getElementById('edit-visit').addEventListener('click', () => navigateTo('visit-edit', { visit }));

    document.getElementById('delete-visit')?.addEventListener('click', async () => {
        if (!confirm(`Apagar a visita de "${visit.cliente || 'cliente'}"? Essa ação não pode ser desfeita.`)) return;
        const result = await callAPI('deleteVisit', { id: visit.id, user: state.currentUser });
        if (result && result.status === 'success') {
            state.visits = state.visits.filter((v) => String(v.id) !== String(visit.id));
            saveCache('visits', state.visits);
            showToast('Visita apagada.');
            navigateTo('visits');
        } else {
            showToast((result && result.message) || 'Não foi possível apagar a visita.', true);
        }
    });

    document.getElementById('share-whatsapp').addEventListener('click', () => {
        const message = buildWhatsappMessage(whatsappInfo?.mensagemPadrao, visit);
        openExternal(`https://wa.me/?text=${encodeURIComponent(message)}`);
    });
}


export async function getVisits(diasParam) {
    const dias = diasParam === 0 ? 0 : (diasParam || state.loadDias || 90);
    const cacheKey = dias === 0 ? 'visits_all' : 'visits';
    const cached = loadCache(cacheKey);
    const sinceTs = cached ? getSyncTimestamp(cacheKey) : 0;
    const fresh = callAPI('getVisits', { user: state.currentUser, dias: dias, since: sinceTs || undefined })
        .then(function(r) {
            if (r.status === 'success') {
                let merged = (sinceTs && cached) ? mergeById(cached, r.visits || [], 'ID') : (r.visits || []);
                // Preserva itens ainda pendentes de sincronizacao (fila offline) — o
                // servidor ainda nao sabe deles, entao um refresh em segundo plano
                // nao pode fazer eles sumirem da lista antes de sincronizar.
                const pending = (state.visits || []).filter((v) => v._pending);
                if (pending.length) { merged = [...pending, ...merged]; }
                saveCache(cacheKey, merged);
                if (typeof r.serverNow === 'number') { setSyncTimestamp(cacheKey, r.serverNow); }
                state.visitsScope = r.scope || 'all';
                return Object.assign({}, r, { visits: merged });
            }
            return r;
        })
        .catch(function(e) { return { status: 'error', message: e.message }; });
    if (cached) {
        showRefreshIndicator();
        fresh.then(function(r) {
            hideRefreshIndicator();
            if (r.status === 'success' && state.currentPage === 'visits') {
                state.visits = r.visits || [];
                const el = document.getElementById('visits-content');
                if (el) { fillVisitsContent(el, state.visits); }
            }
        });
        return { status: 'success', visits: cached, scope: dias === 0 ? 'all' : dias + 'd' };
    }
    return fresh;
}


export async function getVisitById(id) {
    const existing = state.visits.find((item) => String(item.ID || item.id) === String(id));
    if (existing) {
        return { status: 'success', visit: existing };
    }
    try {
        return await callAPI('getVisitById', { id, user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export async function createVisit(payload) {
    try {
        const tempId = 'temp_' + Date.now();
        const optimisticVisit = {
            ...normalizeVisit({
                ID: tempId,
                'Prospecção': payload.prospeccao,
                'Vendedor/Gerente': payload.vendedorGerente,
                'Data da Visita': payload.dataVisita,
                'Horário': payload.horario,
                'Cliente': payload.cliente,
                'Contato': payload.contato,
                'Cidade': payload.cidade,
                'Área de Atuação': payload.areaAtuacao,
                'Potencial do Cliente': payload.potencialCliente,
                'Tipo da Visita': (payload.tiposVisita || [payload.tipoVisita])[0] || '',
                'Gerência': payload.gerencia,
                'Qual o Veículo?': payload.veiculo,
                'Observação': payload.observacao
            })
        };
        state.visits = [optimisticVisit, ...(state.visits || [])];
        saveCache('visits', state.visits);

        const result = await attemptOrQueue('createVisit', payload, { entity: 'visits', tempId });

        if (result && result.status === 'success') {
            const realVisit = normalizeVisit(result.visit || (result.visits && result.visits[0]) || payload);
            state.visits = state.visits.map(v => v.id === tempId ? realVisit : v);
            if (Array.isArray(result.visits) && result.visits.length > 1) {
                const extras = result.visits.slice(1).map(v => normalizeVisit(v));
                state.visits = [...extras, ...state.visits];
            }
        } else if (result && result.status === 'queued') {
            optimisticVisit._pending = true;
            state.visits = state.visits.map(v => v.id === tempId ? optimisticVisit : v);
        } else {
            state.visits = state.visits.filter(v => v.id !== tempId);
        }
        saveCache('visits', state.visits);
        return result || { status: 'error', message: 'Erro ao criar visita.' };
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export async function updateVisit(payload) {
    try {
        const result = await callAPI('updateVisit', payload);
        if (result.status === 'success') { saveCache('visits', null); state.visits = []; }
        return result;
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


const OBS_SOFT_LIMIT = 500;

export function initObservacaoField() {
    const textarea = document.getElementById('observacao');
    const counter = document.getElementById('obs-char-counter');
    const dictateBtn = document.getElementById('obs-dictate-btn');
    if (!textarea || !counter) { return; }

    const updateCounter = () => {
        const len = textarea.value.length;
        counter.textContent = `${len}/${OBS_SOFT_LIMIT}`;
        counter.classList.toggle('obs-char-counter-warn', len > OBS_SOFT_LIMIT);
    };
    textarea.addEventListener('input', updateCounter);
    updateCounter();

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor || !dictateBtn) { return; }

    dictateBtn.style.display = '';
    let recognition = null;
    let recognizing = false;

    const stopUi = () => {
        recognizing = false;
        dictateBtn.classList.remove('obs-dictate-active');
        dictateBtn.textContent = '🎤 Ditar';
    };

    dictateBtn.addEventListener('click', () => {
        if (recognizing) { recognition?.stop(); return; }
        recognition = new SpeechRecognitionCtor();
        recognition.lang = 'pt-BR';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.onstart = () => {
            recognizing = true;
            dictateBtn.classList.add('obs-dictate-active');
            dictateBtn.textContent = '🔴 Ouvindo...';
        };
        recognition.onerror = stopUi;
        recognition.onend = stopUi;
        recognition.onresult = (event) => {
            const transcript = Array.from(event.results).map((r) => r[0].transcript).join(' ').trim();
            if (!transcript) { return; }
            const sep = textarea.value.trim() ? ' ' : '';
            textarea.value = (textarea.value.trim() + sep + transcript).trim();
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };
        recognition.start();
    });
}


export function renderVehicleOptions(selectedValue) {
    return ['Particular', 'Empresa'].map((value) => `
        <label class="radio-pill">
            <input type="radio" name="veiculo" value="${value}" ${value === selectedValue ? 'checked' : ''}>
            <span>${value}</span>
        </label>
    `).join('');
}


export function showMandatoryWhatsappModal(waConfig, visit) {
    return new Promise((resolve) => {
        const msg = buildWhatsappMessage(waConfig.mensagemPadrao, visit);
        const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card">
                <div style="font-size:2rem;margin-bottom:0.75rem">📱</div>
                <h3>Compartilhamento Obrigatório</h3>
                <p>O tipo de visita selecionado exige compartilhamento via WhatsApp antes de continuar.</p>
                <p class="helper-text" style="margin-top:-0.5rem">Direcione esta mensagem ao grupo correto (manutenção, comercial, etc.) antes de enviar.</p>
                <button type="button" id="modal-wa-share" class="primary-button">Abrir WhatsApp</button>
                <button type="button" id="modal-wa-done" class="secondary-button">Já compartilhei — Continuar</button>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#modal-wa-share').addEventListener('click', () => {
            openExternal(url);
        });
        overlay.querySelector('#modal-wa-done').addEventListener('click', () => {
            overlay.remove();
            resolve();
        });
    });
}


export function getWhatsappConfigForVisit(tipoVisita) {
    if (!state.formData || !Array.isArray(state.formData.tiposVisita)) {
        return null;
    }
    return state.formData.tiposVisita.find((item) => item.tipo === tipoVisita && (item.obrigatorio || item.mensagemPadrao));
}


export function buildWhatsappMessage(template, visit) {
    const defaultTemplate = 'Visita registrada para {{cliente}}. Tipo: {{tipoVisita}}. Observacao: {{observacao}}. Vendedor: {{vendedor}}.';
    const messageTemplate = template || defaultTemplate;
    const values = {
        cliente: visit.cliente,
        tipoVisita: visit.tipoVisita,
        observacao: visit.observacao,
        vendedor: visit.vendedorGerente,
        cidade: visit.cidade,
        data: visit.dataVisita
    };

    return messageTemplate.replace(/{{\s*([a-zA-Z]+)\s*}}/g, (_, key) => values[key] || '');
}


export function shareVisit(visit) {
    const lines = [
        `*Visita - ${visit.cliente || 'Cliente não informado'}*`,
        `Data: ${visit.dataVisita || '-'}${visit.horario ? ' às ' + visit.horario : ''}`,
        `Tipo: ${visit.tipoVisita || '-'}`,
        `Cidade: ${visit.cidade || '-'}`,
        visit.contato   ? `Contato: ${visit.contato}`          : null,
        visit.prospeccao === 'Sim' ? 'Prospecção'              : null,
        visit.observacao ? `Obs: ${visit.observacao}`          : null,
    ].filter(Boolean).join('\n');

    if (navigator.share) {
        navigator.share({ title: `Visita - ${visit.cliente || ''}`, text: lines }).catch(() => {});
    } else {
        navigator.clipboard.writeText(lines).then(() => showToast('Visita copiada!')).catch(() => showToast('Não foi possível compartilhar.', true));
    }
}
