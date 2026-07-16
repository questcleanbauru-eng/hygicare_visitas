import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, getSyncTimestamp, setSyncTimestamp, mergeById, attemptOrQueue } from '../api.js';
import {
    escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, parseInputDate,
    formatMonthKey, normalizeProposal, proposalStatusClass, formatDateForDisplay, titleCase
} from '../utils/format.js';
import {
    debounce, downloadCSV, renderDetailRow, showToast, renderSimpleOptions,
    initializeSearchableInput, showRefreshIndicator, hideRefreshIndicator, skeletonDetail,
    loadingState, addFabAndScrollTop, openExternal, renderYearChips, setSaving
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, updateProposalsBadge, ensureStyles } from '../utils/ui.js';
import { trackUpdate, getSummaryCount, shareSummaryAndClear } from '../utils/updateSummary.js';

export function fillProposalsContent(mainContent, proposals) {
    let normalized = (proposals || []).map(normalizeProposal);
    const isAdmGer = isAdminOrGerenteUser();
    const isAdmin  = (state.currentUser?.profile || '').toLowerCase() === 'admin';

    const newProposalDisabledAttr = state.canCreateProposalFunil ? '' : 'disabled title="Peça ao administrador para liberar a criação de propostas."';

    if (normalized.length === 0) {
        const scopeIsLimited = state.proposalsScope && state.proposalsScope !== 'all';
        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Propostas</h2></div>
                <button type="button" class="btn-add" id="btn-new-proposal" ${newProposalDisabledAttr}>+ Nova Proposta</button>
            </div>
            ${scopeIsLimited ? `
            <div class="scope-banner scope-days-ctrl">
                <label for="scope-dias-input">Período:</label>
                <input type="number" id="scope-dias-input" class="scope-dias-input" value="${state.loadDias || 90}" min="1" max="365">
                <span>dias</span>
                <button type="button" id="scope-load-days" class="scope-days-load-btn">Carregar</button>
                <button type="button" id="scope-load-all" class="scope-load-btn">Ver tudo</button>
            </div>` : ''}
            <div class="empty-state">
                <span class="empty-state-icon">📄</span>
                ${scopeIsLimited
                    ? `<p>Nenhuma proposta nos últimos ${state.loadDias || 90} dias.</p>`
                    : `<p>Nenhuma proposta registrada ainda.</p>
                       <button type="button" class="btn-add" id="btn-new-proposal2" ${newProposalDisabledAttr}>+ Nova Proposta</button>`
                }
            </div>
        `;
        document.getElementById('btn-new-proposal')?.addEventListener('click', () => navigateTo('proposal-new'));
        document.getElementById('btn-new-proposal2')?.addEventListener('click', () => navigateTo('proposal-new'));
        if (scopeIsLimited) {
            document.getElementById('scope-load-days')?.addEventListener('click', () => {
                const v = parseInt(document.getElementById('scope-dias-input')?.value, 10);
                if (v > 0) { state.loadDias = v; saveCache('proposals', null); navigateTo('proposals'); }
            });
            document.getElementById('scope-load-all')?.addEventListener('click', () => {
                state.navLoadAll = 'proposals'; navigateTo('proposals');
            });
        }
        return;
    }

    const availableStatuses = Array.from(new Set(normalized.map((p) => p.status).filter(Boolean)));
    const availableCities   = Array.from(new Set(normalized.map((p) => p.cidade).filter(Boolean))).sort();
    const availableVendors  = isAdmGer
        ? Array.from(new Set(normalized.map((p) => p.vendedor).filter(Boolean))).sort()
        : [];

    const summaryCount = getSummaryCount();
    mainContent.innerHTML = `
        <div class="page-header">
            <div><h2>Propostas</h2><p class="page-subtitle">${normalized.length} proposta(s)</p></div>
            <button type="button" class="btn-add" id="btn-new-proposal" ${newProposalDisabledAttr}>+ Nova Proposta</button>
        </div>
        <div class="search-bar-wrapper">
            <span class="search-bar-icon">🔍</span>
            <input type="text" id="pf-search" placeholder="Buscar cliente, cidade ou produto..." class="form-input">
            ${summaryCount > 0 ? `<button type="button" class="csv-export-btn" id="update-summary-btn" title="Compartilhar resumo de atualizações">
                📤 Resumo <span class="pending-badge" style="margin-left:0.2rem">${summaryCount}</span>
            </button>` : ''}
            ${isAdmin ? `<button type="button" class="csv-export-btn" id="proposals-csv-btn" title="Exportar CSV">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v13M8 11l4 4 4-4"/><path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/></svg>
                CSV
            </button>` : ''}
        </div>
        <div class="card visits-filter-card">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    <button type="button" class="mini-button" id="proposal-filter-clear">Limpar</button>
                    <button type="button" class="mini-button" id="proposal-filter-toggle">Ocultar</button>
                </div>
            </div>
            <div class="visits-filter-grid" id="proposal-filter-panel">
                <div class="form-group">
                    <label for="pf-status">Status</label>
                    <div class="searchable-select">
                        <input type="text" id="pf-status" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="pf-status-menu"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="pf-cidade">Cidade</label>
                    <div class="searchable-select">
                        <input type="text" id="pf-cidade" placeholder="Todas" autocomplete="off">
                        <div class="searchable-select-menu" id="pf-cidade-menu"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="pf-atrasada">Situação</label>
                    <select id="pf-atrasada">
                        <option value="">Todas</option>
                        <option value="sim">Atrasadas</option>
                        <option value="nao">Em dia</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="pf-period">Período</label>
                    <select id="pf-period">
                        <option value="">Todos</option>
                        <option value="mes-atual">Mês atual</option>
                        <option value="ultimos-3m">Últimos 3 meses</option>
                    </select>
                </div>
                ${isAdmGer ? `
                <div class="form-group">
                    <label for="pf-vendor">Vendedor</label>
                    <div class="searchable-select">
                        <input type="text" id="pf-vendor" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="pf-vendor-menu"></div>
                    </div>
                </div>` : ''}
                <div class="form-group">
                    <label for="pf-date-from">Criação de</label>
                    <input type="date" id="pf-date-from">
                </div>
                <div class="form-group">
                    <label for="pf-date-to">Criação até</label>
                    <input type="date" id="pf-date-to">
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
        <div id="proposal-year-chips" class="year-chips-row"></div>
        <div id="proposal-list-container"></div>
    `;

    const filterPanel  = document.getElementById('proposal-filter-panel');
    const filterToggle = document.getElementById('proposal-filter-toggle');
    const isMobile = window.matchMedia('(max-width: 640px)').matches;
    let collapsed = isMobile;
    filterPanel.classList.toggle('collapsed', collapsed);
    filterToggle.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    filterToggle.addEventListener('click', () => {
        collapsed = !collapsed;
        filterPanel.classList.toggle('collapsed', collapsed);
        filterToggle.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    });

    const renderFiltered = async () => {
        const dateFromCheck = document.getElementById('pf-date-from')?.value || '';
        if (state.proposalsScope !== 'all' && dateFromCheck) {
            const cutoffDias = new Date();
            cutoffDias.setDate(cutoffDias.getDate() - (state.loadDias || 90));
            if (new Date(dateFromCheck) < cutoffDias) {
                const listEl = document.getElementById('proposal-list-container');
                if (listEl) listEl.innerHTML = `<div class="scope-loading">Carregando histórico completo...</div>`;
                try {
                    const r = await callAPI('getProposals', { user: state.currentUser, meses: 0 });
                    if (r.status === 'success') {
                        state.proposals = r.proposals || [];
                        state.proposalsScope = 'all';
                        saveCache('proposals_all', state.proposals);
                        normalized = state.proposals.map(normalizeProposal);
                    }
                } catch(e) {}
            }
        }
        const search    = document.getElementById('pf-search')?.value.trim().toLowerCase() || '';
        const status    = document.getElementById('pf-status')?.value || '';
        const cidade    = document.getElementById('pf-cidade')?.value || '';
        const atrasada  = document.getElementById('pf-atrasada')?.value || '';
        const period    = document.getElementById('pf-period')?.value || '';
        const vendor    = document.getElementById('pf-vendor')?.value || '';
        const dateFrom  = document.getElementById('pf-date-from')?.value || '';
        const dateTo    = document.getElementById('pf-date-to')?.value || '';
        const { start: periodStart, end: periodEnd } = getDateRangeForPeriod(period);

        const filtered = normalized.filter((p) => {
            const matchSearch   = !search  || [p.cliente, p.cidade, p.obs, p.vendedor, p.foco].some((v) => String(v || '').toLowerCase().includes(search));
            const matchStatus   = !status  || p.status === status;
            const matchCidade   = !cidade  || p.cidade === cidade;
            const matchAtrasada = !atrasada || (atrasada === 'sim' ? p.atrasada : !p.atrasada);
            const matchVendor   = !vendor  || p.vendedor === vendor;
            const criacaoDate = parseDisplayDate(p.data);
            const matchPeriod = !period || (criacaoDate && criacaoDate >= periodStart && criacaoDate <= periodEnd);
            const matchFrom = !dateFrom || (criacaoDate && criacaoDate >= parseInputDate(dateFrom));
            const matchTo   = !dateTo   || (criacaoDate && criacaoDate <= parseInputDate(dateTo));
            const matchYear = !state.proposalsYearFilter || (criacaoDate && criacaoDate.getFullYear() === state.proposalsYearFilter);
            return matchSearch && matchStatus && matchCidade && matchAtrasada && matchVendor && matchPeriod && matchFrom && matchTo && matchYear;
        });

        const container = document.getElementById('proposal-list-container');
        if (!container) { return; }

        if (filtered.length === 0) {
            container.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhuma proposta para os filtros selecionados.</p></div>`;
            return;
        }

        const sorted = [...filtered].sort((a, b) => {
            const da = parseDisplayDate(a.atualizacao) || parseDisplayDate(a.data);
            const db = parseDisplayDate(b.atualizacao) || parseDisplayDate(b.data);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });

        const byMonth = sorted.reduce((groups, p) => {
            const d = parseDisplayDate(p.atualizacao) || parseDisplayDate(p.data);
            const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'Sem data';
            if (!groups[key]) { groups[key] = []; }
            groups[key].push(p);
            return groups;
        }, {});

        container.innerHTML = Object.keys(byMonth).sort((a, b) => b.localeCompare(a)).map((key) => `
            <section class="visit-month-group">
                <div class="visit-month-header">
                    <h3>${escapeHtml(formatMonthKey(key))}</h3>
                    <span>${byMonth[key].length} proposta(s)</span>
                </div>
                <div class="visits-list">${byMonth[key].map((p) => `
                    <button type="button" class="proposal-card ${p.atrasada ? 'proposal-card-alert' : ''}" data-proposal-id="${escapeHtml(p.id)}">
                        <div class="visit-card-header">
                            <strong>${escapeHtml(p.cliente || 'Cliente não informado')}</strong>
                            ${p._pending ? '<span class="pending-badge" title="Aguardando conexão para enviar">⏳ Pendente</span>' : `<span class="${proposalStatusClass(p.status, p.atrasada)} status-pill-editable" role="button" tabindex="0" aria-label="Alterar status da proposta, atual: ${escapeHtml(p.status || '-')}" data-inline-status="${escapeHtml(p.id)}" data-current-status="${escapeHtml(p.status || '')}">${escapeHtml(p.status || '-')}</span>`}
                        </div>
                        ${p.foco ? `<div style="font-size:0.78rem;color:var(--text-muted-strong);margin:0.12rem 0">${escapeHtml(p.foco)}</div>` : ''}
                        <div class="proposal-meta">
                            <span>${escapeHtml(p.vendedor || '-')}</span>
                            <span>${escapeHtml(p.cidade || '-')}</span>
                            <span>${escapeHtml(p.atualizacao || '-')}</span>
                        </div>
                        ${p.atrasada ? '<div class="alert-text">Sem atualização há mais de 30 dias.</div>' : ''}
                    </button>
                `).join('')}</div>
            </section>
        `).join('');

        container.querySelectorAll('[data-proposal-id]').forEach((btn) => {
            btn.addEventListener('click', () => navigateTo('proposal-detail', { id: btn.dataset.proposalId }));
        });
        container.querySelectorAll('.status-pill-editable').forEach(pill => {
            pill.addEventListener('click', (e) => {
                e.stopPropagation();
                openInlineStatusEditor(pill, pill.dataset.inlineStatus, pill.dataset.currentStatus);
            });
        });
    };

    const _proposalFilterIds = ['pf-search', 'pf-status', 'pf-cidade', 'pf-atrasada', 'pf-period', 'pf-vendor',
        'pf-date-from', 'pf-date-to'];
    initializeSearchableInput({ input: document.getElementById('pf-status'), menu: document.getElementById('pf-status-menu'), items: availableStatuses });
    initializeSearchableInput({ input: document.getElementById('pf-cidade'), menu: document.getElementById('pf-cidade-menu'), items: availableCities });
    if (isAdmGer) {
        initializeSearchableInput({ input: document.getElementById('pf-vendor'), menu: document.getElementById('pf-vendor-menu'), items: availableVendors });
    }

    const _proposalTextFilterIds = new Set(['pf-search', 'pf-status', 'pf-cidade', 'pf-vendor']);
    const _debouncedProposalFilter = debounce(renderFiltered, 250);
    _proposalFilterIds.forEach((id) => {
        const isText = _proposalTextFilterIds.has(id);
        document.getElementById(id)?.addEventListener(isText ? 'input' : 'change', isText ? _debouncedProposalFilter : renderFiltered);
    });

    document.getElementById('proposal-filter-clear')?.addEventListener('click', () => {
        _proposalFilterIds.forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; } });
        state.proposalsYearFilter = null;
        renderFiltered();
        updateYearChips();
    });

    document.getElementById('scope-load-days')?.addEventListener('click', () => {
        const v = parseInt(document.getElementById('scope-dias-input')?.value, 10);
        if (v > 0) { state.loadDias = v; saveCache('proposals', null); navigateTo('proposals'); }
    });

    function updateYearChips() {
        const chipsEl = document.getElementById('proposal-year-chips');
        if (!chipsEl) return;
        if (state.proposalsScope !== 'all') { chipsEl.innerHTML = ''; return; }
        const dates = normalized.map((p) => parseDisplayDate(p.data));
        renderYearChips(chipsEl, dates, state.proposalsYearFilter, (year) => {
            state.proposalsYearFilter = year;
            renderFiltered();
            updateYearChips();
        });
    }
    updateYearChips();

    document.getElementById('scope-load-all')?.addEventListener('click', async () => {
        const listEl = document.getElementById('proposal-list-container');
        if (listEl) listEl.innerHTML = `<div class="scope-loading">Carregando histórico completo...</div>`;
        try {
            const r = await callAPI('getProposals', { user: state.currentUser, meses: 0 });
            if (r.status === 'success') {
                state.proposals = r.proposals || [];
                state.proposalsScope = 'all';
                saveCache('proposals_all', state.proposals);
                normalized = state.proposals.map(normalizeProposal);
                document.querySelector('.scope-banner')?.remove();
                initializeSearchableInput({ input: document.getElementById('pf-status'), menu: document.getElementById('pf-status-menu'), items: Array.from(new Set(normalized.map((p) => p.status).filter(Boolean))) });
                initializeSearchableInput({ input: document.getElementById('pf-cidade'), menu: document.getElementById('pf-cidade-menu'), items: Array.from(new Set(normalized.map((p) => p.cidade).filter(Boolean))).sort() });
                if (isAdmGer) initializeSearchableInput({ input: document.getElementById('pf-vendor'), menu: document.getElementById('pf-vendor-menu'), items: Array.from(new Set(normalized.map((p) => p.vendedor).filter(Boolean))).sort() });
                renderFiltered();
                updateYearChips();
            }
        } catch(e) {}
    });

    document.getElementById('btn-new-proposal')?.addEventListener('click', () => navigateTo('proposal-new'));
    document.getElementById('proposals-csv-btn')?.addEventListener('click', () => {
        downloadCSV(normalized, 'propostas.csv', [
            { key: 'data', label: 'Data' },
            { key: 'cliente', label: 'Cliente' },
            { key: 'produto', label: 'Produto' },
            { key: 'status', label: 'Status' },
            { key: 'cidade', label: 'Cidade' },
            { key: 'vendedor', label: 'Vendedor' }
        ]);
    });
    document.getElementById('update-summary-btn')?.addEventListener('click', () => {
        if (confirm('Compartilhar o resumo de atualizações no WhatsApp e limpar a lista?')) {
            shareSummaryAndClear();
            navigateTo('proposals');
        }
    });
    renderFiltered();

    const overdueCount = normalized.filter((p) => p.atrasada).length;
    updateProposalsBadge(overdueCount);
}


