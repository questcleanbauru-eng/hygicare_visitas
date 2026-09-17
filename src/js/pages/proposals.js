import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, getSyncTimestamp, setSyncTimestamp, mergeById, attemptOrQueue } from '../api.js';
import {
    escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, parseInputDate,
    formatMonthKey, normalizeProposal, proposalStatusClass, formatDateForDisplay, titleCase, proposalStatusIcon, filterLabelHtml,
    formatInputDateFromDisplay, formatDateFromDisplay,
    datedNoteHeader, withDatedNoteHeader, stripEmptyDatedLine, selectNoteHint,
    clienteSearchItem, findClienteByNome, multiCheckFilterFieldHtml
} from '../utils/format.js';
import {
    debounce, renderDetailRow, actionIcon, showToast, renderSimpleOptions,
    initializeSearchableInput, showRefreshIndicator, hideRefreshIndicator, skeletonDetail,
    loadingState, addScrollTop, openExternal, renderYearChips, setSaving, preventEnterSubmit,
    wireMultiCheckFilter, syncMultiCheckFilterLabel
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, updateProposalsBadge, ensureStyles, initSearchBarAutoHide } from '../utils/ui.js';
import { trackUpdate, getSummaryCount, openSummaryModal } from '../utils/updateSummary.js';
import { ensureFunilForDedup, funilItemFor as funilItemForProposta, funilEmAlerta } from '../utils/funilLink.js';
import { openLinkPickerModal } from '../utils/linkPicker.js';
import { downloadXLSX } from '../utils/xlsxWriter.js';

