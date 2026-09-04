import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, getSyncTimestamp, setSyncTimestamp, mergeById, attemptOrQueue } from '../api.js';
import {
    escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, parseInputDate,
    formatMonthKey, normalizeProposal, proposalStatusClass, formatDateForDisplay, titleCase, proposalStatusIcon, filterLabelHtml,
    formatInputDateFromDisplay, formatDateFromDisplay,
    datedNoteHeader, withDatedNoteHeader, stripEmptyDatedLine
} from '../utils/format.js';
import {
    debounce, downloadCSV, renderDetailRow, actionIcon, showToast, renderSimpleOptions,
    initializeSearchableInput, showRefreshIndicator, hideRefreshIndicator, skeletonDetail,
    loadingState, addScrollTop, openExternal, renderYearChips, setSaving, renderSavedFilters
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, updateProposalsBadge, ensureStyles, initSearchBarAutoHide } from '../utils/ui.js';
import { trackUpdate, getSummaryCount, shareSummaryAndClear } from '../utils/updateSummary.js';

// ── "Cliente já está no Funil?" ──────────────────────────────────────────
const _funilKey = (name) => String(name || '').trim().toLowerCase();

// Carrega o Funil uma vez (best-effort) só pra checar duplicidade no botão
// "Ao Funil". Se falhar, o botão segue funcionando como "adicionar".
async function ensureFunilForDedup() {
    if (Array.isArray(state.funil) && state.funil.length) return;
    try {
        const { getFunil } = await import('./funil.js');
        const r = await getFunil(0);
        if (r && r.status === 'success') state.funil = r.funil || state.funil || [];
    } catch (e) { /* best-effort */ }
}

// Considera "já está no funil" quando bate cliente E foco.
function funilItemForProposta(cliente, foco) {
    const kc = _funilKey(cliente);
    if (!kc) return null;
    const kf = _funilKey(foco);
    return (state.funil || []).find((f) =>
        _funilKey(f.cliente || f.Cliente) === kc && _funilKey(f.foco || f.Foco) === kf) || null;
}

// Funil "em alerta" (Perdido ou Retomar) → indicador em vermelho.
function funilEmAlerta(item) {
    return /PERDID|RETOMAR/i.test(String((item && (item.status || item.Status)) || ''));
}