export async function renderProposalsPage() {
    ensureStyles('proposals');
    const mainContent = document.getElementById('main-content');
    const loadAll = state.navLoadAll === 'proposals';
    state.navLoadAll = null;
    const cachedAllRaw = loadCache('proposals_all');
    const cached3mRaw  = loadCache('proposals');
    // Cache vazio ([]) conta como "sem cache" — senão um refresh incremental
    // (que só busca poucos dias) nunca reconstrói a lista completa.
    const cachedAll = (Array.isArray(cachedAllRaw) && cachedAllRaw.length > 0) ? cachedAllRaw : null;
    const cached3m  = (Array.isArray(cached3mRaw) && cached3mRaw.length > 0) ? cached3mRaw : null;
    const cachedProposals = loadAll ? cachedAll : (cachedAll || cached3m);
    if (cachedProposals) {
        state.proposalsScope = cachedAll ? 'all' : '3m';
        state.proposals = cachedProposals;
        fillProposalsContent(mainContent, state.proposals);
        addFabAndScrollTop('Nova Proposta', () => {
            if (state.canCreateProposalFunil) { navigateTo('proposal-new'); }
            else { showToast('Peça ao administrador para liberar a criação de propostas.', true); }
        });
        initPullToRefresh(async () => {
            const r = await getProposals(state.proposalsScope === 'all' ? 0 : undefined);
            if (r.status === 'success' && state.currentPage === 'proposals') {
                state.proposals = r.proposals || [];
                const el = document.getElementById('main-content');
                if (el) { fillProposalsContent(el, state.proposals); }
            }
        });
        getProposals(loadAll || cachedAll ? 0 : 3);
        return;
    }
    mainContent.innerHTML = loadingState('📄', 'Carregando suas propostas...');
    const result = await getProposals(loadAll ? 0 : undefined);
    state.proposalsScope = result.scope || 'all';
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar propostas.')}</p>`;
        return;
    }
    state.proposals = result.proposals || [];
    fillProposalsContent(mainContent, state.proposals);
    addFabAndScrollTop('Nova Proposta', () => {
        if (state.canCreateProposalFunil) { navigateTo('proposal-new'); }
        else { showToast('Peça ao administrador para liberar a criação de propostas.', true); }
    });
    initPullToRefresh(async () => {
            const r = await getProposals(state.proposalsScope === 'all' ? 0 : undefined);
            if (r.status === 'success' && state.currentPage === 'proposals') {
                state.proposals = r.proposals || [];
                const el = document.getElementById('main-content');
                if (el) { fillProposalsContent(el, state.proposals); }
            }
        });
}