export function fillProposalsContent(mainContent, proposals) {
    let normalized = (proposals || []).map(normalizeProposal);
    const isAdmGer = isAdminOrGerenteUser();
    const isAdmin  = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    // Edição rápida (só admin, só desktop): lista + painel de edição na mesma
    // tela — atualiza uma proposta atrás da outra sem abrir/voltar.
    let quickEdit = isAdmin && (() => { try { return localStorage.getItem('proposals_quick_edit') === '1'; } catch (e) { return false; } })();
    let qeSelectedId = null;
    const qeActive = () => quickEdit && isAdmin && window.innerWidth >= 1024;
    let _propsCampanhaList = [];
    // "Duplicado" = mesmo cliente + mesmo foco (mesmo critério do Funil).
    const propostaDupKey = (p) => [p.cliente, p.foco]
        .map((v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')).join('|');
    // Modo seleção: marcar várias propostas e apagar de uma vez (limpar
    // duplicados de reimportação, principalmente). Só pra quem pode apagar.
    let selectMode = false;
    const selectedIds = new Set();

    const btnNovaProposta = (id) => state.canCreateProposalFunil ? `<button type="button" class="primary-btn" id="${id}">+ Nova Proposta</button>` : '';

    if (normalized.length === 0) {
        const scopeIsLimited = state.proposalsScope && state.proposalsScope !== 'all';
        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Propostas</h2></div>
                ${btnNovaProposta('btn-new-proposal')}
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
                       ${btnNovaProposta('btn-new-proposal2')}`
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
            <div class="page-header-actions">
                ${state.canDelete ? '<button type="button" class="text-link" id="proposal-select-toggle" title="Marcar várias propostas para apagar de uma vez">☑️ Selecionar</button>' : ''}
                ${isAdmGer ? '<button type="button" class="text-link" id="proposals-campanha-btn" title="Gerar link para um vendedor atualizar clientes">🔗 Campanha</button>' : ''}
                ${isAdmin ? `<button type="button" class="text-link qe-toggle${quickEdit ? ' is-on' : ''}" id="qe-toggle" title="Editar na mesma tela, uma proposta após a outra">⚡ Edição rápida</button>` : ''}
                ${btnNovaProposta('btn-new-proposal')}
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
        </div>
        <div class="card visits-filter-card">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    ${isAdmin ? `<button type="button" class="text-link" id="proposals-csv-btn" title="Baixar Excel das propostas filtradas">📥 Excel</button>` : ''}
                    <button type="button" class="text-link" id="proposal-filter-clear">Limpar</button>
                    <button type="button" class="mini-button" id="proposal-filter-toggle">Ocultar</button>
                </div>
            </div>
            <div class="visits-filter-grid" id="proposal-filter-panel">
                ${multiCheckFilterFieldHtml('Status', 'pf-status')}
                ${multiCheckFilterFieldHtml('Cidade', 'pf-cidade', 'Todas')}
                <div class="form-group">
                    <label for="pf-atrasada">${filterLabelHtml('Situação')}</label>
                    <select id="pf-atrasada">
                        <option value="">Todas</option>
                        <option value="sim">Atrasadas</option>
                        <option value="nao">Em dia</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="pf-dup">${filterLabelHtml('Duplicidade')}</label>
                    <select id="pf-dup">
                        <option value="">Todas</option>
                        <option value="sim">Só duplicadas (mesmo cliente + foco)</option>
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
                ${isAdmGer ? multiCheckFilterFieldHtml('Vendedor', 'pf-vendor') : ''}
                <div class="form-group">
                    <label for="pf-date-from">${filterLabelHtml('Criação de')}</label>
                    <input type="date" id="pf-date-from">
                </div>
                <div class="form-group">
                    <label for="pf-date-to">${filterLabelHtml('Criação até')}</label>
                    <input type="date" id="pf-date-to">
                </div>
                <div id="proposal-year-chips" class="year-chips-row"></div>
                <div class="scope-banner scope-days-ctrl">
                    <label for="scope-dias-input">Período:</label>
                    <input type="number" id="scope-dias-input" class="scope-dias-input" value="${state.loadDias || 90}" min="1" max="365">
                    <span>dias</span>
                    <button type="button" id="scope-load-days" class="scope-days-load-btn">Carregar</button>
                    <button type="button" id="scope-load-all" class="scope-load-btn">Ver tudo</button>
                </div>
            </div>
        </div>
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

    // Lembra os filtros entre navegações (ex.: ir pro Funil e voltar) — Status/
    // Cidade/Vendedor guardam string separada por vírgula (ver
    // wireMultiCheckFilter, dom.js), então contam como texto simples igual
    // aos outros campos.
    state.proposalFilters = state.proposalFilters || {};
    const persistProposalFilters = () => {
        ['pf-search', 'pf-status', 'pf-cidade', 'pf-atrasada', 'pf-dup', 'pf-period', 'pf-vendor', 'pf-date-from', 'pf-date-to']
            .forEach((id) => { const el = document.getElementById(id); if (el) state.proposalFilters[id] = el.value; });
    };

    // Guarda a última lista filtrada pro botão "Excel" exportar exatamente o
    // que está na tela, não a base inteira.
    let lastFilteredProposals = [];

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
        const statusSel = (document.getElementById('pf-status')?.value || '').split(',').filter(Boolean);
        const cidade    = (document.getElementById('pf-cidade')?.value || '').split(',').filter(Boolean);
        const atrasada  = document.getElementById('pf-atrasada')?.value || '';
        const period    = document.getElementById('pf-period')?.value || '';
        const vendor    = (document.getElementById('pf-vendor')?.value || '').split(',').filter(Boolean);
        const dateFrom  = document.getElementById('pf-date-from')?.value || '';
        const dateTo    = document.getElementById('pf-date-to')?.value || '';
        const dupFilter = document.getElementById('pf-dup')?.value || '';
        const { start: periodStart, end: periodEnd } = getDateRangeForPeriod(period);

        // Duplicado = mesmo cliente + foco — calculado sobre tudo que está
        // carregado (não só o já filtrado por outros campos), senão um
        // filtro escondendo o "gêmeo" faria o outro parar de contar como
        // repetido. Marca só os excedentes de cada grupo (mantém a mais
        // recente sem marca, como a "titular") em vez de marcar as duas —
        // assim dá pra saber direto qual apagar, sem ambiguidade. A ordem
        // usada aqui (data desc) é sempre a mesma independente dos filtros
        // ativos no momento, pra não trocar qual registro é "a duplicada"
        // conforme a tela é filtrada.
        const dupSortedAll = [...normalized].sort((a, b) => {
            const da = parseDisplayDate(a.data) || parseDisplayDate(a.atualizacao);
            const db = parseDisplayDate(b.data) || parseDisplayDate(b.atualizacao);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });
        const dupSeenKeys = new Set();
        const dupMarkedIds = new Set();
        dupSortedAll.forEach((p) => {
            const k = propostaDupKey(p);
            if (dupSeenKeys.has(k)) { dupMarkedIds.add(String(p.id)); }
            else { dupSeenKeys.add(k); }
        });
        const isDup = (p) => dupMarkedIds.has(String(p.id));

        const filtered = normalized.filter((p) => {
            const matchSearch   = !search  || [p.cliente, p.cidade, p.obs, p.vendedor, p.foco].some((v) => String(v || '').toLowerCase().includes(search));
            const matchStatus   = !statusSel.length || statusSel.includes(p.status);
            const matchCidade   = !cidade.length || cidade.includes(p.cidade);
            const matchAtrasada = !atrasada || (atrasada === 'sim' ? p.atrasada : !p.atrasada);
            const matchVendor   = !vendor.length || vendor.includes(p.vendedor);
            const criacaoDate = parseDisplayDate(p.data);
            const matchPeriod = !period || (criacaoDate && criacaoDate >= periodStart && criacaoDate <= periodEnd);
            const matchFrom = !dateFrom || (criacaoDate && criacaoDate >= parseInputDate(dateFrom));
            const matchTo   = !dateTo   || (criacaoDate && criacaoDate <= parseInputDate(dateTo));
            const matchYear = !state.proposalsYearFilter || (criacaoDate && criacaoDate.getFullYear() === state.proposalsYearFilter);
            const matchDup  = !dupFilter || isDup(p);
            return matchSearch && matchStatus && matchCidade && matchAtrasada && matchVendor && matchPeriod && matchFrom && matchTo && matchYear && matchDup;
        });

        const container = document.getElementById('proposal-list-container');
        if (!container) { return; }

        if (filtered.length === 0) {
            lastFilteredProposals = [];
            container.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhuma proposta para os filtros selecionados.</p></div>`;
            return;
        }

        const sorted = [...filtered].sort((a, b) => {
            const da = parseDisplayDate(a.data) || parseDisplayDate(a.atualizacao);
            const db = parseDisplayDate(b.data) || parseDisplayDate(b.atualizacao);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });
        _propsCampanhaList = sorted.map((p) => ({ id: p.id, cliente: p.cliente, cidade: p.cidade, extra: [p.foco, p.produto || p.produtos].filter(Boolean).join(' · ') }));
        lastFilteredProposals = sorted;

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
                    <button type="button" class="proposal-card ${p.atrasada ? 'proposal-card-alert' : ''}${selectMode && selectedIds.has(String(p.id)) ? ' is-selected' : ''}${isDup(p) ? ' funil-card-dup' : ''}" data-proposal-id="${escapeHtml(p.id)}">
                        <div class="visit-card-header">
                            <strong>
                                ${selectMode ? '<span class="funil-sel-box" aria-hidden="true"></span>' : ''}<span aria-hidden="true">${proposalStatusIcon(p.status)}</span> ${escapeHtml(p.cliente || 'Cliente não informado')}
                                ${isDup(p) ? '<span class="funil-dup-tag" title="Existe outra proposta com o mesmo cliente e foco">⚠️ Duplicado</span>' : ''}
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
                            <span>${isAdmGer && p.vendedor ? escapeHtml(p.vendedor) + ' · ' : ''}${escapeHtml(p.data || '-')}</span>
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
        if (selectMode) {
            container.insertAdjacentHTML('afterbegin', `
                <div class="funil-sel-bar" id="proposal-sel-bar">
                    <strong id="proposal-sel-count">${selectedIds.size} selecionado(s)</strong>
                    <button type="button" class="mini-button" id="proposal-sel-dups" title="Marca as repetidas (mesmo cliente e foco), deixando sem marca a mais recente de cada grupo">Marcar duplicadas</button>
                    <button type="button" class="mini-button" id="proposal-sel-all">Marcar todas</button>
                    <button type="button" class="mini-button" id="proposal-sel-none">Limpar</button>
                    <button type="button" class="mini-button mini-button-danger" id="proposal-sel-delete" ${selectedIds.size ? '' : 'disabled'}>🗑️ Excluir selecionadas</button>
                </div>`);
        }

        container.querySelectorAll('[data-proposal-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (selectMode) {
                    setCardSelected(btn.dataset.proposalId, !selectedIds.has(String(btn.dataset.proposalId)), btn);
                    refreshSelBar();
                    return;
                }
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

        // Barra do modo seleção (re-renderizada junto com a lista).
        container.querySelector('#proposal-sel-dups')?.addEventListener('click', () => {
            // Usa o mesmo isDup do destaque roxo/filtro — a titular de cada
            // grupo (a mais recente) nunca é marcada, só as excedentes.
            let marked = 0;
            container.querySelectorAll('[data-proposal-id]').forEach((card) => {
                const p = normalized.find((x) => String(x.id) === String(card.dataset.proposalId));
                if (!p) return;
                if (isDup(p)) { setCardSelected(p.id, true, card); marked++; }
            });
            refreshSelBar();
            showToast(marked ? `${marked} duplicada(s) marcada(s).` : 'Nenhuma duplicada exata entre os registros visíveis.', !marked);
        });
        container.querySelector('#proposal-sel-all')?.addEventListener('click', () => {
            container.querySelectorAll('[data-proposal-id]').forEach((card) => setCardSelected(card.dataset.proposalId, true, card));
            refreshSelBar();
        });
        container.querySelector('#proposal-sel-none')?.addEventListener('click', () => {
            container.querySelectorAll('[data-proposal-id]').forEach((card) => setCardSelected(card.dataset.proposalId, false, card));
            selectedIds.clear();
            refreshSelBar();
        });
        container.querySelector('#proposal-sel-delete')?.addEventListener('click', async (e) => {
            const ids = Array.from(selectedIds);
            if (!ids.length) return;
            if (!confirm(`Apagar ${ids.length} proposta(s)? Essa ação não pode ser desfeita.`)) return;
            const btn = e.currentTarget;
            setSaving(true, btn, 'Apagando...');
            const r = await callAPI('deleteProposalBatch', { ids, user: state.currentUser })
                .catch((err) => ({ status: 'error', message: err.message }));
            if (r && r.status === 'success') {
                const gone = new Set((r.deleted || ids).map(String));
                state.proposals = (state.proposals || []).filter((x) => !gone.has(String(x.Id || x.id)));
                normalized = state.proposals.map(normalizeProposal);
                saveCache('proposals', state.proposals);
                if (state.proposalsScope === 'all') saveCache('proposals_all', state.proposals);
                selectedIds.clear();
                const sub = document.querySelector('.page-header .page-subtitle');
                if (sub) sub.textContent = `${normalized.length} proposta(s)`;
                showToast(r.message || `${gone.size} registro(s) apagado(s).`);
                renderFiltered();
            } else {
                showToast((r && r.message) || 'Não foi possível apagar.', true);
                setSaving(false, btn);
            }
        });

        if (qeActive() && qeSelectedId) { openProposalQuickPanel(qeSelectedId); }
    };

    function setCardSelected(id, on, cardEl) {
        const key = String(id);
        if (on) selectedIds.add(key); else selectedIds.delete(key);
        const el = cardEl || document.querySelector(`#proposal-list-container .proposal-card[data-proposal-id="${CSS.escape(key)}"]`);
        el?.classList.toggle('is-selected', on);
    }

    function refreshSelBar() {
        const count = document.getElementById('proposal-sel-count');
        if (count) count.textContent = `${selectedIds.size} selecionado(s)`;
        const del = document.getElementById('proposal-sel-delete');
        if (del) del.disabled = selectedIds.size === 0;
    }

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
                <div class="qe-panel-header">
                    <div>
                        <strong class="qe-panel-title">${escapeHtml(p.cliente || 'Cliente')}</strong>
                        <p class="helper-text" style="margin:0.15rem 0 0;text-align:left">${escapeHtml([p.cidade, p.vendedor, p.data].filter(Boolean).join(' · '))}</p>
                    </div>
                    <div class="qe-panel-header-actions">
                        ${(() => {
                            const _fl = p.funilVinculado ? (state.funil || []).find((fx) => String(fx.id || fx.Id) === String(p.funilVinculado)) : null;
                            if (_fl) return `
                                <button type="button" class="mini-button" id="qe-ver-funil" data-funil-id="${escapeHtml(String(_fl.id || _fl.Id || ''))}" title="Abrir oportunidade vinculada">🔗 ${escapeHtml(_fl.cliente || _fl.Cliente || '-')}</button>
                                <button type="button" class="mini-button mini-button-danger" id="qe-desvincular-funil" title="Remover vínculo">Desvincular</button>`;
                            return `<button type="button" class="mini-button" id="qe-link-funil" title="Buscar e vincular a uma oportunidade do Funil já cadastrada">🔗 Vincular Funil</button>`;
                        })()}
                        <button type="button" class="primary-button" id="qe-save">Salvar</button>
                        <button type="button" class="secondary-button" id="qe-full" title="Abrir a edição completa desta proposta">Editar tudo</button>
                    </div>
                </div>
                <div class="qe-info qe-info-edit">
                    ${searchField('Cidade', 'qe-cidade', p.cidade, listaCidades)}
                    ${searchField('Foco', 'qe-foco', p.foco, listaFoco)}
                    <div><span>Produtos</span><input type="text" id="qe-produtos" value="${escapeHtml(p.produtos || '')}"></div>
                </div>
                <label>Status</label>
                <div class="qe-status-row">
                    ${STAT.map((s) => `<button type="button" class="qe-status-btn${s === (p.status || '') ? ' is-active' : ''}" data-s="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
                </div>
                <label style="margin-top:0.5rem">Atualizar / OBS</label>
                <textarea id="qe-obs" rows="8">${escapeHtml(withDatedNoteHeader(p.obs))}</textarea>
            </div>`;

        initializeSearchableInput({ input: panel.querySelector('#qe-cidade'), menu: panel.querySelector('#qe-cidade-menu'), items: listaCidades, allowFreeText: true });
        initializeSearchableInput({ input: panel.querySelector('#qe-foco'), menu: panel.querySelector('#qe-foco-menu'), items: listaFoco, allowFreeText: true });

        let selStatus = p.status || 'Enviada';
        panel.querySelectorAll('.qe-status-btn').forEach((b) => b.addEventListener('click', () => {
            selStatus = b.dataset.s;
            panel.querySelectorAll('.qe-status-btn').forEach((x) => x.classList.toggle('is-active', x === b));
        }));
        const ta = panel.querySelector('#qe-obs');
        setTimeout(() => { ta.focus(); selectNoteHint(ta); }, 20);

        panel.querySelector('#qe-full').addEventListener('click', () => navigateTo('proposal-edit', { proposal: p }));
        panel.querySelector('#qe-link-funil')?.addEventListener('click', () => openLinkFunilModal(p, () => openProposalQuickPanel(p.id)));
        panel.querySelector('#qe-ver-funil')?.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.funilId;
            if (id) navigateTo('funil-detail', { id });
        });
        panel.querySelector('#qe-desvincular-funil')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            const funilId = p.funilVinculado;
            const r = await callAPI('updateProposal', { id: p.id, funilVinculado: '', user: state.currentUser }).catch((err) => ({ status: 'error', message: err.message }));
            if (!r || r.status !== 'success') { showToast((r && r.message) || 'Não foi possível desvincular.', true); btn.disabled = false; return; }
            if (funilId) callAPI('updateFunil', { id: funilId, propostaVinculada: '', user: state.currentUser }).catch(() => {});
            p.funilVinculado = '';
            const i = (state.proposals || []).findIndex((x) => String(x.Id || x.id) === String(p.id));
            if (i >= 0) { state.proposals[i] = { ...state.proposals[i], FunilVinculado: '', funilVinculado: '' }; saveCache('proposals', state.proposals); }
            showToast('Vínculo removido.');
            openProposalQuickPanel(p.id);
        });

        panel.querySelector('#qe-save').addEventListener('click', () => {
            const obs = stripEmptyDatedLine(ta.value);
            const cidade = panel.querySelector('#qe-cidade')?.value.trim();
            const foco = panel.querySelector('#qe-foco')?.value.trim();
            const produtos = panel.querySelector('#qe-produtos')?.value.trim();
            setSaving(true, panel.querySelector('#qe-save'), 'Salvando...');
            showToast('Salvo.');
            // Se o novo status tirar esse card do filtro atual (ex.: filtrado
            // por "Aguardando" e o card virou "Ganhamos"), pula pro próximo
            // da lista em vez de continuar mostrando um card que já sumiu —
            // dá pra processar a fila inteira sem reselecionar manualmente.
            const idsBefore = Array.from(document.querySelectorAll('#proposal-list-container [data-proposal-id]')).map((el) => el.dataset.proposalId);
            const posBefore = idsBefore.indexOf(String(p.id));
            applyProposalQuickPatch(p, { status: selStatus, obs, cidade, foco, produtos }, () => {
                normalized = state.proposals.map(normalizeProposal);
                renderFiltered();
                const idsAfter = new Set(Array.from(document.querySelectorAll('#proposal-list-container [data-proposal-id]')).map((el) => el.dataset.proposalId));
                if (!idsAfter.has(String(p.id)) && posBefore > -1) {
                    const nextId = idsBefore.slice(posBefore + 1).find((id) => idsAfter.has(id));
                    if (nextId) {
                        openProposalQuickPanel(nextId);
                    } else {
                        qeSelectedId = null;
                        const qePanel = document.getElementById('qe-panel');
                        if (qePanel) qePanel.innerHTML = `<p class="helper-text" style="padding:1.25rem;text-align:left">Tudo processado por aqui — clique numa proposta da lista pra continuar editando.</p>`;
                    }
                }
            });
        });
    }

    const _proposalFilterIds = ['pf-search', 'pf-status', 'pf-cidade', 'pf-atrasada', 'pf-dup', 'pf-period', 'pf-vendor',
        'pf-date-from', 'pf-date-to'];
    wireMultiCheckFilter({ triggerId: 'pf-status-trigger', inputId: 'pf-status', menuId: 'pf-status-menu', options: availableStatuses });
    wireMultiCheckFilter({ triggerId: 'pf-cidade-trigger', inputId: 'pf-cidade', menuId: 'pf-cidade-menu', options: availableCities });
    if (isAdmGer) {
        wireMultiCheckFilter({ triggerId: 'pf-vendor-trigger', inputId: 'pf-vendor', menuId: 'pf-vendor-menu', options: availableVendors });
    }

    // Restaura os filtros lembrados da última visita a esta tela.
    _proposalFilterIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el && state.proposalFilters[id]) el.value = state.proposalFilters[id];
    });
    const syncProposalMultiCheckLabels = () => {
        syncMultiCheckFilterLabel('pf-status-trigger', 'pf-status');
        syncMultiCheckFilterLabel('pf-cidade-trigger', 'pf-cidade');
        syncMultiCheckFilterLabel('pf-vendor-trigger', 'pf-vendor');
    };
    syncProposalMultiCheckLabels();

    const _proposalTextFilterIds = new Set(['pf-search']);
    const _debouncedProposalFilter = debounce(renderFiltered, 250);
    _proposalFilterIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        // Grava em state.proposalFilters a cada mudança — a restauração lá
        // em cima já lia daqui, mas nada gravava, então o filtro nunca era
        // lembrado de verdade (sumia em qualquer re-render da tela).
        const remember = () => { state.proposalFilters[id] = el.value; };
        if (_proposalTextFilterIds.has(id)) { el.addEventListener('input', () => { remember(); _debouncedProposalFilter(); }); }
        // 'change' cobre <select> e o clique numa opção do filtro de múltipla
        // escolha (Status/Cidade/Vendedor), que só dispara 'change'.
        el.addEventListener('change', () => { remember(); renderFiltered(); });
    });

    document.getElementById('proposal-filter-clear')?.addEventListener('click', () => {
        _proposalFilterIds.forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; } });
        syncProposalMultiCheckLabels();
        state.proposalFilters = {};
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
                wireMultiCheckFilter({ triggerId: 'pf-status-trigger', inputId: 'pf-status', menuId: 'pf-status-menu', options: Array.from(new Set(normalized.map((p) => p.status).filter(Boolean))) });
                wireMultiCheckFilter({ triggerId: 'pf-cidade-trigger', inputId: 'pf-cidade', menuId: 'pf-cidade-menu', options: Array.from(new Set(normalized.map((p) => p.cidade).filter(Boolean))).sort() });
                if (isAdmGer) wireMultiCheckFilter({ triggerId: 'pf-vendor-trigger', inputId: 'pf-vendor', menuId: 'pf-vendor-menu', options: Array.from(new Set(normalized.map((p) => p.vendedor).filter(Boolean))).sort() });
                renderFiltered();
                updateYearChips();
            }
        } catch(e) {}
    });

    document.getElementById('btn-new-proposal')?.addEventListener('click', () => navigateTo('proposal-new'));
    document.getElementById('proposal-select-toggle')?.addEventListener('click', (e) => {
        selectMode = !selectMode;
        if (!selectMode) selectedIds.clear();
        e.currentTarget.classList.toggle('is-on', selectMode);
        renderFiltered();
    });
    document.getElementById('proposals-campanha-btn')?.addEventListener('click', async () => {
        const { openSelecionarClientesModal } = await import('./campanhas.js');
        openSelecionarClientesModal('proposta', _propsCampanhaList);
    });
    document.getElementById('qe-toggle')?.addEventListener('click', (e) => {
        quickEdit = !quickEdit;
        try { localStorage.setItem('proposals_quick_edit', quickEdit ? '1' : '0'); } catch (err) {}
        e.currentTarget.classList.toggle('is-on', quickEdit);
        qeSelectedId = null;
        const goingOn = quickEdit;
        // Ao LIGAR: esconde busca/filtros/período (só lista + painel).
        document.getElementById('main-content')?.classList.toggle('qe-focus', goingOn);
        renderFiltered();
        requestAnimationFrame(() => {
            document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'auto' });
            window.scrollTo({ top: 0, behavior: 'auto' });
        });
    });
    document.getElementById('proposals-csv-btn')?.addEventListener('click', () => {
        if (!lastFilteredProposals.length) { showToast('Nenhuma proposta para os filtros selecionados.', true); return; }
        const stamp = new Date().toISOString().slice(0, 10);
        downloadXLSX(lastFilteredProposals, `propostas-${stamp}.xlsx`, [
            { key: 'data', label: 'Data' },
            { key: 'vendedor', label: 'Nome do Vendedor' },
            { key: 'cliente', label: 'Nome do Cliente' },
            { key: 'foco', label: 'Foco' },
            { key: 'produtos', label: 'Produto' },
            { key: 'obs', label: 'Obs' }
        ], 'Propostas');
    });
    document.getElementById('update-summary-btn')?.addEventListener('click', () => {
        openSummaryModal(() => navigateTo('proposals'));
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
    // Edição rápida sempre começa desligada — o usuário liga clicando.
    try { localStorage.removeItem('proposals_quick_edit'); } catch (e) {}
    document.getElementById('main-content')?.classList.remove('qe-focus');
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
        // Não usar getProposals(3): sem 'since' válido (expira em 24h) o merge
        // não roda e a lista era trocada por só os últimos 3 dias. Recarrega a
        // janela cheia; com 'since' o backend já devolve só o delta.
        getProposals(loadAll || cachedAll ? 0 : undefined);
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


// Vincular manualmente uma Proposta a uma oportunidade do Funil já
// cadastrada — fallback pro casamento automático (cliente+foco) lá em
// cima, pra quando a grafia do cliente é diferente entre as duas abas e o
// app não acha sozinho. Espelha openLinkPropostaModal (funil.js).
function openLinkFunilModal(proposal, onLinked) {
    ensureFunilForDedup().then(() => {
        const items = (state.funil || []).map((f) => {
            const foco = f.foco || f.Foco || '';
            const aplicacao = f.aplicacao || f.Aplicacao || '';
            // Foco e Aplicação às vezes têm o mesmo valor — sem dedupe a tag
            // mostrava "EKKOA · EKKOA" repetido, sem informação extra.
            const tag = [foco, aplicacao].filter(Boolean)
                .filter((v, i, arr) => i === 0 || v.toLowerCase() !== arr[i - 1].toLowerCase())
                .join(' · ');
            return {
                id: String(f.id || f.Id || ''),
                cliente: f.cliente || f.Cliente || '-',
                tag,
                cidade: f.cidade || f.Cidade || '',
                data: f.data || f.Data || ''
            };
        }).filter((it) => it.id);

        openLinkPickerModal({
            eyebrow: `Proposta · ${proposal.cliente || 'Cliente'}`,
            title: 'Vincular ao Funil',
            contextText: `Vinculando à proposta de ${proposal.cliente || 'cliente'}${proposal.data ? ' · ' + proposal.data : ''}${proposal.vendedor ? ' · ' + proposal.vendedor : ''}${proposal.cidade ? ' · ' + proposal.cidade : ''}`,
            searchPlaceholder: 'Buscar por cliente, cidade ou vendedor...',
            confirmLabel: 'Vincular oportunidade selecionada',
            emptyNoun: 'oportunidade do Funil',
            currentCliente: proposal.cliente,
            items,
            onConfirm: async (funilId) => {
                const r = await callAPI('updateProposal', { id: proposal.id, funilVinculado: funilId, user: state.currentUser })
                    .catch((e) => ({ status: 'error', message: e.message }));
                if (!r || r.status !== 'success') { showToast((r && r.message) || 'Não foi possível vincular.', true); return; }
                callAPI('updateFunil', { id: funilId, propostaVinculada: proposal.id, user: state.currentUser }).catch(() => {});
                proposal.funilVinculado = funilId;
                const i = (state.proposals || []).findIndex((x) => String(x.Id || x.id) === String(proposal.id));
                if (i >= 0) { state.proposals[i] = { ...state.proposals[i], FunilVinculado: funilId, funilVinculado: funilId }; saveCache('proposals', state.proposals); }
                showToast('Vinculado ao Funil.');
                if (onLinked) onLinked(); else renderProposalDetailPage(proposal.id);
            }
        });
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

    // Sempre carrega (não só quando pode criar) — o vínculo manual abaixo
    // (Funil vinculado) vale pra qualquer um ver/usar, é diferente de poder
    // criar oportunidade nova.
    await ensureFunilForDedup();
    const funilDoCliente = funilItemForProposta(proposal.cliente, proposal.foco);
    const funilAlerta = funilEmAlerta(funilDoCliente);
    const funilStatusTxt = escapeHtml(String((funilDoCliente && (funilDoCliente.status || funilDoCliente.Status)) || ''));
    // Vínculo manual (ver openLinkFunilModal) — pro caso do casamento
    // automático acima (por cliente+foco) não achar por causa de grafia
    // diferente entre as duas abas.
    const funilLinkado = proposal.funilVinculado
        ? (state.funil || []).find((fx) => String(fx.id || fx.Id) === String(proposal.funilVinculado))
        : null;

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
            ${proposal.resumo ? `<details class="detail-resumo"><summary>Itens da proposta (Resumo)</summary><p>${escapeHtml(proposal.resumo).replace(/\s*\/\s*(?=Item\s+\d)/gi, '<br>')}</p></details>` : ''}
            ${renderDetailRow('Data Limite', proposal.dataLimite || '-')}
            ${renderDetailRow('E-mail', proposal.email || '-')}
        </div>
        ${funilLinkado ? `
        <div class="card detail-card funil-link-card">
            <div class="funil-readonly-row">
                <span>Funil vinculado</span>
                <span>
                    <button type="button" class="section-link-button" id="ver-funil-vinculado">${escapeHtml(funilLinkado.cliente || funilLinkado.Cliente || '-')} · ${escapeHtml(funilLinkado.foco || funilLinkado.Foco || '-')}</button>
                    <button type="button" class="mini-button mini-button-danger" id="desvincular-funil">Desvincular</button>
                </span>
            </div>
        </div>` : (!funilDoCliente ? `
        <div class="card detail-card funil-link-card">
            <div class="funil-readonly-row">
                <span>Funil vinculado</span>
                <button type="button" class="mini-button" id="vincular-funil">🔗 Vincular ao Funil</button>
            </div>
        </div>` : '')}
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
    document.getElementById('vincular-funil')?.addEventListener('click', () => openLinkFunilModal(proposal));
    document.getElementById('ver-funil-vinculado')?.addEventListener('click', () => {
        if (funilLinkado) navigateTo('funil-detail', { id: String(funilLinkado.id || funilLinkado.Id) });
    });
    document.getElementById('desvincular-funil')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        const funilId = proposal.funilVinculado;
        const r = await callAPI('updateProposal', { id: proposal.id, funilVinculado: '', user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
        if (!r || r.status !== 'success') { showToast((r && r.message) || 'Não foi possível desvincular.', true); btn.disabled = false; return; }
        if (funilId) callAPI('updateFunil', { id: funilId, propostaVinculada: '', user: state.currentUser }).catch(() => {});
        proposal.funilVinculado = '';
        const i = (state.proposals || []).findIndex((x) => String(x.Id || x.id) === String(proposal.id));
        if (i >= 0) { state.proposals[i] = { ...state.proposals[i], FunilVinculado: '', funilVinculado: '' }; saveCache('proposals', state.proposals); }
        showToast('Vínculo removido.');
        renderProposalDetailPage(proposal.id);
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

    preventEnterSubmit(document.getElementById('proposal-form'));
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
                    trackUpdate('proposals', { id: proposalId, cliente: normalized.cliente, vendedor: normalized.vendedor, gerencia: normalized.gerencia, status: newStatus });
                } else if (result && result.status === 'queued') {
                    if (idx >= 0) {
                        state.proposals[idx] = { ...state.proposals[idx], _pending: true };
                        saveCache('proposals', state.proposals);
                    }
                    showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                    trackUpdate('proposals', { id: proposalId, cliente: normalized.cliente, vendedor: normalized.vendedor, gerencia: normalized.gerencia, status: newStatus });
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
    const vendedoresList = (fdResult.data && fdResult.data.vendedores) || [];
    const isAdminUser = String(state.currentUser.profile || '').trim().toLowerCase() === 'admin';

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
            ${isAdminUser ? `
            <div class="form-group">
                <label for="pc-vendedor">Vendedor (Admin pode registrar por outro)</label>
                <select id="pc-vendedor">
                    <option value="">${escapeHtml(state.currentUser.name || '')} (eu)</option>
                    ${vendedoresList.map((v) => `<option value="${escapeHtml(v.nome)}">${escapeHtml(v.nome)}</option>`).join('')}
                </select>
            </div>` : ''}
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
        items: clientes.map((c) => clienteSearchItem(c)),
        allowFreeText: true,
        onSelect: (value) => {
            const match = findClienteByNome(clientes, value);
            if (!match) return;
            if (match.cidade) document.getElementById('pc-cidade').value = match.cidade;
            if (match.potencialCliente) document.getElementById('pc-foco').value = match.potencialCliente;
        }
    });

    // Observações já abre com "dd/mm/aaaa - " (igual à edição rápida) — só
    // posiciona o cursor depois do cabeçalho pra quando o campo ganhar foco.
    {
        const pcObs = document.getElementById('pc-obs');
        selectNoteHint(pcObs);
    }

    // Prefill vindo do "+ Ao Proposta" na edição rápida do Funil.
    if (state.proposalPrefill) {
        const pf = state.proposalPrefill;
        state.proposalPrefill = null;
        if (pf.cliente) document.getElementById('pc-cliente').value = pf.cliente;
        if (pf.cidade) document.getElementById('pc-cidade').value = pf.cidade;
        if (pf.foco) document.getElementById('pc-foco').value = pf.foco;
        if (pf.produtos) document.getElementById('pc-produtos').value = pf.produtos;
    }

    document.getElementById('back-proposal-create').addEventListener('click', () => navigateTo('proposals'));
    document.getElementById('cancel-proposal-create').addEventListener('click', () => navigateTo('proposals'));

    preventEnterSubmit(document.getElementById('proposal-create-form'));
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
        const vendedorEscolhido = document.getElementById('pc-vendedor') ? document.getElementById('pc-vendedor').value.trim() : '';
        const vendedorVal = vendedorEscolhido || state.currentUser.name;

        const tempPId = 'temp_' + Date.now();
        const nowPDisplay = formatDateForDisplay(new Date());
        const optimisticProposal = normalizeProposal({
            Id: tempPId,
            Data: nowPDisplay,
            Vendedor: vendedorVal,
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
            produtos: produtosVal, status: statusVal, obs: obsVal, vendedor: vendedorVal, user: state.currentUser },
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
    setTimeout(() => { _pqTa.focus(); selectNoteHint(_pqTa); }, 30);
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
                trackUpdate('proposals', { id: p.id, cliente: p.cliente, vendedor: p.vendedor, gerencia: p.gerencia, status });
            } else if (result && result.status === 'queued') {
                if (idx >= 0) { state.proposals[idx] = { ...state.proposals[idx], _pending: true }; saveCache('proposals', state.proposals); }
                showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                trackUpdate('proposals', { id: p.id, cliente: p.cliente, vendedor: p.vendedor, gerencia: p.gerencia, status });
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
                    const vendedorNome = original ? (original.vendedor || original.Vendedor || '') : '';
                    const gerenciaNome = original ? (original.gerencia || original.Gerencia || '') : '';
                    if (result && result.status === 'queued') {
                        if (idx >= 0) {
                            state.proposals[idx] = { ...state.proposals[idx], _pending: true };
                            saveCache('proposals', state.proposals);
                        }
                        showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                        trackUpdate('proposals', { id: proposalId, cliente: clienteNome, vendedor: vendedorNome, gerencia: gerenciaNome, status: newStatus });
                    } else if (!result || result.status !== 'success') {
                        if (idx >= 0 && original) { state.proposals[idx] = original; saveCache('proposals', state.proposals); }
                        showToast((result && result.message) || 'Erro ao atualizar status.', true);
                    } else {
                        trackUpdate('proposals', { id: proposalId, cliente: clienteNome, vendedor: vendedorNome, gerencia: gerenciaNome, status: newStatus });
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