export function fillProposalsContent(mainContent, proposals) {
    let normalized = (proposals || []).map(normalizeProposal);
    const isAdmGer = isAdminOrGerenteUser();
    const isAdmin  = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    // Edição rápida (só admin, só desktop): lista + painel de edição na mesma
    // tela — atualiza uma proposta atrás da outra sem abrir/voltar.
    let quickEdit = isAdmin && (() => { try { return localStorage.getItem('proposals_quick_edit') === '1'; } catch (e) { return false; } })();
    let qeSelectedId = null;
    const qeActive = () => quickEdit && isAdmin && window.innerWidth >= 1024;

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
            <div style="display:flex;gap:0.5rem">
                ${isAdmin ? `<button type="button" class="mini-button qe-toggle${quickEdit ? ' is-on' : ''}" id="qe-toggle" title="Editar na mesma tela, uma proposta após a outra">⚡ Edição rápida</button>` : ''}
                <button type="button" class="btn-add" id="btn-new-proposal" ${newProposalDisabledAttr}>+ Nova Proposta</button>
            </div>
        </div>
        <div class="search-bar-wrapper">
            <div class="search-bar-input-group">
                <span class="search-bar-icon">🔍</span>
                <input type="text" id="pf-search" placeholder="Buscar cliente, cidade ou produto..." class="form-input">
            </div>
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
            <div class="saved-filters-row" id="proposal-saved-filters"></div>
            <div class="visits-filter-grid" id="proposal-filter-panel">
                <div class="form-group">
                    <label for="pf-status">${filterLabelHtml('Status')}</label>
                    <div class="searchable-select">
                        <input type="text" id="pf-status" placeholder="Todos (marque um ou mais)" autocomplete="off">
                        <div class="searchable-select-menu" id="pf-status-menu"></div>
                    </div>
                    <div class="selected-types" id="pf-status-selected" style="margin-top:0.3rem"></div>
                </div>
                <div class="form-group">
                    <label for="pf-cidade">${filterLabelHtml('Cidade')}</label>
                    <div class="searchable-select">
                        <input type="text" id="pf-cidade" placeholder="Todas" autocomplete="off">
                        <div class="searchable-select-menu" id="pf-cidade-menu"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="pf-atrasada">${filterLabelHtml('Situação')}</label>
                    <select id="pf-atrasada">
                        <option value="">Todas</option>
                        <option value="sim">Atrasadas</option>
                        <option value="nao">Em dia</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="pf-period">${filterLabelHtml('Período')}</label>
                    <select id="pf-period">
                        <option value="">Todos</option>
                        <option value="mes-atual">Mês atual</option>
                        <option value="ultimos-3m">Últimos 3 meses</option>
                    </select>
                </div>
                ${isAdmGer ? `
                <div class="form-group">
                    <label for="pf-vendor">${filterLabelHtml('Vendedor')}</label>
                    <div class="searchable-select">
                        <input type="text" id="pf-vendor" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="pf-vendor-menu"></div>
                    </div>
                </div>` : ''}
                <div class="form-group">
                    <label for="pf-date-from">${filterLabelHtml('Criação de')}</label>
                    <input type="date" id="pf-date-from">
                </div>
                <div class="form-group">
                    <label for="pf-date-to">${filterLabelHtml('Criação até')}</label>
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

    // Lembra os filtros entre navegações (ex.: ir pro Funil e voltar).
    state.proposalFilters = state.proposalFilters || {};
    // Status: multi-seleção (array de valores). Os demais são texto simples.
    const _pfStatusSel = Array.isArray(state.proposalFilters.statusMulti) ? state.proposalFilters.statusMulti.slice() : [];
    const persistProposalFilters = () => {
        ['pf-search', 'pf-cidade', 'pf-atrasada', 'pf-period', 'pf-vendor', 'pf-date-from', 'pf-date-to']
            .forEach((id) => { const el = document.getElementById(id); if (el) state.proposalFilters[id] = el.value; });
        state.proposalFilters.statusMulti = _pfStatusSel.slice();
    };

    const renderFiltered = async () => {
        persistProposalFilters();
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
        const cidade    = document.getElementById('pf-cidade')?.value || '';
        const atrasada  = document.getElementById('pf-atrasada')?.value || '';
        const period    = document.getElementById('pf-period')?.value || '';
        const vendor    = document.getElementById('pf-vendor')?.value || '';
        const dateFrom  = document.getElementById('pf-date-from')?.value || '';
        const dateTo    = document.getElementById('pf-date-to')?.value || '';
        const { start: periodStart, end: periodEnd } = getDateRangeForPeriod(period);

        const filtered = normalized.filter((p) => {
            const matchSearch   = !search  || [p.cliente, p.cidade, p.obs, p.vendedor, p.foco].some((v) => String(v || '').toLowerCase().includes(search));
            const matchStatus   = !_pfStatusSel.length || _pfStatusSel.includes(p.status);
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
            const da = parseDisplayDate(a.data) || parseDisplayDate(a.atualizacao);
            const db = parseDisplayDate(b.data) || parseDisplayDate(b.atualizacao);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });

        const byMonth = sorted.reduce((groups, p) => {
            const d = parseDisplayDate(p.data) || parseDisplayDate(p.atualizacao);
            const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'Sem data';
            if (!groups[key]) { groups[key] = []; }
            groups[key].push(p);
            return groups;
        }, {});

        const groupsHtml = Object.keys(byMonth).sort((a, b) => b.localeCompare(a)).map((key) => `
            <section class="visit-month-group">
                <div class="visit-month-header">
                    <h3>${escapeHtml(formatMonthKey(key))}</h3>
                    <span>${byMonth[key].length} proposta(s)</span>
                </div>
                <div class="visits-list">${byMonth[key].map((p) => `
                    <button type="button" class="proposal-card ${p.atrasada ? 'proposal-card-alert' : ''}" data-proposal-id="${escapeHtml(p.id)}">
                        <div class="visit-card-header">
                            <strong>
                                <span aria-hidden="true">${proposalStatusIcon(p.status)}</span> ${escapeHtml(p.cliente || 'Cliente não informado')}
                                <span class="card-quick-edit-btn" role="button" tabindex="0" aria-label="Atualização rápida" title="Atualização rápida" data-proposal-quick="${escapeHtml(p.id)}">⚡</span>
                                ${state.canCreateProposalFunil && p.cliente ? (() => {
                                    const _fi = funilItemForProposta(p.cliente, p.foco);
                                    if (!_fi) {
                                        return `<span class="card-to-funil-btn" role="button" tabindex="0" aria-label="Adicionar ao Funil de Vendas" title="Adicionar ao Funil de Vendas" data-proposal-funil="${escapeHtml(p.id)}" data-cliente="${escapeHtml(p.cliente || '')}" data-cidade="${escapeHtml(p.cidade || '')}" data-foco="${escapeHtml(p.foco || '')}">📊</span>`;
                                    }
                                    const _alerta = funilEmAlerta(_fi);
                                    const _st = escapeHtml(String(_fi.status || _fi.Status || ''));
                                    return `<span class="card-in-funil${_alerta ? ' card-in-funil-alert' : ''}" role="button" tabindex="0" aria-label="Cliente já está no Funil de Vendas" title="No Funil${_st ? ' (' + _st + ')' : ''} — abrir" data-funil-id="${escapeHtml(String(_fi.id || _fi.Id || ''))}">${_alerta ? '⚠️' : '✅'}</span>`;
                                })() : ''}
                            </strong>
                            ${p._pending ? '<span class="pending-badge" title="Aguardando conexão para enviar">⏳ Pendente</span>' : `<span class="${proposalStatusClass(p.status, p.atrasada)} status-pill-editable" role="button" tabindex="0" aria-label="Alterar status da proposta, atual: ${escapeHtml(p.status || '-')}" data-inline-status="${escapeHtml(p.id)}" data-current-status="${escapeHtml(p.status || '')}">${escapeHtml(p.status || '-')}</span>`}
                        </div>
                        <div class="proposal-meta">
                            <span>${escapeHtml([p.cidade, p.foco].filter(Boolean).join(' · ') || '-')}</span>
                            <span>${isAdmGer && p.vendedor ? escapeHtml(p.vendedor) + ' · ' : ''}${escapeHtml(p.atualizacao || '-')}</span>
                        </div>
                        ${p.atrasada ? '<div class="alert-text">Sem atualização há mais de 30 dias.</div>' : ''}
                    </button>
                `).join('')}</div>
            </section>
        `).join('');

        if (qeActive()) {
            container.classList.add('qe-layout');
            container.innerHTML = `
                <div class="qe-list">${groupsHtml}</div>
                <div class="qe-panel" id="qe-panel">
                    <p class="helper-text" style="padding:1.25rem;text-align:left">Clique numa proposta da lista para editar aqui — o painel fica fixo, é só ir clicando de uma pra outra.</p>
                </div>`;
        } else {
            container.classList.remove('qe-layout');
            container.innerHTML = groupsHtml;
        }

        container.querySelectorAll('[data-proposal-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (qeActive()) { openProposalQuickPanel(btn.dataset.proposalId); return; }
                navigateTo('proposal-detail', { id: btn.dataset.proposalId });
            });
        });
        container.querySelectorAll('.status-pill-editable').forEach(pill => {
            pill.addEventListener('click', (e) => {
                e.stopPropagation();
                openInlineStatusEditor(pill, pill.dataset.inlineStatus, pill.dataset.currentStatus);
            });
        });
        container.querySelectorAll('[data-proposal-quick]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = normalized.find((p) => String(p.id) === el.dataset.proposalQuick);
                if (item) openProposalQuickUpdateModal(item, renderFiltered);
            });
        });
        container.querySelectorAll('[data-proposal-funil]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                state.funilPrefill = { cliente: el.dataset.cliente || '', cidade: el.dataset.cidade || '', foco: el.dataset.foco || '', atuacao: '' };
                navigateTo('funil-new');
            });
        });
        container.querySelectorAll('[data-funil-id]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = el.dataset.funilId;
                if (id) navigateTo('funil-detail', { id });
                else navigateTo('funil');
            });
        });

        if (qeActive() && qeSelectedId) { openProposalQuickPanel(qeSelectedId); }
    };

    async function openProposalQuickPanel(id) {
        const panel = document.getElementById('qe-panel');
        if (!panel) { return; }
        const p = normalized.find((x) => String(x.id) === String(id));
        if (!p) { return; }
        qeSelectedId = String(id);
        document.querySelectorAll('#proposal-list-container .proposal-card').forEach((c) => {
            c.classList.toggle('qe-selected', c.dataset.proposalId === qeSelectedId);
        });
        // Best-effort: sem formData ainda carregado, Cidade/Foco caem pra
        // input de texto simples (sem travar o painel numa espera).
        const fd = state.formData || (await ensureFormData().then((r) => r.data).catch(() => null));
        const listaCidades = (fd && fd.cidades) || [];
        const listaFoco = (fd && fd.potenciaisCliente) || [];
        if (String(qeSelectedId) !== String(id) || document.getElementById('qe-panel') !== panel) { return; }

        const searchField = (label, fieldId, value, items) => `
            <div><span>${label}</span>
                <div class="searchable-select">
                    <input type="text" id="${fieldId}" value="${escapeHtml(value || '')}" autocomplete="off">
                    ${items ? `<div class="searchable-select-menu" id="${fieldId}-menu"></div>` : ''}
                </div>
            </div>`;

        const STAT = ['Enviada', 'Em negociacao', 'Ganhamos', 'Perdido'];
        panel.innerHTML = `
            <div class="qe-panel-inner">
                <strong class="qe-panel-title">${escapeHtml(p.cliente || 'Cliente')}</strong>
                <p class="helper-text" style="margin:0.15rem 0 0.6rem;text-align:left">${escapeHtml([p.cidade, p.vendedor, p.atualizacao].filter(Boolean).join(' · '))}</p>
                <div class="qe-info qe-info-edit">
                    ${searchField('Cidade', 'qe-cidade', p.cidade, listaCidades)}
                    ${searchField('Foco', 'qe-foco', p.foco, listaFoco)}
                    <div><span>Produtos</span><input type="text" id="qe-produtos" value="${escapeHtml(p.produtos || '')}"></div>
                </div>
                <label>Status</label>
                <div class="qe-status-row">
                    ${STAT.map((s) => `<button type="button" class="qe-status-btn${s === (p.status || '') ? ' is-active' : ''}" data-s="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
                </div>
                <label style="margin-top:0.7rem">Atualizar / OBS</label>
                <textarea id="qe-obs" rows="8">${escapeHtml(withDatedNoteHeader(p.obs))}</textarea>
                <div style="display:flex;gap:0.5rem;margin-top:0.7rem">
                    <button type="button" class="primary-button" id="qe-save" style="flex:2">Salvar</button>
                    <button type="button" class="secondary-button" id="qe-full" style="flex:1" title="Abrir a edição completa desta proposta">Editar tudo</button>
                </div>
            </div>`;

        initializeSearchableInput({ input: panel.querySelector('#qe-cidade'), menu: panel.querySelector('#qe-cidade-menu'), items: listaCidades, allowFreeText: true });
        initializeSearchableInput({ input: panel.querySelector('#qe-foco'), menu: panel.querySelector('#qe-foco-menu'), items: listaFoco, allowFreeText: true });

        let selStatus = p.status || 'Enviada';
        panel.querySelectorAll('.qe-status-btn').forEach((b) => b.addEventListener('click', () => {
            selStatus = b.dataset.s;
            panel.querySelectorAll('.qe-status-btn').forEach((x) => x.classList.toggle('is-active', x === b));
        }));
        const ta = panel.querySelector('#qe-obs');
        const hl = datedNoteHeader().length;
        setTimeout(() => { ta.focus(); try { ta.setSelectionRange(hl, hl); } catch (e) {} }, 20);

        panel.querySelector('#qe-full').addEventListener('click', () => navigateTo('proposal-edit', { proposal: p }));

        panel.querySelector('#qe-save').addEventListener('click', () => {
            const obs = stripEmptyDatedLine(ta.value);
            const cidade = panel.querySelector('#qe-cidade')?.value.trim();
            const foco = panel.querySelector('#qe-foco')?.value.trim();
            const produtos = panel.querySelector('#qe-produtos')?.value.trim();
            setSaving(true, panel.querySelector('#qe-save'), 'Salvando...');
            showToast('Salvo.');
            applyProposalQuickPatch(p, { status: selStatus, obs, cidade, foco, produtos }, () => {
                normalized = state.proposals.map(normalizeProposal);
                renderFiltered();
            });
        });
    }

    const _proposalFilterIds = ['pf-search', 'pf-cidade', 'pf-atrasada', 'pf-period', 'pf-vendor',
        'pf-date-from', 'pf-date-to'];
    const initStatusFilter = () => initializeSearchableInput({
        input: document.getElementById('pf-status'),
        menu: document.getElementById('pf-status-menu'),
        items: availableStatuses,
        multiSelect: true,
        maxSelections: 99,
        selectedItems: _pfStatusSel,
        selectedContainer: document.getElementById('pf-status-selected'),
        selectionLabel: 'status',
        onSelectionChange: () => renderFiltered()
    });
    initStatusFilter();
    initializeSearchableInput({ input: document.getElementById('pf-cidade'), menu: document.getElementById('pf-cidade-menu'), items: availableCities });
    if (isAdmGer) {
        initializeSearchableInput({ input: document.getElementById('pf-vendor'), menu: document.getElementById('pf-vendor-menu'), items: availableVendors });
    }

    // Restaura os filtros lembrados da última visita a esta tela.
    _proposalFilterIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el && state.proposalFilters[id]) el.value = state.proposalFilters[id];
    });

    const _proposalTextFilterIds = new Set(['pf-search', 'pf-cidade', 'pf-vendor']);
    const _debouncedProposalFilter = debounce(renderFiltered, 250);
    _proposalFilterIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (_proposalTextFilterIds.has(id)) { el.addEventListener('input', _debouncedProposalFilter); }
        // 'change' cobre <select> e o clique numa opção do searchable-select
        // (Status/Cidade/Vendedor), que só dispara 'change'.
        el.addEventListener('change', renderFiltered);
    });

    document.getElementById('proposal-filter-clear')?.addEventListener('click', () => {
        _proposalFilterIds.forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; } });
        _pfStatusSel.length = 0;
        const pfStatusInput = document.getElementById('pf-status');
        if (pfStatusInput) pfStatusInput.value = '';
        const pfStatusSelEl = document.getElementById('pf-status-selected');
        if (pfStatusSelEl) pfStatusSelEl.innerHTML = '';
        state.proposalFilters = {};
        state.proposalsYearFilter = null;
        renderFiltered();
        updateYearChips();
    });

    renderSavedFilters(document.getElementById('proposal-saved-filters'), 'proposals', _proposalFilterIds, (values) => {
        _proposalFilterIds.forEach((id) => { const el = document.getElementById(id); if (el) { el.value = values[id] || ''; } });
        renderFiltered();
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
                initializeSearchableInput({
                    input: document.getElementById('pf-status'),
                    menu: document.getElementById('pf-status-menu'),
                    items: Array.from(new Set(normalized.map((p) => p.status).filter(Boolean))),
                    multiSelect: true, maxSelections: 99, selectedItems: _pfStatusSel,
                    selectedContainer: document.getElementById('pf-status-selected'),
                    selectionLabel: 'status', onSelectionChange: () => renderFiltered()
                });
                initializeSearchableInput({ input: document.getElementById('pf-cidade'), menu: document.getElementById('pf-cidade-menu'), items: Array.from(new Set(normalized.map((p) => p.cidade).filter(Boolean))).sort() });
                if (isAdmGer) initializeSearchableInput({ input: document.getElementById('pf-vendor'), menu: document.getElementById('pf-vendor-menu'), items: Array.from(new Set(normalized.map((p) => p.vendedor).filter(Boolean))).sort() });
                renderFiltered();
                updateYearChips();
            }
        } catch(e) {}
    });

    document.getElementById('btn-new-proposal')?.addEventListener('click', () => navigateTo('proposal-new'));
    document.getElementById('qe-toggle')?.addEventListener('click', (e) => {
        quickEdit = !quickEdit;
        try { localStorage.setItem('proposals_quick_edit', quickEdit ? '1' : '0'); } catch (err) {}
        e.currentTarget.classList.toggle('is-on', quickEdit);
        qeSelectedId = null;
        renderFiltered();
    });
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

    // Carrega o Funil em 2º plano só pra marcar os clientes que já estão
    // nele (botão ✅). Re-renderiza a lista quando chegar.
    if (state.canCreateProposalFunil && (!Array.isArray(state.funil) || !state.funil.length)) {
        ensureFunilForDedup().then(() => {
            if (state.currentPage === 'proposals') renderFiltered();
        });
    }

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
        addScrollTop();

        initSearchBarAutoHide();
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
    addScrollTop();

    initSearchBarAutoHide();
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
    // A lista deixa um botão de "voltar ao topo" pra trás (só o próprio
    // addScrollTop remove o anterior, e essa página não chama de novo).
    document.getElementById('page-scroll-top')?.remove();
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

    if (state.canCreateProposalFunil) { await ensureFunilForDedup(); }
    const funilDoCliente = funilItemForProposta(proposal.cliente, proposal.foco);
    const funilAlerta = funilEmAlerta(funilDoCliente);
    const funilStatusTxt = escapeHtml(String((funilDoCliente && (funilDoCliente.status || funilDoCliente.Status)) || ''));

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Propostas', page: 'proposals' }, { label: proposal.cliente || 'Proposta' }])}
        <div class="page-header compact-header">
            <button type="button" id="back-proposals" style="background:none;border:none;color:#64748B;font-size:0.87rem;cursor:pointer;display:flex;align-items:center;gap:0.3rem;padding:0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15,18 9,12 15,6"/></svg>
                Voltar
            </button>
            <h2>Detalhes da Proposta</h2>
            <div class="header-actions-group">
                ${proposal.cliente ? `<button type="button" class="mini-button mini-button-icon" id="proposal-c360" aria-label="Cliente 360°" title="Ver histórico completo do cliente">${actionIcon('user')}</button>` : ''}
                ${proposal.cliente && state.canCreateProposalFunil ? (funilDoCliente
                    ? `<button type="button" class="mini-button ${funilAlerta ? 'mini-button-danger' : ''}" id="proposal-in-funil" title="Já no Funil${funilStatusTxt ? ' (' + funilStatusTxt + ')' : ''} — abrir">${actionIcon(funilAlerta ? 'alert' : 'check', 15)} No Funil${funilAlerta && funilStatusTxt ? ' · ' + funilStatusTxt : ''}</button>`
                    : `<button type="button" class="mini-button" id="proposal-to-funil" title="Adicionar este cliente ao Funil de Vendas">${actionIcon('funnel', 15)} Ao Funil</button>`) : ''}
                <button type="button" class="mini-button" id="edit-proposal">Editar</button>
                <button type="button" class="mini-button mini-button-icon mini-button-whatsapp" id="share-proposal-whatsapp" aria-label="Compartilhar no WhatsApp" title="Compartilhar no WhatsApp">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                </button>
                ${state.canDelete ? `<button type="button" class="mini-button mini-button-icon mini-button-danger" id="delete-proposal" aria-label="Apagar" title="Apagar">${actionIcon('trash')}</button>` : ''}
            </div>
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
    `;

    document.getElementById('back-proposals').addEventListener('click', () => navigateTo('proposals'));
    document.getElementById('edit-proposal').addEventListener('click', () => navigateTo('proposal-edit', { proposal }));
    document.getElementById('proposal-c360')?.addEventListener('click', () => navigateTo('cliente-360', { cliente: proposal.cliente }));
    document.getElementById('proposal-to-funil')?.addEventListener('click', () => {
        state.funilPrefill = {
            cliente: proposal.cliente || '',
            cidade: proposal.cidade || '',
            foco: proposal.foco || '',
            atuacao: ''
        };
        navigateTo('funil-new');
    });
    document.getElementById('proposal-in-funil')?.addEventListener('click', () => {
        const id = funilDoCliente && (funilDoCliente.id || funilDoCliente.Id);
        if (id) navigateTo('funil-detail', { id: String(id) });
        else navigateTo('funil');
    });
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
            // state.proposals guarda itens crus do servidor (chave Id)
            // misturados com criados localmente (chave id) — checa as duas.
            state.proposals = state.proposals.filter((p) => String(p.Id || p.id) !== String(proposal.id));
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
    const isAdminUser = String(state.currentUser.profile || '').trim().toLowerCase() === 'admin';

    let cidades = [];
    let potenciais = [];
    if (isAdminUser) {
        const fdResult = await ensureFormData();
        cidades = (fdResult.data && fdResult.data.cidades) || [];
        potenciais = (fdResult.data && fdResult.data.potenciaisCliente) || [];
    }

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-proposal-detail">Voltar</button>
            <h2>Atualizar Proposta</h2>
        </div>
        <form id="proposal-form" class="card form-card form-layout form-layout-stack">
            <input type="hidden" id="proposal-id" value="${escapeHtml(normalized.id)}">
            ${isAdminUser ? `
            <div class="form-group full-width">
                <label for="proposal-cliente">Cliente</label>
                <input type="text" id="proposal-cliente" value="${escapeHtml(normalized.cliente)}" required>
            </div>
            <div class="form-group">
                <label for="proposal-cidade">Cidade</label>
                <div class="searchable-select">
                    <input type="text" id="proposal-cidade" value="${escapeHtml(normalized.cidade)}" placeholder="Pesquise a cidade" autocomplete="off">
                    <div class="searchable-select-menu" id="proposal-cidade-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="proposal-vendedor">Vendedor</label>
                <input type="text" id="proposal-vendedor" value="${escapeHtml(normalized.vendedor)}">
            </div>
            <div class="form-group">
                <label for="proposal-gerencia">Gerência</label>
                <input type="text" id="proposal-gerencia" value="${escapeHtml(normalized.gerencia)}">
            </div>
            <div class="form-group">
                <label for="proposal-foco">Potencial</label>
                <div class="searchable-select">
                    <input type="text" id="proposal-foco" value="${escapeHtml(normalized.foco)}" placeholder="Pesquise o potencial" autocomplete="off">
                    <div class="searchable-select-menu" id="proposal-foco-menu"></div>
                </div>
            </div>
            <div class="form-group full-width">
                <label for="proposal-produtos">Produtos</label>
                <input type="text" id="proposal-produtos" value="${escapeHtml(normalized.produtos)}">
            </div>
            <div class="form-group">
                <label for="proposal-data">Data</label>
                <input type="date" id="proposal-data" value="${escapeHtml(formatInputDateFromDisplay(normalized.data) || '')}">
            </div>
            <div class="form-group">
                <label for="proposal-data-limite">Data Limite</label>
                <input type="date" id="proposal-data-limite" value="${escapeHtml(formatInputDateFromDisplay(normalized.dataLimite) || '')}">
            </div>
            <div class="form-group full-width">
                <label for="proposal-email">E-mail</label>
                <input type="email" id="proposal-email" value="${escapeHtml(normalized.email)}">
            </div>
            ` : `
            <div class="form-group full-width readonly-group">
                <label>Cliente</label>
                <input type="text" value="${escapeHtml(normalized.cliente)}" readonly>
            </div>
            `}
            <div class="form-group">
                <label for="proposal-status">Status</label>
                <select id="proposal-status" required>
                    ${renderSimpleOptions(['Enviada', 'Em negociacao', 'Ganhamos', 'Perdido'], normalized.status)}
                </select>
            </div>
            <div class="form-group full-width">
                <label for="proposal-obs">Atualizar / OBS</label>
                <textarea id="proposal-obs" rows="5">${escapeHtml(withDatedNoteHeader(normalized.obs))}</textarea>
            </div>
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-proposal">Cancelar</button>
                <button type="submit" id="save-proposal">Salvar Alterações</button>
            </div>
        </form>
    `;

    if (isAdminUser) {
        initializeSearchableInput({
            input: document.getElementById('proposal-cidade'),
            menu: document.getElementById('proposal-cidade-menu'),
            items: cidades
        });
        initializeSearchableInput({
            input: document.getElementById('proposal-foco'),
            menu: document.getElementById('proposal-foco-menu'),
            items: potenciais
        });
    }

    document.getElementById('back-proposal-detail').addEventListener('click', () => navigateTo('proposal-detail', { id: normalized.id }));
    document.getElementById('cancel-proposal').addEventListener('click', () => navigateTo('proposal-detail', { id: normalized.id }));

    document.getElementById('proposal-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = document.getElementById('save-proposal');
        setSaving(true, button, 'Salvando...');

        const newStatus = document.getElementById('proposal-status').value;
        const newObs = stripEmptyDatedLine(document.getElementById('proposal-obs').value);
        const proposalId = normalized.id;

        const adminFields = isAdminUser ? {
            cliente: document.getElementById('proposal-cliente').value.trim(),
            cidade: document.getElementById('proposal-cidade').value.trim(),
            vendedor: document.getElementById('proposal-vendedor').value.trim(),
            gerencia: document.getElementById('proposal-gerencia').value.trim(),
            foco: document.getElementById('proposal-foco').value.trim(),
            produtos: document.getElementById('proposal-produtos').value.trim(),
            data: document.getElementById('proposal-data').value,
            dataLimite: document.getElementById('proposal-data-limite').value,
            email: document.getElementById('proposal-email').value.trim()
        } : {};

        // Optimistic update: reflect changes immediately in state + cache
        const idx = state.proposals.findIndex((p) => String(p.Id || p.id) === String(proposalId));
        const original = idx >= 0 ? { ...state.proposals[idx] } : null;
        const nowDisplay = formatDateForDisplay(new Date());
        if (idx >= 0) {
            state.proposals[idx] = {
                ...state.proposals[idx],
                status: newStatus, Status: newStatus,
                obs: newObs, Obs: newObs,
                atualizacao: nowDisplay, Atualizacao: nowDisplay,
                ...(isAdminUser ? {
                    cliente: adminFields.cliente, Cliente: adminFields.cliente,
                    cidade: adminFields.cidade, Cidade: adminFields.cidade,
                    vendedor: adminFields.vendedor, Vendedor: adminFields.vendedor,
                    gerencia: adminFields.gerencia, Gerencia: adminFields.gerencia,
                    foco: adminFields.foco, Foco: adminFields.foco,
                    produtos: adminFields.produtos, Produtos: adminFields.produtos,
                    data: formatDateFromDisplay(adminFields.data), Data: formatDateFromDisplay(adminFields.data),
                    dataLimite: formatDateFromDisplay(adminFields.dataLimite), 'Data Limite': formatDateFromDisplay(adminFields.dataLimite),
                    email: adminFields.email, 'E-mail': adminFields.email
                } : {})
            };
            saveCache('proposals', state.proposals);
        }

        // Navigate immediately — user sees updated data right away
        navigateTo('proposal-detail', { id: proposalId });
        showToast('Proposta atualizada.');

        // API call in background
        attemptOrQueue('updateProposal', { id: proposalId, status: newStatus, obs: newObs, user: state.currentUser, ...adminFields },
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
    const clientes = (fdResult.data && fdResult.data.clientes) || [];

    const dataLimite30 = new Date();
    dataLimite30.setDate(dataLimite30.getDate() + 30);
    const defaultDataLimite = dataLimite30.toISOString().slice(0, 10);

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-proposal-create">Voltar</button>
            <h2>Nova Proposta</h2>
            <span></span>
        </div>
        <form id="proposal-create-form" class="card form-card form-layout form-layout-stack">
            <div class="form-group full-width">
                <label for="pc-cliente">Cliente *</label>
                <div class="searchable-select">
                    <input type="text" id="pc-cliente" placeholder="Busque ou digite o cliente" autocomplete="off" required>
                    <div class="searchable-select-menu" id="pc-cliente-menu"></div>
                </div>
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
                <label for="pc-obs">Observações</label>
                <textarea id="pc-obs" rows="4" placeholder="Detalhes da proposta">${escapeHtml(withDatedNoteHeader(''))}</textarea>
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
    // Escolher um cliente já cadastrado preenche cidade e potencial sozinho
    // — allowFreeText porque a proposta também vale pra quem ainda não tem
    // cadastro (prospecção).
    initializeSearchableInput({
        input: document.getElementById('pc-cliente'),
        menu: document.getElementById('pc-cliente-menu'),
        items: clientes.map((c) => c.nome).filter(Boolean),
        allowFreeText: true,
        onSelect: (value) => {
            const match = clientes.find((c) => String(c.nome || '').trim().toLowerCase() === String(value || '').trim().toLowerCase());
            if (!match) return;
            if (match.cidade) document.getElementById('pc-cidade').value = match.cidade;
            if (match.potencialCliente) document.getElementById('pc-foco').value = match.potencialCliente;
        }
    });

    // Observações já abre com "dd/mm/aaaa - " (igual à edição rápida) — só
    // posiciona o cursor depois do cabeçalho pra quando o campo ganhar foco.
    {
        const pcObs = document.getElementById('pc-obs');
        const pcHeadLen = datedNoteHeader().length;
        try { pcObs.setSelectionRange(pcHeadLen, pcHeadLen); } catch (e) {}
    }

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
        const obsVal      = stripEmptyDatedLine(document.getElementById('pc-obs').value);

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


// Atualização rápida (status + obs) direto da lista, sem navegar pra tela
// de edição completa — reaproveita o mesmo .modal-overlay/.modal-card já
// usado em outras telas (ex.: showScheduleReturnModal em visits.js).
function openProposalQuickUpdateModal(p, onUpdated) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left">
            <h3 style="margin-top:0">Atualizar — ${escapeHtml(p.cliente || 'Cliente')}</h3>
            <p class="helper-text" style="margin:-0.4rem 0 0.7rem">Data da atualização: <strong>${escapeHtml(formatDateForDisplay(new Date()))}</strong></p>
            <div class="qe-info">
                <div><span>Foco</span>${escapeHtml(p.foco || '-')}</div>
                <div><span>Produtos</span>${escapeHtml(p.produtos || '-')}</div>
            </div>
            <div class="form-group full-width">
                <label for="pq-status">Status</label>
                <select id="pq-status">${renderSimpleOptions(['Enviada', 'Em negociacao', 'Ganhamos', 'Perdido'], p.status)}</select>
            </div>
            <div class="form-group full-width">
                <label for="pq-obs">Atualizar / OBS</label>
                <textarea id="pq-obs" rows="5">${escapeHtml(withDatedNoteHeader(p.obs))}</textarea>
            </div>
            <div class="form-actions full-width" style="display:flex;gap:0.5rem;margin-top:0.5rem">
                <button type="button" class="secondary-button" id="pq-cancel">Cancelar</button>
                <button type="button" class="primary-button" id="pq-save">Salvar</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#pq-cancel').addEventListener('click', close);
    // Cursor logo depois do "DD/MM/AAAA - " pra já sair digitando a anotação.
    const _pqTa = overlay.querySelector('#pq-obs');
    const _pqHeadLen = datedNoteHeader().length;
    setTimeout(() => { _pqTa.focus(); _pqTa.setSelectionRange(_pqHeadLen, _pqHeadLen); }, 30);
    overlay.querySelector('#pq-save').addEventListener('click', async () => {
        const newStatus = overlay.querySelector('#pq-status').value;
        const newObs = stripEmptyDatedLine(overlay.querySelector('#pq-obs').value);
        close();
        showToast('Proposta atualizada.');
        if (onUpdated) onUpdated();
        applyProposalQuickPatch(p, { status: newStatus, obs: newObs }, onUpdated);
    });
}

// Update otimista + attemptOrQueue + rollback compartilhado entre o modal de
// atualização rápida e o painel de edição rápida (split view do admin).
function applyProposalQuickPatch(p, patch, onDone) {
    const { status, obs, cidade, foco, produtos } = patch;
    // Cidade/Foco/Produtos só chegam preenchidos quando o painel tinha os
    // campos (admin) — undefined não sobrescreve o que já tinha.
    const camposLivres = {};
    if (cidade !== undefined) { camposLivres.cidade = cidade; camposLivres.Cidade = cidade; }
    if (foco !== undefined) { camposLivres.foco = foco; camposLivres.Foco = foco; }
    if (produtos !== undefined) { camposLivres.produtos = produtos; camposLivres.Produtos = produtos; }
    const idx = state.proposals.findIndex((item) => String(item.Id || item.id) === String(p.id));
    const original = idx >= 0 ? { ...state.proposals[idx] } : null;
    const nowDisplay = formatDateForDisplay(new Date());
    if (idx >= 0) {
        state.proposals[idx] = {
            ...state.proposals[idx],
            status, Status: status,
            obs, Obs: obs,
            ...camposLivres,
            atualizacao: nowDisplay, Atualizacao: nowDisplay
        };
        saveCache('proposals', state.proposals);
    }
    // `p` é o objeto normalizado da lista (referência separada da de
    // state.proposals) — mutar aqui também pra o re-render pegar o novo valor.
    p.status = status;
    p.obs = obs;
    if (cidade !== undefined) p.cidade = cidade;
    if (foco !== undefined) p.foco = foco;
    if (produtos !== undefined) p.produtos = produtos;
    p.atualizacao = nowDisplay;
    p.atrasada = false;
    if (onDone) onDone();

    return attemptOrQueue('updateProposal', { id: p.id, status, obs, ...camposLivres, user: state.currentUser },
        { entity: 'proposals', tempId: p.id })
        .then((result) => {
            if (result && result.status === 'success') {
                trackUpdate('proposals', { id: p.id, cliente: p.cliente, status });
            } else if (result && result.status === 'queued') {
                if (idx >= 0) { state.proposals[idx] = { ...state.proposals[idx], _pending: true }; saveCache('proposals', state.proposals); }
                showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                trackUpdate('proposals', { id: p.id, cliente: p.cliente, status });
                if (onDone) onDone();
            } else {
                if (idx >= 0 && original) { state.proposals[idx] = original; saveCache('proposals', state.proposals); }
                showToast((result && result.message) || 'Erro ao salvar. Tente novamente.', true);
                if (onDone) onDone();
            }
            return result;
        })
        .catch(() => {
            if (idx >= 0 && original) { state.proposals[idx] = original; saveCache('proposals', state.proposals); }
            showToast('Erro ao salvar. Tente novamente.', true);
            if (onDone) onDone();
        });
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