export async function renderProposalDetailPage(id) {
    ensureStyles('proposals');
    const mainContent = document.getElementById('main-content');
    if (!state.proposals.find(p => String(p.Id || p.id) === String(id))) {
        mainContent.innerHTML = skeletonDetail(10);
    }

    const result = await getProposalById(id);
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Proposta não encontrada.')}</p>`;
        return;
    }

    const proposal = normalizeProposal(result.proposal);
    state.currentProposal = proposal;

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Propostas', page: 'proposals' }, { label: proposal.cliente || 'Proposta' }])}
        <div class="page-header compact-header">
            <button type="button" id="back-proposals" style="background:none;border:none;color:#64748B;font-size:0.87rem;cursor:pointer;display:flex;align-items:center;gap:0.3rem;padding:0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15,18 9,12 15,6"/></svg>
                Voltar
            </button>
            <h2>Detalhes da Proposta</h2>
            <button type="button" class="mini-button" id="edit-proposal">Editar</button>
        </div>
        ${proposal.atrasada ? `
        <div class="alert-banner">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Esta proposta está sem atualização há mais de 30 dias.
        </div>` : ''}
        <div class="card detail-card">
            ${renderDetailRow('ID', proposal.id)}
            ${renderDetailRow('Data', proposal.data)}
            ${renderDetailRow('Vendedor', titleCase(proposal.vendedor))}
            ${renderDetailRow('Cliente', titleCase(proposal.cliente))}
            ${renderDetailRow('Foco', proposal.foco)}
            ${renderDetailRow('Produtos', proposal.produtos)}
            ${renderDetailRow('Gerência', proposal.gerencia)}
            ${renderDetailRow('Cidade', titleCase(proposal.cidade))}
            ${renderDetailRow('Status', proposal.status)}
            ${renderDetailRow('Última Atualização', proposal.atualizacao)}
            ${renderDetailRow('Hora', proposal.hora)}
            ${renderDetailRow('Obs', proposal.obs || '-')}
            ${renderDetailRow('Data Limite', proposal.dataLimite || '-')}
            ${renderDetailRow('E-mail', proposal.email || '-')}
        </div>
        <div class="sticky-action-bar">
            <button type="button" id="share-proposal-whatsapp" class="proposal-action-whatsapp">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                WhatsApp
            </button>
        </div>
        ${state.canDelete ? `<div style="margin-top:0.75rem"><button type="button" class="danger-button" id="delete-proposal">Apagar</button></div>` : ''}
    `;

    document.getElementById('back-proposals').addEventListener('click', () => navigateTo('proposals'));
    document.getElementById('edit-proposal').addEventListener('click', () => navigateTo('proposal-edit', { proposal }));
    document.getElementById('share-proposal-whatsapp').addEventListener('click', () => {
        const text = `*Proposta - ${proposal.cliente}*\nStatus: ${proposal.status}\nFoco: ${proposal.foco || '-'}\nCidade: ${proposal.cidade || '-'}\nÚltima atualização: ${proposal.atualizacao || '-'}\nObs: ${proposal.obs || '-'}`;
        openExternal(`https://wa.me/?text=${encodeURIComponent(text)}`);
    });
    document.getElementById('delete-proposal')?.addEventListener('click', async (event) => {
        if (!confirm(`Apagar a proposta de "${proposal.cliente || 'cliente'}"? Essa ação não pode ser desfeita.`)) return;
        const btn = event.currentTarget;
        setSaving(true, btn, 'Apagando...');
        const result = await callAPI('deleteProposal', { id: proposal.id, user: state.currentUser });
        if (result && result.status === 'success') {
            state.proposals = state.proposals.filter((p) => String(p.id) !== String(proposal.id));
            saveCache('proposals', state.proposals);
            showToast('Proposta apagada.');
            navigateTo('proposals');
        } else {
            showToast((result && result.message) || 'Não foi possível apagar a proposta.', true);
            setSaving(false, btn);
        }
    });
}


export async function renderProposalFormPage(proposal) {
    ensureStyles('proposals');
    const normalized = normalizeProposal(proposal || state.currentProposal);
    const mainContent = document.getElementById('main-content');

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-proposal-detail">Voltar</button>
            <h2>Atualizar Proposta</h2>
        </div>
        <form id="proposal-form" class="card form-card form-layout">
            <input type="hidden" id="proposal-id" value="${escapeHtml(normalized.id)}">
            <div class="form-group full-width readonly-group">
                <label>Cliente</label>
                <input type="text" value="${escapeHtml(normalized.cliente)}" readonly>
            </div>
            <div class="form-group">
                <label for="proposal-status">Status</label>
                <select id="proposal-status" required>
                    ${renderSimpleOptions(['Enviada', 'Em negociacao', 'Ganhamos', 'Perdido'], normalized.status)}
                </select>
            </div>
            <div class="form-group full-width">
                <label for="proposal-obs">Atualizar / OBS</label>
                <textarea id="proposal-obs" rows="4" required>${escapeHtml(normalized.obs || '')}</textarea>
            </div>
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-proposal">Cancelar</button>
                <button type="submit" id="save-proposal">Salvar Atualizacao</button>
            </div>
        </form>
    `;

    document.getElementById('back-proposal-detail').addEventListener('click', () => navigateTo('proposal-detail', { id: normalized.id }));
    document.getElementById('cancel-proposal').addEventListener('click', () => navigateTo('proposal-detail', { id: normalized.id }));

    document.getElementById('proposal-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = document.getElementById('save-proposal');
        setSaving(true, button, 'Salvando...');

        const newStatus = document.getElementById('proposal-status').value;
        const newObs = document.getElementById('proposal-obs').value.trim();
        const proposalId = normalized.id;

        // Optimistic update: reflect changes immediately in state + cache
        const idx = state.proposals.findIndex((p) => String(p.Id || p.id) === String(proposalId));
        const original = idx >= 0 ? { ...state.proposals[idx] } : null;
        const nowDisplay = formatDateForDisplay(new Date());
        if (idx >= 0) {
            state.proposals[idx] = {
                ...state.proposals[idx],
                status: newStatus, Status: newStatus,
                obs: newObs, Obs: newObs,
                atualizacao: nowDisplay, Atualizacao: nowDisplay
            };
            saveCache('proposals', state.proposals);
        }

        // Navigate immediately — user sees updated data right away
        navigateTo('proposal-detail', { id: proposalId });
        showToast('Proposta atualizada.');

        // API call in background
        attemptOrQueue('updateProposal', { id: proposalId, status: newStatus, obs: newObs, user: state.currentUser },
            { entity: 'proposals', tempId: proposalId })
            .then((result) => {
                if (result && result.status === 'success') {
                    saveCache('proposals', null);
                    saveCache('dashboard', null);
                    state.proposals = [];
                    trackUpdate('proposals', { id: proposalId, cliente: normalized.cliente, status: newStatus });
                } else if (result && result.status === 'queued') {
                    if (idx >= 0) {
                        state.proposals[idx] = { ...state.proposals[idx], _pending: true };
                        saveCache('proposals', state.proposals);
                    }
                    showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                    trackUpdate('proposals', { id: proposalId, cliente: normalized.cliente, status: newStatus });
                } else {
                    // Revert on failure
                    if (idx >= 0 && original) {
                        state.proposals[idx] = original;
                        saveCache('proposals', state.proposals);
                    }
                    showToast((result && result.message) || 'Erro ao salvar. Tente novamente.', true);
                }
            })
            .catch(() => {
                if (idx >= 0 && original) {
                    state.proposals[idx] = original;
                    saveCache('proposals', state.proposals);
                }
                showToast('Erro ao salvar. Tente novamente.', true);
            });
    });
}


export async function renderProposalCreatePage() {
    ensureStyles('proposals');
    const mainContent = document.getElementById('main-content');
    if (!state.formData) {
        mainContent.innerHTML = `
            <div class="page-header compact-header">
                <button type="button" class="mini-button" id="back-proposal-overlay">Voltar</button>
                <h2>Nova Proposta</h2>
                <span></span>
            </div>
            <div class="card form-card" style="position:relative;min-height:200px;">
                <div class="form-loading-overlay">
                    <div class="form-loading-spinner"></div>
                    <span>Carregando formulario...</span>
                </div>
            </div>
        `;
        document.getElementById('back-proposal-overlay')?.addEventListener('click', () => navigateTo('proposals'));
    }

    const fdResult = await ensureFormData();
    const cidades = (fdResult.data && fdResult.data.cidades) || [];
    const potenciais = (fdResult.data && fdResult.data.potenciaisCliente) || [];

    const dataLimite30 = new Date();
    dataLimite30.setDate(dataLimite30.getDate() + 30);
    const defaultDataLimite = dataLimite30.toISOString().slice(0, 10);

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-proposal-create">Voltar</button>
            <h2>Nova Proposta</h2>
            <span></span>
        </div>
        <form id="proposal-create-form" class="card form-card form-layout">
            <div class="form-group full-width">
                <label for="pc-cliente">Cliente *</label>
                <input type="text" id="pc-cliente" placeholder="Nome do cliente" required>
            </div>
            <div class="form-group">
                <label for="pc-cidade">Cidade</label>
                <div class="searchable-select">
                    <input type="text" id="pc-cidade" placeholder="Pesquise a cidade" autocomplete="off">
                    <div class="searchable-select-menu" id="pc-cidade-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="pc-foco">Potencial</label>
                <div class="searchable-select">
                    <input type="text" id="pc-foco" placeholder="Pesquise o potencial" autocomplete="off">
                    <div class="searchable-select-menu" id="pc-foco-menu"></div>
                </div>
            </div>
            <div class="form-group full-width">
                <label for="pc-produtos">Produtos</label>
                <input type="text" id="pc-produtos" placeholder="Produtos envolvidos">
            </div>
            <div class="form-group">
                <label for="pc-status">Status</label>
                <select id="pc-status">
                    ${renderSimpleOptions(['Enviada', 'Em negociacao', 'Ganhamos', 'Perdido'], 'Enviada')}
                </select>
            </div>
            <div class="form-group">
                <label for="pc-data-limite">Data Limite</label>
                <input type="date" id="pc-data-limite" value="${defaultDataLimite}">
            </div>
            <div class="form-group full-width">
                <label for="pc-obs">Observacoes</label>
                <textarea id="pc-obs" rows="4" placeholder="Detalhes da proposta"></textarea>
            </div>
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-proposal-create">Cancelar</button>
                <button type="submit" id="save-proposal-create">Salvar Proposta</button>
            </div>
        </form>
    `;

    initializeSearchableInput({
        input: document.getElementById('pc-cidade'),
        menu: document.getElementById('pc-cidade-menu'),
        items: cidades
    });
    initializeSearchableInput({
        input: document.getElementById('pc-foco'),
        menu: document.getElementById('pc-foco-menu'),
        items: potenciais
    });

    document.getElementById('back-proposal-create').addEventListener('click', () => navigateTo('proposals'));
    document.getElementById('cancel-proposal-create').addEventListener('click', () => navigateTo('proposals'));

    document.getElementById('proposal-create-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const btn = document.getElementById('save-proposal-create');
        setSaving(true, btn, 'Salvando...');

        const clienteVal  = document.getElementById('pc-cliente').value.trim();
        const cidadeVal   = document.getElementById('pc-cidade').value.trim();
        const focoVal     = document.getElementById('pc-foco').value.trim();
        const produtosVal = document.getElementById('pc-produtos').value.trim();
        const statusVal   = document.getElementById('pc-status').value;
        const obsVal      = document.getElementById('pc-obs').value.trim();

        const tempPId = 'temp_' + Date.now();
        const nowPDisplay = formatDateForDisplay(new Date());
        const optimisticProposal = normalizeProposal({
            Id: tempPId,
            Data: nowPDisplay,
            Vendedor: state.currentUser.name,
            Cliente: clienteVal,
            Foco: focoVal,
            Produtos: produtosVal,
            Gerencia: state.currentUser.gerencia,
            Cidade: cidadeVal,
            Status: statusVal,
            'Atualização': nowPDisplay,
            'Atualizar/OBS': obsVal
        });
        state.proposals = [optimisticProposal, ...(state.proposals || [])];
        saveCache('proposals', state.proposals);

        showToast('Proposta criada com sucesso.');
        navigateTo('proposals');

        attemptOrQueue('createProposal', { cliente: clienteVal, cidade: cidadeVal, foco: focoVal,
            produtos: produtosVal, status: statusVal, obs: obsVal, user: state.currentUser },
            { entity: 'proposals', tempId: tempPId })
            .then(result => {
                if (result && result.status === 'success') {
                    const real = normalizeProposal(result.proposal || optimisticProposal);
                    state.proposals = state.proposals.map(p => String(p.id) === tempPId ? real : p);
                    saveCache('proposals', state.proposals);
                } else if (result && result.status === 'queued') {
                    state.proposals = state.proposals.map(p => String(p.id) === tempPId ? { ...optimisticProposal, _pending: true } : p);
                    saveCache('proposals', state.proposals);
                    showToast('Sem conexão — a proposta foi salva no aparelho e será enviada quando a conexão voltar.');
                } else {
                    state.proposals = state.proposals.filter(p => String(p.id) !== tempPId);
                    saveCache('proposals', state.proposals);
                    showToast((result && result.message) || 'Erro ao criar proposta.', true);
                }
            })
            .catch(() => {
                state.proposals = state.proposals.filter(p => String(p.id) !== tempPId);
                saveCache('proposals', state.proposals);
                showToast('Erro ao criar proposta.', true);
            });
    });
}


export async function getProposals(diasParam) {
    const dias = diasParam === 0 ? 0 : (diasParam || state.loadDias || 90);
    const cacheKey = dias === 0 ? 'proposals_all' : 'proposals';
    const cachedRaw = loadCache(cacheKey);
    const cached = (Array.isArray(cachedRaw) && cachedRaw.length > 0) ? cachedRaw : null;
    const sinceTs = cached ? getSyncTimestamp(cacheKey) : 0;
    const fresh = callAPI('getProposals', { user: state.currentUser, dias: dias, since: sinceTs || undefined })
        .then(function(r) {
            if (r.status === 'success') {
                let merged = (sinceTs && cached) ? mergeById(cached, r.proposals || [], 'Id') : (r.proposals || []);
                const pending = (state.proposals || []).filter((p) => p._pending);
                if (pending.length) { merged = [...pending, ...merged]; }
                saveCache(cacheKey, merged);
                if (typeof r.serverNow === 'number') { setSyncTimestamp(cacheKey, r.serverNow); }
                state.proposalsScope = r.scope || 'all';
                return Object.assign({}, r, { proposals: merged });
            }
            return r;
        })
        .catch(function(e) { return { status: 'error', message: e.message }; });
    if (cached) {
        showRefreshIndicator();
        fresh.then(function(r) {
            hideRefreshIndicator();
            if (r.status === 'success' && state.currentPage === 'proposals') {
                state.proposals = r.proposals || [];
                const el = document.getElementById('main-content');
                if (el) { fillProposalsContent(el, state.proposals); }
            }
        });
        return { status: 'success', proposals: cached, scope: dias === 0 ? 'all' : dias + 'd' };
    }
    return fresh;
}


export async function getProposalById(id) {
    const existing = state.proposals.find((item) => String(item.Id || item.id) === String(id));
    if (existing) {
        return { status: 'success', proposal: existing };
    }
    try {
        return await callAPI('getProposalById', { id, user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export function openInlineStatusEditor(pill, proposalId, currentStatus) {
    document.querySelector('.inline-status-editor')?.remove();
    const statuses = ['Enviada', 'Em negociacao', 'Ganhamos', 'Perdido'];
    const editor = document.createElement('div');
    editor.className = 'inline-status-editor';
    editor.innerHTML = statuses.map(s =>
        `<button type="button" class="inline-status-opt${s === currentStatus ? ' active' : ''}" data-s="${escapeHtml(s)}">${escapeHtml(s)}</button>`
    ).join('');
    const rect = pill.getBoundingClientRect();
    editor.style.cssText = `position:fixed;top:${Math.round(rect.bottom + 4)}px;left:${Math.round(rect.left)}px;z-index:1000`;
    document.body.appendChild(editor);
    const close = () => editor.remove();
    editor.addEventListener('click', e => e.stopPropagation());
    editor.querySelectorAll('[data-s]').forEach(opt => {
        opt.addEventListener('click', () => {
            const newStatus = opt.dataset.s;
            close();
            if (newStatus === currentStatus) return;
            const idx = state.proposals.findIndex(p => String(p.Id || p.id) === String(proposalId));
            const original = idx >= 0 ? { ...state.proposals[idx] } : null;
            const currentObs = original ? (original.obs || original['Atualizar/OBS'] || original.Obs || '') : '';
            if (idx >= 0) {
                state.proposals[idx] = { ...state.proposals[idx], status: newStatus, Status: newStatus };
                saveCache('proposals', state.proposals);
            }
            pill.textContent = newStatus;
            pill.className = proposalStatusClass(newStatus, false) + ' status-pill-editable';
            pill.dataset.currentStatus = newStatus;
            showToast('Status atualizado.');
            attemptOrQueue('updateProposal', { id: proposalId, status: newStatus, obs: currentObs, user: state.currentUser },
                { entity: 'proposals', tempId: String(proposalId) })
                .then((result) => {
                    const clienteNome = original ? (original.cliente || original.Cliente || '') : '';
                    if (result && result.status === 'queued') {
                        if (idx >= 0) {
                            state.proposals[idx] = { ...state.proposals[idx], _pending: true };
                            saveCache('proposals', state.proposals);
                        }
                        showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                        trackUpdate('proposals', { id: proposalId, cliente: clienteNome, status: newStatus });
                    } else if (!result || result.status !== 'success') {
                        if (idx >= 0 && original) { state.proposals[idx] = original; saveCache('proposals', state.proposals); }
                        showToast((result && result.message) || 'Erro ao atualizar status.', true);
                    } else {
                        trackUpdate('proposals', { id: proposalId, cliente: clienteNome, status: newStatus });
                    }
                })
                .catch(() => {
                    if (idx >= 0 && original) { state.proposals[idx] = original; saveCache('proposals', state.proposals); }
                    showToast('Erro ao atualizar status.', true);
                });
        });
    });
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
}

// ── Visit bar chart ──────────────────────────────────────────────