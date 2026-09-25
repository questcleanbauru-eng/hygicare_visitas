import { state, navigateTo, addDocumentClickListener, clearDocumentClickListeners } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, getSyncTimestamp, setSyncTimestamp, mergeById, attemptOrQueue } from '../api.js';
import {
    escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, parseInputDate,
    groupVisitsByMonth, formatMonthKey, normalizeVisit, compareVisitsByDateDesc,
    formatDateForDisplay, formatDateForInput, formatTimeForInput, formatInputDateFromDisplay, formatDateFromDisplay,
    formatDateFieldValue, normalizeDisplayDateValue, formatTimeFieldValue, normalizeTimeValue,
    normalizeProposal, visitTypeIcon, visitTypeCategory, proposalStatusIcon, funilStatusIcon, filterLabelHtml,
    calculateDaysFromDisplayDate,
    datedNoteHeader, withDatedNoteHeader, stripEmptyDatedLine, selectNoteHint,
    clienteSearchItem, findClienteByNome, clienteNomeParaGravar, multiCheckFilterFieldHtml,
    formatCurrency, parseCurrencyBR, resolveNotifyOptions, scopeYearFilterFieldsHtml
} from '../utils/format.js';
import {
    debounce, initializeSearchableInput, renderDetailRow, actionIcon,
    showToast, showFieldError, clearFieldError, openExternal, skeletonList, skeletonDetail,
    loadingState, showRefreshIndicator, hideRefreshIndicator, addScrollTop, wireYearSelect, setSaving,
    openIcsEvent, preventEnterSubmit, renderSimpleOptions,
    wireMultiCheckFilter, syncMultiCheckFilterLabel
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, ensureStyles, initSearchBarAutoHide } from '../utils/ui.js';
import { ensureFunilForDedup, funilItemFor, funilEmAlerta } from '../utils/funilLink.js';
import { downloadXLSX } from '../utils/xlsxWriter.js';
import { getProposals } from './proposals.js';
import { getFunil } from './funil.js';

// Update otimista + attemptOrQueue + rollback pro painel de edição rápida
// (split view do admin). Campos não presentes no patch (undefined) caem pro
// valor já existente no registro (v.X) — o servidor exige os campos
// obrigatórios mesmo quando o painel só editou a Observação.
function applyVisitQuickPatch(v, patch, onDone) {
    const g = (key, fallback) => patch[key] !== undefined ? patch[key] : fallback;
    const tipoVisitaValue = g('tipoVisita', v.tipoVisita);
    const payload = {
        id: v.id,
        prospeccao: v.prospeccao || 'Nao',
        vendedorGerente: g('vendedorGerente', v.vendedorGerente || state.currentUser.name),
        gerencia: v.gerencia || state.currentUser.gerencia,
        dataVisita: g('dataVisita', v.dataVisita),
        horario: g('horario', v.horario),
        cliente: g('cliente', v.cliente),
        contato: g('contato', v.contato || ''),
        cidade: g('cidade', v.cidade),
        areaAtuacao: g('areaAtuacao', v.areaAtuacao),
        potencialCliente: g('potencialCliente', v.potencialCliente || ''),
        tipoVisita: tipoVisitaValue,
        tiposVisita: [tipoVisitaValue].filter(Boolean),
        veiculo: g('veiculo', v.veiculo || 'Particular'),
        observacao: patch.observacao,
        ...(patch.teveDespesas !== undefined ? { teveDespesas: patch.teveDespesas } : {}),
        ...(patch.valorDespesas !== undefined ? { valorDespesas: patch.valorDespesas } : {}),
        user: state.currentUser
    };
    const idx = state.visits.findIndex((x) => String(x.ID || x.id) === String(v.id));
    const original = idx >= 0 ? { ...state.visits[idx] } : null;
    const updated = normalizeVisit({
        ID: v.id, 'Prospecção': payload.prospeccao, 'Vendedor/Gerente': payload.vendedorGerente,
        'Data da Visita': payload.dataVisita, 'Horário': payload.horario, 'Cliente': payload.cliente,
        'Contato': payload.contato, 'Cidade': payload.cidade, 'Área de Atuação': payload.areaAtuacao,
        'Potencial do Cliente': payload.potencialCliente, 'Tipo da Visita': payload.tipoVisita,
        'Gerência': payload.gerencia, 'Qual o Veículo?': payload.veiculo, 'Observação': payload.observacao,
        'TeveDespesas': payload.teveDespesas !== undefined ? payload.teveDespesas : v.teveDespesas,
        'ValorDespesas': payload.valorDespesas !== undefined ? payload.valorDespesas : v.valorDespesas
    });
    if (idx >= 0) { state.visits[idx] = updated; saveCache('visits', state.visits); }
    // `v` é o objeto normalizado da lista (referência separada da de
    // state.visits) — mutar aqui também pra o re-render pegar o novo valor.
    Object.assign(v, updated, { id: v.id });
    if (onDone) onDone();

    return attemptOrQueue('updateVisit', payload, { entity: 'visits', tempId: payload.id })
        .then((res) => {
            if (res && res.status === 'success') {
                const real = normalizeVisit(res.visit || payload);
                state.visits = state.visits.map((x) => String(x.ID || x.id) === String(v.id) ? real : x);
                saveCache('visits', state.visits);
            } else if (res && res.status === 'queued') {
                if (idx >= 0) { state.visits[idx] = { ...updated, _pending: true }; saveCache('visits', state.visits); }
                showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
            } else {
                if (idx >= 0 && original) { state.visits[idx] = original; saveCache('visits', state.visits); }
                showToast((res && res.message) || 'Erro ao salvar. Tente novamente.', true);
            }
            if (onDone) onDone();
            return res;
        })
        .catch(() => {
            if (idx >= 0 && original) { state.visits[idx] = original; saveCache('visits', state.visits); }
            showToast('Erro ao salvar. Tente novamente.', true);
            if (onDone) onDone();
        });
}

// Quebra o texto acumulado de Observação (uma linha "DD/MM/AAAA - texto"
// por entrada, mais recente no topo — ver withDatedNoteHeader) em entradas
// pra exibir como lista na edição rápida "v2", em vez de textarea crua.
function parseDatedEntries(text) {
    return String(text || '').split('\n').map((line) => {
        const m = line.match(/^(\d{2}\/\d{2}\/\d{4})\s*-\s*(.*)$/);
        if (m) return { date: m[1], text: m[2] };
        return line.trim() ? { date: '', text: line.trim() } : null;
    }).filter(Boolean);
}

// Referência pro render da lista de Visitas já filtrada — setada por
// fillVisitsContent, chamada pelo toggle "Edição rápida" no cabeçalho.
let _visitsRenderFiltered = null;

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
                <button type="button" class="primary-btn" id="empty-new-visit">+ Nova Visita</button>
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
    const availableAreas   = Array.from(new Set(normalizedVisits.map((v) => v.areaAtuacao).filter(Boolean))).sort();
    const availablePotenciais = Array.from(new Set(normalizedVisits.map((v) => v.potencialCliente).filter(Boolean))).sort();
    const availableVeiculos = Array.from(new Set(normalizedVisits.map((v) => v.veiculo).filter(Boolean))).sort();
    const isAdmGer         = isAdminOrGerenteUser();
    const isAdmin          = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    // Administrativo já enxerga as visitas de todos (hasBroadDataAccess, no
    // servidor) — só faltava a tela deixar filtrar/baixar por vendedor, que
    // até aqui era só de Admin/Gerente.
    const isAdministrativo = (state.currentUser?.profile || '').toLowerCase() === 'administrativo';
    const canVendorTools   = isAdmGer || isAdministrativo;
    // Edição rápida (só admin, só desktop): lista + painel de Observação na
    // mesma tela — anota uma visita atrás da outra sem abrir/voltar. qeActive
    // relê o localStorage a cada chamada pra o toggle valer sem re-render.
    const qeStored = () => { try { return localStorage.getItem('visits_quick_edit') === '1'; } catch (e) { return false; } };
    const quickEdit = isAdmin && qeStored();
    const qeActive = () => isAdmin && window.innerWidth >= 1024 && qeStored();
    let qeSelectedId = null;
    // Listener de "clique fora" do menu "⋮" do painel de edição rápida —
    // guardado aqui (não dentro de openVisitQuickPanel) pra dar pra remover
    // o anterior sempre que o painel reabre com outra visita, sem vazar um
    // listener em document por card visitado na sessão.
    let _qeMenuOutsideClick = null;
    const availableVendors = canVendorTools
        ? Array.from(new Set(normalizedVisits.map((v) => v.vendedorGerente).filter(Boolean))).sort()
        : [];

    container.innerHTML = `
        <div class="search-bar-wrapper">
            <div class="search-bar-input-group">
                <span class="search-bar-icon">🔍</span>
                <input type="text" id="visit-filter-search" placeholder="Buscar cliente, contato ou cidade..." class="form-input">
            </div>
        </div>
        <div class="card visits-filter-card">
            <div class="visits-filter-header">
                <div><strong>Filtros</strong></div>
                <div class="visits-filter-header-actions">
                    ${canVendorTools ? `<button type="button" class="text-link" id="visits-csv-btn" title="Baixar Excel/CSV das visitas filtradas">📥 Excel</button>` : ''}
                    <button type="button" class="text-link" id="visit-filters-clear">Limpar</button>
                    <button type="button" class="mini-button visits-filter-toggle" id="visit-filters-toggle" aria-expanded="true" aria-controls="visit-filters-panel">Ocultar</button>
                </div>
            </div>
            <div class="visits-filter-grid" id="visit-filters-panel">
                <div class="form-group">
                    <label for="visit-filter-period">${filterLabelHtml('Período')}</label>
                    <select id="visit-filter-period">
                        <option value="">Todos</option>
                        <option value="mes-atual">Mês atual</option>
                        <option value="ultimos-3m">Últimos 3 meses</option>
                    </select>
                </div>
                ${multiCheckFilterFieldHtml('Tipo da Visita', 'visit-filter-type')}
                ${multiCheckFilterFieldHtml('Cidade', 'visit-filter-city', 'Todas')}
                <div class="form-group">
                    <label for="visit-filter-prospeccao">${filterLabelHtml('Prospecção')}</label>
                    <select id="visit-filter-prospeccao">
                        <option value="">Todas</option>
                        <option value="Sim">Sim</option>
                        <option value="Nao">Não</option>
                    </select>
                </div>
                ${multiCheckFilterFieldHtml('Área de Atuação', 'visit-filter-area', 'Todas')}
                ${multiCheckFilterFieldHtml('Potencial do Cliente', 'visit-filter-potencial', 'Todos')}
                ${multiCheckFilterFieldHtml('Veículo', 'visit-filter-veiculo', 'Todos')}
                <div class="form-group">
                    <label for="visit-filter-despesas">${filterLabelHtml('Teve Despesas')}</label>
                    <select id="visit-filter-despesas">
                        <option value="">Todas</option>
                        <option value="Sim">Sim</option>
                        <option value="Nao">Não</option>
                    </select>
                </div>
                ${canVendorTools && availableVendors.length > 0 ? multiCheckFilterFieldHtml('Vendedor', 'visit-filter-vendor') : ''}
                <div class="form-group">
                    <label for="visit-filter-date-from">${filterLabelHtml('Data inicial')}</label>
                    <input type="date" id="visit-filter-date-from">
                </div>
                <div class="form-group">
                    <label for="visit-filter-date-to">${filterLabelHtml('Data final')}</label>
                    <input type="date" id="visit-filter-date-to">
                </div>
                ${scopeYearFilterFieldsHtml({ scopeSelectId: 'visit-scope-select', yearSelectId: 'visit-year-select', loadDias: state.loadDias, scopeAll: state.visitsScope === 'all' })}
            </div>
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

    wireMultiCheckFilter({ triggerId: 'visit-filter-type-trigger', inputId: 'visit-filter-type', menuId: 'visit-filter-type-menu', options: availableTypes });
    wireMultiCheckFilter({ triggerId: 'visit-filter-city-trigger', inputId: 'visit-filter-city', menuId: 'visit-filter-city-menu', options: availableCities });
    wireMultiCheckFilter({ triggerId: 'visit-filter-area-trigger', inputId: 'visit-filter-area', menuId: 'visit-filter-area-menu', options: availableAreas, emptyLabel: 'Todas' });
    wireMultiCheckFilter({ triggerId: 'visit-filter-potencial-trigger', inputId: 'visit-filter-potencial', menuId: 'visit-filter-potencial-menu', options: availablePotenciais });
    wireMultiCheckFilter({ triggerId: 'visit-filter-veiculo-trigger', inputId: 'visit-filter-veiculo', menuId: 'visit-filter-veiculo-menu', options: availableVeiculos });
    if (canVendorTools) {
        wireMultiCheckFilter({ triggerId: 'visit-filter-vendor-trigger', inputId: 'visit-filter-vendor', menuId: 'visit-filter-vendor-menu', options: availableVendors });
    }

    // Guarda a última lista filtrada pro botão "Excel" exportar exatamente o
    // que está na tela, não a base inteira.
    let lastFilteredVisits = [];

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
        const typeValue       = (document.getElementById('visit-filter-type')?.value || '').split(',').filter(Boolean);
        const cityValue       = (document.getElementById('visit-filter-city')?.value || '').split(',').filter(Boolean);
        const prospectionValue = document.getElementById('visit-filter-prospeccao')?.value || '';
        const areaValue       = (document.getElementById('visit-filter-area')?.value || '').split(',').filter(Boolean);
        const potencialValue  = (document.getElementById('visit-filter-potencial')?.value || '').split(',').filter(Boolean);
        const veiculoValue    = (document.getElementById('visit-filter-veiculo')?.value || '').split(',').filter(Boolean);
        const despesasValue   = document.getElementById('visit-filter-despesas')?.value || '';
        const periodValue     = document.getElementById('visit-filter-period')?.value || '';
        const vendorValue     = (document.getElementById('visit-filter-vendor')?.value || '').split(',').filter(Boolean);
        const dateFromValue   = document.getElementById('visit-filter-date-from')?.value || '';
        const dateToValue     = document.getElementById('visit-filter-date-to')?.value || '';
        const { start: periodStart, end: periodEnd } = getDateRangeForPeriod(periodValue);

        const filteredVisits = normalizedVisits.filter((visit) => {
            const matchesSearch = !searchValue || [visit.cliente, visit.contato, visit.observacao, visit.tipoVisita, visit.cidade, visit.vendedorGerente]
                .some((value) => String(value || '').toLowerCase().includes(searchValue));
            const matchesType   = !typeValue.length || typeValue.includes(visit.tipoVisita);
            const matchesCity   = !cityValue.length || cityValue.includes(visit.cidade);
            const matchesProspection = !prospectionValue || visit.prospeccao === prospectionValue;
            const matchesArea = !areaValue.length || areaValue.includes(visit.areaAtuacao);
            const matchesPotencial = !potencialValue.length || potencialValue.includes(visit.potencialCliente);
            const matchesVeiculo = !veiculoValue.length || veiculoValue.includes(visit.veiculo);
            const matchesDespesas = !despesasValue || visit.teveDespesas === despesasValue;
            const matchesVendor = !vendorValue.length || vendorValue.includes(visit.vendedorGerente);
            const visitDate     = parseDisplayDate(visit.dataVisita);
            const matchesPeriod = !periodStart || (visitDate && visitDate >= periodStart && visitDate <= periodEnd);
            const matchesDateFrom = !dateFromValue || (visitDate && visitDate >= parseInputDate(dateFromValue));
            const matchesDateTo   = !dateToValue   || (visitDate && visitDate <= parseInputDate(dateToValue));
            const matchesYear    = !state.visitsYearFilter || (visitDate && visitDate.getFullYear() === state.visitsYearFilter);

            return matchesSearch && matchesType && matchesCity && matchesProspection && matchesArea && matchesPotencial && matchesVeiculo && matchesDespesas && matchesVendor && matchesPeriod && matchesDateFrom && matchesDateTo && matchesYear;
        });
        lastFilteredVisits = filteredVisits;
        // Ordem "atual" pra Anterior/Próxima no Detalhe — ver mesmo comentário
        // em proposals.js.
        state.visitsNavOrder = filteredVisits.map((v) => v.id);

        const visitsListContainer = document.getElementById('visits-list-container');
        if (!visitsListContainer) {
            return;
        }

        if (filteredVisits.length === 0) {
            visitsListContainer.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhuma visita para os filtros selecionados.</p></div>`;
            return;
        }

        const visitsByMonth = groupVisitsByMonth(filteredVisits);
        const groupsHtml = Object.keys(visitsByMonth).sort((firstKey, secondKey) => secondKey.localeCompare(firstKey)).map((monthKey) => `
            <section class="visit-month-group">
                <div class="visit-month-header">
                    <h3>${escapeHtml(formatMonthKey(monthKey))}</h3>
                    <span>${escapeHtml(String(visitsByMonth[monthKey].length))} visita(s)</span>
                </div>
                <div class="visits-list">
                    ${visitsByMonth[monthKey].map((visit) => `
                        <div class="visit-card-wrap">
                            <button class="visit-card item-row" type="button" data-visit-id="${escapeHtml(visit.id)}">
                                <span class="type-chip ${visitTypeCategory(visit.tipoVisita)}" aria-hidden="true">${visitTypeIcon(visit.tipoVisita)}</span>
                                <div class="item-body">
                                    <div class="item-top">
                                        <span class="item-name">${escapeHtml(visit.cliente || 'Cliente não informado')}</span>
                                        ${visit._pending ? '<span class="pending-badge" title="Aguardando conexão para enviar">⏳ Pendente</span>' : ''}
                                    </div>
                                    <div class="item-meta">${[visit.dataVisita, visit.cidade, visit.horario].filter(Boolean).map(escapeHtml).join(' · ') || '-'}</div>
                                    <div class="item-bottom">
                                        <span class="status-tag ${visitTypeCategory(visit.tipoVisita)}">${escapeHtml(visit.tipoVisita || '-')}</span>
                                        ${canVendorTools && visit.vendedorGerente ? `<span class="item-seller">${escapeHtml(visit.vendedorGerente)}</span>` : ''}
                                    </div>
                                </div>
                            </button>
                            <div class="visit-card-actions">
                                ${state.canCreateProposalFunil && visit.cliente ? (() => {
                                    const _fi = funilItemFor(visit.cliente, visit.potencialCliente);
                                    if (!_fi) {
                                        return `<button class="visit-funil-btn" type="button" data-visit-funil="${escapeHtml(visit.id)}" data-cliente="${escapeHtml(visit.cliente || '')}" data-cidade="${escapeHtml(visit.cidade || '')}" data-foco="${escapeHtml(visit.potencialCliente || '')}" data-atuacao="${escapeHtml(visit.areaAtuacao || '')}" title="Adicionar ao Funil de Vendas" aria-label="Adicionar ao Funil de Vendas">📊</button>`;
                                    }
                                    const _alerta = funilEmAlerta(_fi);
                                    const _st = escapeHtml(String(_fi.status || _fi.Status || ''));
                                    return `<button class="visit-funil-btn is-in-funil${_alerta ? ' is-alert' : ''}" type="button" data-funil-id="${escapeHtml(String(_fi.id || _fi.Id || ''))}" title="No Funil${_st ? ' (' + _st + ')' : ''} — abrir" aria-label="Cliente já está no Funil de Vendas">${_alerta ? '⚠️' : '✅'}</button>`;
                                })() : ''}
                                <button class="visit-share-btn" type="button" data-share-id="${escapeHtml(visit.id)}" title="Compartilhar" aria-label="Compartilhar visita">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </section>
        `).join('');

        if (qeActive()) {
            visitsListContainer.classList.add('qe-layout');
            visitsListContainer.innerHTML = `
                <div class="qe-list">${groupsHtml}</div>
                <div class="qe-panel" id="qe-panel">
                    <p class="helper-text" style="padding:1.25rem;text-align:left">Clique numa visita da lista para anotar aqui — o painel fica fixo, é só ir clicando de uma pra outra.</p>
                </div>`;
        } else {
            qeSelectedId = null;
            visitsListContainer.classList.remove('qe-layout');
            visitsListContainer.innerHTML = groupsHtml;
        }

        visitsListContainer.querySelectorAll('[data-visit-id]').forEach((button) => {
            button.addEventListener('click', () => {
                if (qeActive()) { openVisitQuickPanel(button.dataset.visitId); return; }
                navigateTo('visit-detail', { id: button.dataset.visitId });
            });
        });
        visitsListContainer.querySelectorAll('[data-share-id]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const v = (state.visits || []).map(normalizeVisit).find(x => String(x.id) === btn.dataset.shareId);
                if (v) shareVisit(v);
            });
        });
        visitsListContainer.querySelectorAll('[data-visit-funil]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                state.funilPrefill = { cliente: btn.dataset.cliente || '', cidade: btn.dataset.cidade || '', foco: btn.dataset.foco || '', atuacao: btn.dataset.atuacao || '' };
                navigateTo('funil-new');
            });
        });
        visitsListContainer.querySelectorAll('[data-funil-id]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.funilId;
                if (id) navigateTo('funil-detail', { id });
                else navigateTo('funil');
            });
        });

        if (qeActive() && qeSelectedId) { openVisitQuickPanel(qeSelectedId); }
    };

    async function openVisitQuickPanel(id) {
        const panel = document.getElementById('qe-panel');
        if (!panel) { return; }
        const v = normalizedVisits.find((x) => String(x.id) === String(id));
        if (!v) { return; }
        if (_qeMenuOutsideClick) { document.removeEventListener('click', _qeMenuOutsideClick); _qeMenuOutsideClick = null; }
        qeSelectedId = String(id);
        document.querySelectorAll('#visits-list-container .visit-card').forEach((c) => {
            c.classList.toggle('qe-selected', c.dataset.visitId === qeSelectedId);
        });
        // Best-effort: sem formData ainda carregado, Cidade/Área/Potencial/Tipo
        // caem pra input de texto simples (sem travar o painel numa espera).
        const fd = state.formData || (await ensureFormData().then((r) => r.data).catch(() => null));
        const listaCidades = (fd && fd.cidades) || [];
        const listaAreas = (fd && fd.areasAtuacao) || [];
        const listaPotenciais = (fd && fd.potenciaisCliente) || [];
        const listaTipos = (fd && fd.tiposVisita || []).map((item) => item.tipo);
        const listaVendedores = (fd && fd.vendedores) || [];
        if (String(qeSelectedId) !== String(id) || document.getElementById('qe-panel') !== panel) { return; }

        const searchField = (label, fieldId, value, items) => `
            <div class="form-group"><label for="${fieldId}">${label}</label>
                <div class="searchable-select">
                    <input type="text" id="${fieldId}" value="${escapeHtml(value || '')}" autocomplete="off">
                    ${items ? `<div class="searchable-select-menu" id="${fieldId}-menu"></div>` : ''}
                </div>
            </div>`;
        const plainField = (label, fieldId, value, type = 'text') => `
            <div class="form-group"><label for="${fieldId}">${label}</label><input type="${type}" id="${fieldId}" value="${escapeHtml(value || '')}"></div>`;

        // Tipo: até 3 pílulas visíveis (a atual sempre entra, mesmo que não
        // esteja entre as 3 primeiras da lista) + um <select> "Mais..." com o
        // resto — Visitas tem tipos configuráveis (não um enum fixo pequeno
        // como Status do Funil/Proposta), então não cabe tudo em pílula.
        let visiblePills = listaTipos.slice(0, 3);
        if (v.tipoVisita && !visiblePills.includes(v.tipoVisita)) {
            visiblePills = [v.tipoVisita, ...visiblePills.slice(0, 2)];
        }
        const overflowTipos = listaTipos.filter((t) => !visiblePills.includes(t));
        const tipoInOverflow = v.tipoVisita && overflowTipos.includes(v.tipoVisita);


        panel.innerHTML = `
            <div class="qe-panel-inner">
                <div class="qe-v2-header">
                    <div>
                        <div class="qe-v2-title-row">
                            <strong class="qe-panel-title">${escapeHtml(v.cliente || 'Cliente')}</strong>
                            <span class="qe-v2-badge qe-v2-badge-dirty" id="qe-dirty-badge" hidden>Não salvo</span>
                        </div>
                        <p class="helper-text qe-v2-meta">📍 ${escapeHtml(v.cidade || '-')} &nbsp;·&nbsp; 👤 ${escapeHtml(v.vendedorGerente || '-')}</p>
                    </div>
                    <div class="qe-v2-header-actions">
                        <button type="button" class="primary-button" id="qe-save">💾 Salvar</button>
                        <div class="qe-v2-menu-wrap">
                            <button type="button" class="qe-v2-menu-toggle" id="qe-menu-toggle" aria-label="Mais opções">⋮</button>
                            <div class="qe-v2-menu" id="qe-menu">
                                <button type="button" id="qe-full">✏️ Editar tudo</button>
                            </div>
                        </div>
                    </div>
                </div>

                <p class="qe-v2-section-title">Tipo</p>
                <div class="qe-v2-type-row">
                    ${visiblePills.map((t) => `<button type="button" class="qe-status-btn${t === v.tipoVisita ? ' is-active' : ''}" data-t="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
                    ${overflowTipos.length ? `<select id="qe-tipo-mais" class="${tipoInOverflow ? 'is-active' : ''}">
                        <option value="">Mais...</option>
                        ${overflowTipos.map((t) => `<option value="${escapeHtml(t)}" ${t === v.tipoVisita ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
                    </select>` : ''}
                </div>

                <div class="qe-v2-stats">
                    <div class="qe-v2-stat">
                        <span>Data</span>
                        <div class="qe-v2-stat-value">
                            <input type="date" id="qe-data" value="${escapeHtml(v.dataVisitaInput || '')}" style="flex:1 1 auto">
                            <input type="time" id="qe-horario" value="${escapeHtml(v.horario || '')}" style="flex:0 0 auto;max-width:6.5em">
                        </div>
                    </div>
                    <div class="qe-v2-stat">
                        <span>Veículo</span>
                        <select id="qe-veiculo">${renderSimpleOptions(['Particular', 'Empresa'], v.veiculo || 'Particular')}</select>
                    </div>
                    ${state.canLancarDespesas ? `
                    <div class="qe-v2-stat">
                        <span>Despesas</span>
                        <label class="qe-v2-toggle">
                            <input type="checkbox" id="qe-despesas" ${v.teveDespesas === 'Sim' ? 'checked' : ''}>
                            <span class="qe-v2-toggle-slider"></span>
                        </label>
                    </div>` : ''}
                </div>
                ${state.canLancarDespesas ? `
                <div class="form-group" id="qe-valor-despesas-wrap" style="display:${v.teveDespesas === 'Sim' ? '' : 'none'};margin:-0.3rem 0 0.6rem">
                    <label for="qe-valor-despesas">Valor das despesas R$</label>
                    <input type="text" id="qe-valor-despesas" value="${escapeHtml(v.valorDespesas || '')}" placeholder="0,00" inputmode="decimal">
                </div>` : ''}

                <div class="qe-v2-section">
                    <p class="qe-v2-section-title">Cliente</p>
                    <div class="qe-v2-grid-2">
                        ${plainField('Cliente', 'qe-cliente', v.cliente)}
                        ${plainField('Contato', 'qe-contato', v.contato)}
                    </div>
                    <div class="qe-v2-grid-3">
                        ${searchField('Cidade', 'qe-cidade', v.cidade, listaCidades)}
                        ${searchField('Atuação', 'qe-area', v.areaAtuacao, listaAreas)}
                        <div class="form-group"><label for="qe-potencial">Potencial</label><select id="qe-potencial">${renderSimpleOptions(listaPotenciais, v.potencialCliente)}</select></div>
                    </div>
                    ${searchField('Vendedor', 'qe-vendedor', v.vendedorGerente, listaVendedores.map((x) => x.nome))}
                </div>

                <div class="qe-v2-section">
                    <p class="qe-v2-section-title">Observação</p>
                    <textarea id="qe-obs" rows="8">${escapeHtml(withDatedNoteHeader(v.observacao))}</textarea>
                </div>
            </div>`;

        initializeSearchableInput({ input: panel.querySelector('#qe-cidade'), menu: panel.querySelector('#qe-cidade-menu'), items: listaCidades, allowFreeText: true });
        initializeSearchableInput({ input: panel.querySelector('#qe-area'), menu: panel.querySelector('#qe-area-menu'), items: listaAreas, allowFreeText: true });
        initializeSearchableInput({ input: panel.querySelector('#qe-vendedor'), menu: panel.querySelector('#qe-vendedor-menu'), items: listaVendedores.map((x) => x.nome), allowFreeText: true });

        let selTipo = v.tipoVisita || '';
        let isDirty = false;
        const dirtyBadge = panel.querySelector('#qe-dirty-badge');
        const markDirty = () => { if (!isDirty) { isDirty = true; if (dirtyBadge) dirtyBadge.hidden = false; } };
        panel.addEventListener('input', markDirty);
        panel.addEventListener('change', markDirty);

        const tipoMais = panel.querySelector('#qe-tipo-mais');
        panel.querySelectorAll('.qe-v2-type-row .qe-status-btn').forEach((b) => b.addEventListener('click', () => {
            selTipo = b.dataset.t;
            panel.querySelectorAll('.qe-v2-type-row .qe-status-btn').forEach((x) => x.classList.toggle('is-active', x === b));
            if (tipoMais) { tipoMais.value = ''; tipoMais.classList.remove('is-active'); }
            markDirty();
        }));
        tipoMais?.addEventListener('change', () => {
            selTipo = tipoMais.value;
            tipoMais.classList.toggle('is-active', !!selTipo);
            if (selTipo) panel.querySelectorAll('.qe-v2-type-row .qe-status-btn').forEach((x) => x.classList.remove('is-active'));
            markDirty();
        });

        panel.querySelector('#qe-despesas')?.addEventListener('change', () => {
            const wrap = panel.querySelector('#qe-valor-despesas-wrap');
            if (wrap) wrap.style.display = panel.querySelector('#qe-despesas').checked ? '' : 'none';
        });

        const ta = panel.querySelector('#qe-obs');
        setTimeout(() => { ta.focus(); selectNoteHint(ta); }, 20);

        // Menu "⋮" — fecha ao clicar fora (listener em document removido e
        // reatribuído a cada abertura, pra não vazar entre trocas de card).
        const menuToggle = panel.querySelector('#qe-menu-toggle');
        const menu = panel.querySelector('#qe-menu');
        menuToggle?.addEventListener('click', (e) => {
            e.stopPropagation();
            const opening = !menu.classList.contains('is-open');
            menu.classList.toggle('is-open', opening);
            if (_qeMenuOutsideClick) { document.removeEventListener('click', _qeMenuOutsideClick); _qeMenuOutsideClick = null; }
            if (opening) {
                _qeMenuOutsideClick = (ev) => {
                    if (!menu.contains(ev.target) && ev.target !== menuToggle) {
                        menu.classList.remove('is-open');
                        document.removeEventListener('click', _qeMenuOutsideClick);
                        _qeMenuOutsideClick = null;
                    }
                };
                document.addEventListener('click', _qeMenuOutsideClick);
            }
        });

        panel.querySelector('#qe-full').addEventListener('click', () => navigateTo('visit-edit', { visit: v }));
        panel.querySelector('#qe-save').addEventListener('click', () => {
            const obs = stripEmptyDatedLine(ta.value);
            const cliente = panel.querySelector('#qe-cliente')?.value.trim();
            const contato = panel.querySelector('#qe-contato')?.value.trim();
            const cidade = panel.querySelector('#qe-cidade')?.value.trim();
            const areaAtuacao = panel.querySelector('#qe-area')?.value.trim();
            const potencialCliente = panel.querySelector('#qe-potencial')?.value || '';
            const tipoVisita = selTipo;
            const vendedorGerente = panel.querySelector('#qe-vendedor')?.value.trim();
            const dataInputValue = panel.querySelector('#qe-data')?.value || '';
            const dataVisita = dataInputValue ? formatDateFromDisplay(dataInputValue) : v.dataVisita;
            const horario = panel.querySelector('#qe-horario')?.value || v.horario;
            const veiculo = panel.querySelector('#qe-veiculo')?.value;
            const teveDespesas = state.canLancarDespesas ? (panel.querySelector('#qe-despesas')?.checked ? 'Sim' : 'Nao') : undefined;
            const valorDespesas = state.canLancarDespesas ? panel.querySelector('#qe-valor-despesas')?.value.trim() : undefined;
            if (teveDespesas === 'Sim' && !valorDespesas) {
                showToast('Informe o valor das despesas.', true);
                return;
            }
            if (!cliente || !cidade || !areaAtuacao || !tipoVisita) {
                showToast('Preencha Cliente, Cidade, Atuação e Tipo.', true);
                return;
            }
            setSaving(true, panel.querySelector('#qe-save'), 'Salvando...');
            showToast('Salvo.');
            if (dirtyBadge) dirtyBadge.hidden = true;
            applyVisitQuickPatch(v, {
                observacao: obs, cliente, contato, cidade, areaAtuacao, potencialCliente, tipoVisita,
                vendedorGerente, dataVisita, horario, veiculo, teveDespesas, valorDespesas
            }, () => {
                normalizedVisits = (state.visits || []).map(normalizeVisit).sort((a, b) => compareVisitsByDateDesc(a, b));
                renderFilteredVisits();
            });
        });
    }

    const _visitFilterIds = ['visit-filter-search', 'visit-filter-type', 'visit-filter-city', 'visit-filter-prospeccao',
        'visit-filter-area', 'visit-filter-potencial', 'visit-filter-veiculo', 'visit-filter-despesas',
        'visit-filter-period', 'visit-filter-vendor', 'visit-filter-date-from', 'visit-filter-date-to'];

    // Lembra os filtros entre re-renders da tela (recarregar em 2º plano,
    // sync automático, voltar de outra tela...) — mesmo padrão já usado em
    // Propostas (state.proposalFilters). Sem isso, qualquer um desses
    // gatilhos reconstruía o formulário do zero e o filtro "sumia" mesmo
    // sem o usuário ter tocado em "Limpar".
    state.visitFilters = state.visitFilters || {};
    _visitFilterIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el && state.visitFilters[id]) el.value = state.visitFilters[id];
    });

    const _visitTextFilterIds = new Set(['visit-filter-search']);
    const _debouncedVisitFilter = debounce(renderFilteredVisits, 250);
    _visitFilterIds.forEach((id) => {
            const element = document.getElementById(id);
            if (!element) {
                return;
            }
            const remember = () => { state.visitFilters[id] = element.value; };
            const isText = _visitTextFilterIds.has(id);
            if (isText) { element.addEventListener('input', () => { remember(); _debouncedVisitFilter(); }); }
            // 'change' pega tanto os <select> quanto o clique numa opção do
            // filtro de múltipla escolha (Vendedor/Cidade/Tipo), que só dispara
            // 'change'.
            element.addEventListener('change', () => { remember(); renderFilteredVisits(); });
        });

    const syncVisitMultiCheckLabels = () => {
        syncMultiCheckFilterLabel('visit-filter-type-trigger', 'visit-filter-type');
        syncMultiCheckFilterLabel('visit-filter-city-trigger', 'visit-filter-city');
        syncMultiCheckFilterLabel('visit-filter-area-trigger', 'visit-filter-area', 'Todas');
        syncMultiCheckFilterLabel('visit-filter-potencial-trigger', 'visit-filter-potencial');
        syncMultiCheckFilterLabel('visit-filter-veiculo-trigger', 'visit-filter-veiculo');
        syncMultiCheckFilterLabel('visit-filter-vendor-trigger', 'visit-filter-vendor');
    };
    syncVisitMultiCheckLabels();

    document.getElementById('visit-filters-clear')?.addEventListener('click', () => {
        _visitFilterIds.forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; } });
        state.visitFilters = {};
        syncVisitMultiCheckLabels();
        state.visitsYearFilter = null;
        const scopeSelect = document.getElementById('visit-scope-select');
        if (scopeSelect && scopeSelect.value !== '90') { scopeSelect.value = '90'; applyVisitsScopeChange('90'); }
        renderFilteredVisits();
        updateYearSelect();
    });

    // Exposto pro toggle "Edição rápida" que fica no cabeçalho da página
    // (renderVisitsPage) — de lá não dá pra chamar esta closure direto.
    _visitsRenderFiltered = renderFilteredVisits;

    document.getElementById('visits-csv-btn')?.addEventListener('click', () => {
        if (!lastFilteredVisits.length) { showToast('Nenhuma visita para os filtros selecionados.', true); return; }
        const stamp = new Date().toISOString().slice(0, 10);
        downloadXLSX(lastFilteredVisits, `visitas-${stamp}.xlsx`, [
            { key: 'dataVisita', label: 'Data da Visita' },
            { key: 'vendedorGerente', label: 'Vendedor' },
            { key: 'cliente', label: 'Nome do Cliente' },
            { key: 'tipoVisita', label: 'Tipo da Visita' },
            { key: 'teveDespesas', label: 'Teve Despesas' },
            { key: 'valorDespesas', label: 'Valor R$' }
        ], 'Visitas');
    });

    // "Carregar últimos" — select único no lugar do antigo input+"Carregar"
    // +"Ver tudo". Dia-count reusa o mesmo caminho de sempre (recarrega a
    // página com state.loadDias novo); "Tudo" reusa o fetch-all em memória
    // que já existia (sem navegar/recarregar a tela inteira).
    async function applyVisitsScopeChange(value) {
        if (value === 'all') {
            const listEl = document.getElementById('visits-list-container');
            if (listEl) listEl.innerHTML = `<div class="scope-loading">Carregando histórico completo...</div>`;
            try {
                const r = await callAPI('getVisits', { user: state.currentUser, meses: 0 });
                if (r.status === 'success') {
                    state.visits = r.visits || [];
                    state.visitsScope = 'all';
                    saveCache('visits_all', state.visits);
                    normalizedVisits = state.visits.map((v) => normalizeVisit(v)).sort((a, b) => compareVisitsByDateDesc(a, b));
                    wireMultiCheckFilter({ triggerId: 'visit-filter-type-trigger', inputId: 'visit-filter-type', menuId: 'visit-filter-type-menu', options: Array.from(new Set(normalizedVisits.map((v) => v.tipoVisita).filter(Boolean))).sort() });
                    wireMultiCheckFilter({ triggerId: 'visit-filter-city-trigger', inputId: 'visit-filter-city', menuId: 'visit-filter-city-menu', options: Array.from(new Set(normalizedVisits.map((v) => v.cidade).filter(Boolean))).sort() });
                    wireMultiCheckFilter({ triggerId: 'visit-filter-area-trigger', inputId: 'visit-filter-area', menuId: 'visit-filter-area-menu', options: Array.from(new Set(normalizedVisits.map((v) => v.areaAtuacao).filter(Boolean))).sort(), emptyLabel: 'Todas' });
                    wireMultiCheckFilter({ triggerId: 'visit-filter-potencial-trigger', inputId: 'visit-filter-potencial', menuId: 'visit-filter-potencial-menu', options: Array.from(new Set(normalizedVisits.map((v) => v.potencialCliente).filter(Boolean))).sort() });
                    wireMultiCheckFilter({ triggerId: 'visit-filter-veiculo-trigger', inputId: 'visit-filter-veiculo', menuId: 'visit-filter-veiculo-menu', options: Array.from(new Set(normalizedVisits.map((v) => v.veiculo).filter(Boolean))).sort() });
                    if (canVendorTools) wireMultiCheckFilter({ triggerId: 'visit-filter-vendor-trigger', inputId: 'visit-filter-vendor', menuId: 'visit-filter-vendor-menu', options: Array.from(new Set(normalizedVisits.map((v) => v.vendedorGerente).filter(Boolean))).sort() });
                    renderFilteredVisits();
                    updateYearSelect();
                }
            } catch (e) {}
            return;
        }
        const v = parseInt(value, 10);
        if (v > 0) { state.loadDias = v; saveCache('visits', null); navigateTo('visits'); }
    }
    document.getElementById('visit-scope-select')?.addEventListener('change', (e) => applyVisitsScopeChange(e.target.value));

    function updateYearSelect() {
        const dates = normalizedVisits.map((v) => parseDisplayDate(v.dataVisita));
        wireYearSelect('visit-year-select', dates, state.visitsYearFilter, (year) => {
            state.visitsYearFilter = year;
            renderFilteredVisits();
        });
    }
    updateYearSelect();

    renderFilteredVisits();

    // Carrega o Funil em 2º plano só pra marcar os clientes que já estão
    // nele (ícone ✅/⚠️ no card). Re-renderiza a lista quando chegar.
    if (state.canCreateProposalFunil && (!Array.isArray(state.funil) || !state.funil.length)) {
        ensureFunilForDedup().then(() => {
            if (state.currentPage === 'visits') renderFilteredVisits();
        });
    }
}


export async function renderVisitsPage() {
    ensureStyles('visits');
    // Edição rápida sempre começa desligada — o usuário liga clicando.
    try { localStorage.removeItem('visits_quick_edit'); } catch (e) {}
    document.getElementById('main-content')?.classList.remove('qe-focus');
    const mainContent = document.getElementById('main-content');
    const cachedAllRaw = loadCache('visits_all');
    const cached3mRaw  = loadCache('visits');
    const cachedAll = (Array.isArray(cachedAllRaw) && cachedAllRaw.length > 0) ? cachedAllRaw : null;
    const cached3m  = (Array.isArray(cached3mRaw) && cached3mRaw.length > 0) ? cached3mRaw : null;
    const cachedVisits = cachedAll || cached3m;
    const vpIsAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const vpQeOn = vpIsAdmin && (() => { try { return localStorage.getItem('visits_quick_edit') === '1'; } catch (e) { return false; } })();
    mainContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Visitas</h2>
                <p class="page-subtitle">Historico e registro de visitas</p>
            </div>
            <div class="page-header-actions">
                ${isAdminOrGerenteUser() ? `<button type="button" class="text-link" id="visits-nova-campanha" title="Pedir pra um vendedor completar um relatório de visita">📋 Relatório de Visita</button>` : ''}
                ${vpIsAdmin ? `<button type="button" class="text-link qe-toggle${vpQeOn ? ' is-on' : ''}" id="visits-qe-toggle" title="Anotar na mesma tela, uma visita após a outra">⚡ Edição rápida</button>` : ''}
                <button class="primary-btn" id="btn-new-visit" type="button">+ Nova Visita</button>
            </div>
        </div>
        <div id="visits-content">${cachedVisits ? '' : loadingState('📋', 'Carregando suas visitas...')}</div>
    `;
    document.getElementById('btn-new-visit').addEventListener('click', () => navigateTo('visit-new'));
    document.getElementById('visits-nova-campanha')?.addEventListener('click', async () => {
        const { openGerarCampanhaVisitaModal } = await import('./campanhas.js');
        openGerarCampanhaVisitaModal();
    });
    document.getElementById('visits-qe-toggle')?.addEventListener('click', (e) => {
        const on = (() => { try { return localStorage.getItem('visits_quick_edit') === '1'; } catch (err) { return false; } })();
        try { localStorage.setItem('visits_quick_edit', on ? '0' : '1'); } catch (err) {}
        e.currentTarget.classList.toggle('is-on', !on);
        // Ao LIGAR: esconde busca/filtros/período (só lista + painel) e rola
        // pro topo da lista. Ao DESLIGAR: mostra tudo de novo e volta ao topo.
        const goingOn = !on;
        document.getElementById('main-content')?.classList.toggle('qe-focus', goingOn);
        _visitsRenderFiltered?.();
        requestAnimationFrame(() => {
            // Modo foco já colapsa o cabeçalho — o topo passa a ser a lista.
            document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'auto' });
            window.scrollTo({ top: 0, behavior: 'auto' });
        });
    });

    if (cachedVisits) {
        state.visitsScope = cachedAll ? 'all' : '3m';
        state.visits = cachedVisits;
        const visitsContent = document.getElementById('visits-content');
        if (visitsContent) { fillVisitsContent(visitsContent, state.visits); }
        addScrollTop();

        initSearchBarAutoHide();
        initPullToRefresh(async () => {
            const r = await getVisits(state.visitsScope === 'all' ? 0 : undefined);
            if (r.status === 'success' && state.currentPage === 'visits') {
                state.visits = r.visits || [];
                const el = document.getElementById('visits-content');
                if (el) { fillVisitsContent(el, state.visits); }
            }
        });
        // Antes: getVisits(3) — refresh "incremental" de 3 dias. Só que sem
        // 'since' válido (o timestamp de sync expira em 24h) o merge não roda
        // e a lista era substituída por só os últimos 3 dias. Recarrega a
        // janela cheia (loadDias); quando há 'since' o backend já devolve só
        // o delta, então continua barato.
        getVisits(cachedAll ? 0 : undefined);
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
    addScrollTop();

    initSearchBarAutoHide();
    initPullToRefresh(async () => {
            const r = await getVisits(state.visitsScope === 'all' ? 0 : undefined);
            if (r.status === 'success' && state.currentPage === 'visits') {
                state.visits = r.visits || [];
                const el = document.getElementById('visits-content');
                if (el) { fillVisitsContent(el, state.visits); }
            }
        });
}


export async function renderCalendarPage(options) {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = skeletonList(5);
    // A Agenda não tem botão de "voltar ao topo" próprio — remove um
    // eventual leftover deixado pela página anterior.
    document.getElementById('page-scroll-top')?.remove();

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
    const agResult = await callAPI('getAgendamentos', { user: state.currentUser });
    state.agendamentos = agResult.status === 'success' ? (agResult.agendamentos || []) : [];
    // Pro botão "Notificar" nos cards de retorno já existente — mesma regra
    // de quem pode notificar quem usada na criação (Novo agendamento/Funil).
    const fdCalendar = await ensureFormData().then((r) => r.data).catch(() => null);
    const notifyOptionsAg = resolveNotifyOptions((fdCalendar && fdCalendar.vendedores) || [], state.currentUser);

    const visits       = state.visits.map(normalizeVisit);
    const proposals    = (state.proposals || []).map(normalizeProposal);
    const funil        = (state.funil || []);
    const agendamentos = (state.agendamentos || []).filter((a) => a.status === 'Pendente');

    const VISIT_COLORS = [
        '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
        '#06b6d4','#f97316','#84cc16','#ec4899','#6366f1'
    ];
    const typeColorMap = {};
    const types = Array.from(new Set(visits.map((v) => v.tipoVisita).filter(Boolean)));
    types.forEach((t, i) => { typeColorMap[t] = VISIT_COLORS[i % VISIT_COLORS.length]; });

    const PROPOSAL_COLOR = '#0ea5e9';
    const FUNIL_COLOR    = '#22c55e';
    const AGENDAMENTO_COLOR = '#a855f7';

    // Reaproveitado tanto pelo painel do dia clicado quanto pela lista
    // "todos os agendamentos" sempre visível abaixo do calendário — só a
    // fonte da lista (dia vs. tudo) muda entre os dois usos.
    const agendamentoCardHtml = (a, { showDate = false } = {}) => {
        const dias = -calculateDaysFromDisplayDate(a.dataAgendada);
        const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'Amanhã' : dias > 0 ? `Em ${dias} dias` : 'Atrasado';
        const diasCor = dias < 0 ? 'erro' : dias <= 1 ? 'apresentacao' : 'preventiva';
        const icon = a.campanhaOrigemId ? '🔗' : '📌';
        return `
        <div class="card" data-agendamento-id="${escapeHtml(a.id)}" style="margin-bottom:0.4rem">
            <div class="item-top">
                <span class="item-name">${icon} ${escapeHtml(a.cliente || '-')}</span>
                ${showDate
                    ? `<span class="status-tag ${diasCor}">${diasLabel}</span>`
                    : `<span class="status-tag preventiva">Retorno agendado</span>`}
            </div>
            <div class="item-meta">${escapeHtml([a.campanhaOrigemId && a.vendedor ? `👤 ${a.vendedor}` : '', a.cidade, showDate ? a.dataAgendada : '', a.observacao].filter(Boolean).join(' · ')) || '-'}</div>
            <div class="ag-actions-row" style="display:flex;gap:0.9rem;margin-top:0.5rem;flex-wrap:wrap">
                <button type="button" class="text-link" data-ag-done="${escapeHtml(a.id)}">Concluído</button>
                <button type="button" class="text-link" data-ag-cancel="${escapeHtml(a.id)}">Cancelar</button>
                <button type="button" class="text-link" data-ag-edit-date="${escapeHtml(a.id)}">Mudar data</button>
                <button type="button" class="text-link" data-ag-edit-obs="${escapeHtml(a.id)}">Editar texto</button>
                <button type="button" class="text-link" data-ag-ics="${escapeHtml(a.id)}">Salvar na agenda</button>
                <button type="button" class="text-link" data-ag-share="${escapeHtml(a.id)}">Compartilhar</button>
                ${notifyOptionsAg.length ? `<button type="button" class="text-link" data-ag-notify="${escapeHtml(a.id)}">Notificar</button>` : ''}
            </div>
            <div class="ag-edit-date-row" style="display:none;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap">
                <input type="date" class="ag-edit-date-input" value="${escapeHtml(formatInputDateFromDisplay(a.dataAgendada) || '')}">
                <button type="button" class="text-link" data-ag-save-date="${escapeHtml(a.id)}">Salvar</button>
                <button type="button" class="text-link" data-ag-cancel-date="${escapeHtml(a.id)}">Cancelar</button>
            </div>
            <div class="ag-edit-obs-row" style="display:none;flex-direction:column;gap:0.5rem;margin-top:0.5rem">
                <textarea class="ag-edit-obs-input" rows="2" placeholder="Observação">${escapeHtml(a.observacao || '')}</textarea>
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                    <button type="button" class="text-link" data-ag-save-obs="${escapeHtml(a.id)}">Salvar</button>
                    <button type="button" class="text-link" data-ag-cancel-obs="${escapeHtml(a.id)}">Cancelar</button>
                </div>
            </div>
        </div>`;
    };

    // Overlay avulso (não fica embutido no card) de propósito: o mesmo
    // agendamento pode estar renderizado 2x na tela ao mesmo tempo (painel
    // do dia + lista "todos os agendamentos"), e wireMultiCheckFilter usa
    // document.getElementById — um campo embutido no card duplicaria id.
    // Criado sob demanda no clique e removido ao fechar, então nunca há mais
    // de uma instância no documento.
    // Modal em 3 partes (cabeçalho fixo / corpo rolável / rodapé fixo) com
    // UMA área de rolagem só (a lista) — não usa multiCheckFilterFieldHtml/
    // wireMultiCheckFilter aqui de propósito: aquele padrão abre a lista
    // como um menu "position:absolute" flutuando por cima do card, que
    // dentro de um modal já com overflow-y:auto acabava criando DUAS barras
    // de rolagem (a do menu e a do modal) e empurrando Cancelar/Enviar pra
    // fora da área visível. Lista sempre aberta, embutida no corpo, resolve
    // isso de vez.
    const openNotificarAgendamentoModal = (a) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const optionsHtml = notifyOptionsAg.length
            ? notifyOptionsAg.map((nome) => `
                <label class="agnotify-list-item">
                    <input type="checkbox" class="agnotify-check" value="${escapeHtml(nome)}">
                    <span>${escapeHtml(nome)}</span>
                </label>`).join('')
            : `<p class="helper-text" style="text-align:center;padding:0.5rem 0">Nenhum destinatário disponível.</p>`;
        overlay.innerHTML = `
            <div class="modal-card agnotify-modal" style="text-align:left">
                <div class="agnotify-modal-header">
                    <h3>📣 Notificar sobre este retorno</h3>
                    <p class="helper-text">${escapeHtml(a.cliente || 'Cliente')}${a.dataAgendada ? ` — ${escapeHtml(a.dataAgendada)}` : ''}</p>
                </div>
                <div class="agnotify-modal-body">
                    ${notifyOptionsAg.length ? `<input type="text" class="form-input" id="agnotify-search" placeholder="Buscar pessoa...">
                    <label class="agnotify-select-all-row"><input type="checkbox" id="agnotify-select-all"> Selecionar todos</label>` : ''}
                    <div class="agnotify-list" id="agnotify-list">${optionsHtml}</div>
                </div>
                <div class="agnotify-modal-footer form-actions full-width">
                    <button type="button" class="secondary-button" id="agnotify-cancel">Cancelar</button>
                    <button type="button" class="primary-button" id="agnotify-send">Enviar</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const listEl = overlay.querySelector('#agnotify-list');
        const searchEl = overlay.querySelector('#agnotify-search');
        const selectAllEl = overlay.querySelector('#agnotify-select-all');
        const getChecks = () => Array.from(listEl.querySelectorAll('.agnotify-check'));

        searchEl?.addEventListener('input', () => {
            const q = searchEl.value.trim().toLowerCase();
            listEl.querySelectorAll('.agnotify-list-item').forEach((row) => {
                const nome = row.querySelector('.agnotify-check').value.toLowerCase();
                row.style.display = !q || nome.includes(q) ? '' : 'none';
            });
        });
        selectAllEl?.addEventListener('change', () => {
            getChecks().forEach((c) => { if (c.closest('.agnotify-list-item').style.display !== 'none') c.checked = selectAllEl.checked; });
        });

        const close = () => overlay.remove();
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('#agnotify-cancel').addEventListener('click', close);
        overlay.querySelector('#agnotify-send').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const selecionados = getChecks().filter((c) => c.checked).map((c) => c.value);
            if (!selecionados.length) { showToast('Escolha ao menos um usuário.', true); return; }
            setSaving(true, btn, 'Enviando...');
            const r = await callAPI('notifyRegistroCriado', {
                destinatarios: selecionados, tipo: 'agendamento', cliente: a.cliente, detalhe: a.dataAgendada,
                user: state.currentUser
            }).catch((err) => ({ status: 'error', message: err.message }));
            if (r && r.status === 'success') { showToast('Notificação enviada.'); close(); }
            else { showToast((r && r.message) || 'Não foi possível notificar.', true); setSaving(false, btn); }
        });
    };

    // Modal "ver texto e copiar" pro botão "Compartilhar" dos cards de
    // retorno — antes chamava navigator.share() direto, que no desktop
    // abre o painel nativo do Windows (pesado, cheio de apps tipo Teams/
    // Copilot que não fazem sentido aqui) sem deixar a pessoa nem ver o
    // texto antes. Mostra o texto pra conferir e um botão de copiar;
    // "Compartilhar" (nativo) continua disponível como atalho a mais só
    // onde o navegador suporta.
    const showCompartilharTextoModal = (titulo, texto) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card" style="text-align:left">
                <h3 style="margin-top:0">📤 ${escapeHtml(titulo)}</h3>
                <textarea readonly class="form-input" rows="7" style="resize:none;width:100%;margin-bottom:0.5rem">${escapeHtml(texto)}</textarea>
                <button type="button" class="primary-button" id="share-text-copy">📋 Copiar texto</button>
                ${navigator.share ? `<button type="button" class="secondary-button" id="share-text-native">Compartilhar</button>` : ''}
                <button type="button" class="secondary-button" id="share-text-close">Fechar</button>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('#share-text-copy').addEventListener('click', () => {
            navigator.clipboard?.writeText(texto).then(() => showToast('Texto copiado.'));
        });
        overlay.querySelector('#share-text-native')?.addEventListener('click', () => {
            navigator.share({ title: titulo, text: texto }).catch(() => {});
        });
        overlay.querySelector('#share-text-close').addEventListener('click', close);
    };

    // Escopado por elemento (closest/querySelector), nunca por id global —
    // o painel do dia e a lista "todos os agendamentos" podem exibir o
    // mesmo agendamento ao mesmo tempo, e ids duplicados no documento
    // quebrariam document.getElementById (pega sempre o primeiro).
    const bindAgendamentoRowActions = (container, sourceList, opts = {}) => {
        const onMutated = opts.onMutated || (() => {});
        container.querySelectorAll('[data-ag-done]').forEach((b) => {
            b.addEventListener('click', async () => {
                setSaving(true, b, '');
                const id = b.dataset.agDone;
                const r = await callAPI('updateAgendamento', { id, status: 'Concluido', user: state.currentUser });
                if (r && r.status === 'success') {
                    const found = state.agendamentos.find((item) => String(item.id) === id);
                    if (found) found.status = 'Concluido';
                    const agData = sourceList.find((item) => String(item.id) === id);
                    b.closest('[data-agendamento-id]')?.remove();
                    showToast('Retorno concluído. Registre a visita.');
                    onMutated();
                    navigateTo('visit-new', { prefill: { Cliente: agData?.cliente || '', Cidade: agData?.cidade || '' } });
                } else {
                    showToast((r && r.message) || 'Erro ao atualizar agendamento.', true);
                    setSaving(false, b);
                }
            });
        });
        container.querySelectorAll('[data-ag-cancel]').forEach((b) => {
            b.addEventListener('click', async () => {
                if (!confirm('Cancelar este agendamento?')) return;
                setSaving(true, b, '');
                const id = b.dataset.agCancel;
                const r = await callAPI('updateAgendamento', { id, status: 'Cancelado', user: state.currentUser });
                if (r && r.status === 'success') {
                    const found = state.agendamentos.find((item) => String(item.id) === id);
                    if (found) found.status = 'Cancelado';
                    showToast('Agendamento cancelado.');
                    b.closest('[data-agendamento-id]')?.remove();
                    onMutated();
                } else {
                    showToast((r && r.message) || 'Erro ao cancelar agendamento.', true);
                    setSaving(false, b);
                }
            });
        });
        container.querySelectorAll('[data-ag-ics]').forEach((b) => {
            b.addEventListener('click', () => {
                const a = sourceList.find((item) => String(item.id) === b.dataset.agIcs);
                if (!a) return;
                const dt = parseDisplayDate(a.dataAgendada);
                const dateStr = dt ? dt.toISOString().slice(0, 10) : '';
                openIcsEvent({
                    title: `Retorno: ${a.cliente || ''}`,
                    description: a.observacao || 'Visita de retorno agendada pelo App de Visitas.',
                    dateStr
                });
            });
        });
        container.querySelectorAll('[data-ag-share]').forEach((b) => {
            b.addEventListener('click', async () => {
                const a = sourceList.find((item) => String(item.id) === b.dataset.agShare);
                if (!a) return;

                let texto;
                if (a.campanhaOrigemId) {
                    // Retorno gerado por prazo de campanha — reenvia o link +
                    // instrução de login, igual ao que foi mandado na hora.
                    const fd = await ensureFormData().then((r) => r.data).catch(() => null);
                    const vendedorRow = ((fd && fd.vendedores) || []).find((v) => v.nome === a.vendedor);
                    const loginNome = vendedorRow?.nomeLogin || '';
                    const n = loginNome ? `&n=${encodeURIComponent(loginNome)}` : '';
                    const link = `${window.location.origin}/?c=${a.campanhaOrigemId}${n}`;
                    const primeiroNome = String(a.vendedor || '').split(' ')[0] || '';
                    texto = [
                        `Oi ${primeiroNome}! Lembrete: ${a.cliente || ''}`,
                        a.observacao ? a.observacao : '',
                        `Prazo: ${a.dataAgendada}`,
                        loginNome
                            ? `Pra entrar, é só abrir o link e informar seu PIN (4 últimos números do seu celular) — seu login já vem preenchido.`
                            : `Pra entrar: login é seu nome (em minúsculo) e PIN são os 4 últimos números do seu celular.`,
                        link
                    ].filter(Boolean).join('\n');
                } else {
                    // Retorno normal — resumo simples, sem link nenhum.
                    texto = [
                        `📌 Retorno: ${a.cliente || ''}`,
                        a.cidade || '',
                        `Data: ${a.dataAgendada}`,
                        a.observacao ? a.observacao : ''
                    ].filter(Boolean).join('\n');
                }

                showCompartilharTextoModal(a.cliente || 'Retorno', texto);
            });
        });
        container.querySelectorAll('[data-ag-notify]').forEach((b) => {
            b.addEventListener('click', () => {
                const a = sourceList.find((item) => String(item.id) === b.dataset.agNotify);
                if (a) openNotificarAgendamentoModal(a);
            });
        });
        container.querySelectorAll('[data-ag-edit-date]').forEach((b) => {
            b.addEventListener('click', () => {
                const row = b.closest('[data-agendamento-id]');
                row.querySelector('.ag-actions-row').style.display = 'none';
                row.querySelector('.ag-edit-date-row').style.display = 'flex';
            });
        });
        container.querySelectorAll('[data-ag-cancel-date]').forEach((b) => {
            b.addEventListener('click', () => {
                const row = b.closest('[data-agendamento-id]');
                row.querySelector('.ag-edit-date-row').style.display = 'none';
                row.querySelector('.ag-actions-row').style.display = 'flex';
            });
        });
        container.querySelectorAll('[data-ag-save-date]').forEach((b) => {
            b.addEventListener('click', async () => {
                const row = b.closest('[data-agendamento-id]');
                const newDate = row.querySelector('.ag-edit-date-input')?.value;
                if (!newDate) { showToast('Informe a nova data.', true); return; }
                setSaving(true, b, 'Salvando...');
                const id = b.dataset.agSaveDate;
                const r = await callAPI('updateAgendamento', { id, dataAgendada: newDate, user: state.currentUser });
                if (r && r.status === 'success') {
                    const found = state.agendamentos.find((item) => String(item.id) === id);
                    if (found) found.dataAgendada = r.agendamento?.dataAgendada || found.dataAgendada;
                    showToast('Data do retorno atualizada.');
                    // A data pode ter mudado pra outro dia — some do painel
                    // do dia (o grid não recalcula os pontos sem recarregar
                    // a Agenda); onMutated já atualiza a lista completa.
                    row.remove();
                    onMutated();
                } else {
                    showToast((r && r.message) || 'Erro ao atualizar a data.', true);
                    setSaving(false, b);
                }
            });
        });
        container.querySelectorAll('[data-ag-edit-obs]').forEach((b) => {
            b.addEventListener('click', () => {
                const row = b.closest('[data-agendamento-id]');
                row.querySelector('.ag-actions-row').style.display = 'none';
                row.querySelector('.ag-edit-obs-row').style.display = 'flex';
                row.querySelector('.ag-edit-obs-input')?.focus();
            });
        });
        container.querySelectorAll('[data-ag-cancel-obs]').forEach((b) => {
            b.addEventListener('click', () => {
                const row = b.closest('[data-agendamento-id]');
                row.querySelector('.ag-edit-obs-row').style.display = 'none';
                row.querySelector('.ag-actions-row').style.display = 'flex';
            });
        });
        container.querySelectorAll('[data-ag-save-obs]').forEach((b) => {
            b.addEventListener('click', async () => {
                const row = b.closest('[data-agendamento-id]');
                const newObs = row.querySelector('.ag-edit-obs-input')?.value.trim() || '';
                setSaving(true, b, 'Salvando...');
                const id = b.dataset.agSaveObs;
                const r = await callAPI('updateAgendamento', { id, observacao: newObs, user: state.currentUser });
                if (r && r.status === 'success') {
                    const found = state.agendamentos.find((item) => String(item.id) === id);
                    if (found) found.observacao = r.agendamento?.observacao ?? newObs;
                    const item = sourceList.find((x) => String(x.id) === id);
                    if (item) item.observacao = r.agendamento?.observacao ?? newObs;
                    showToast('Observação atualizada.');
                    onMutated();
                    row.querySelector('.ag-edit-obs-row').style.display = 'none';
                    row.querySelector('.ag-actions-row').style.display = 'flex';
                    const metaEl = row.querySelector('.item-meta');
                    if (metaEl) {
                        metaEl.textContent = [item?.campanhaOrigemId && item?.vendedor ? `👤 ${item.vendedor}` : '', item?.cidade, item?.dataAgendada, newObs].filter(Boolean).join(' · ') || '-';
                    }
                } else {
                    showToast((r && r.message) || 'Erro ao salvar a observação.', true);
                    setSaving(false, b);
                }
            });
        });
    };

    const renderAgendamentosSection = () => {
        const sectionEl = document.getElementById('cal-agendamentos-section');
        if (!sectionEl) return;
        // Mesmo critério dos pontos/painel do dia no calendário (showRetornos/
        // agendamentosParaGrade, mais abaixo em render()) — Visitas/Propostas/
        // Funil não têm retorno agendado, então a seção some; "Campanha" é um
        // recorte de Retornos, só os gerados por prazo de campanha.
        const showRetornos = activeFilter === 'todos' || activeFilter === 'retornos' || activeFilter === 'campanha';
        if (!showRetornos) {
            sectionEl.style.display = 'none';
            sectionEl.innerHTML = '';
            return;
        }
        sectionEl.style.display = '';

        // Só os retornos do mês/ano que o calendário está mostrando — antes
        // a lista trazia TODOS os pendentes, de qualquer mês, o que não
        // batia com o mês exibido no calendário acima. viewYear/viewMonth
        // são as mesmas variáveis que o grid do calendário usa (fechamento
        // sobre o escopo de renderCalendarPage), então navegar com ←/→
        // chama render() → renderAgendamentosSection() de novo já filtrado
        // pro novo mês, sem precisar de nenhum outro fio.
        const pending = (state.agendamentos || [])
            .filter((a) => a.status === 'Pendente')
            .filter((a) => activeFilter !== 'campanha' || a.campanhaOrigemId)
            .filter((a) => {
                const d = parseDisplayDate(a.dataAgendada);
                return d && d.getFullYear() === viewYear && d.getMonth() === viewMonth;
            })
            .sort((a, b) => {
                const da = parseDisplayDate(a.dataAgendada);
                const db = parseDisplayDate(b.dataAgendada);
                return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
            });

        const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        const monthLabelCap = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

        if (pending.length === 0) {
            sectionEl.innerHTML = `
                <div class="visit-month-header"><h3>📌 Retornos agendados</h3></div>
                <p class="helper-text" style="text-align:center;padding:0.5rem 0">Nenhum retorno agendado para ${escapeHtml(monthLabelCap)}.</p>
            `;
            return;
        }

        sectionEl.innerHTML = `
            <div class="visit-month-header"><h3>📌 Retornos agendados — ${escapeHtml(monthLabelCap)}</h3><span>${pending.length} pendente(s)</span></div>
            <div class="visits-list">${pending.map((a) => agendamentoCardHtml(a, { showDate: true })).join('')}</div>
        `;
        bindAgendamentoRowActions(sectionEl, pending, { onMutated: renderAgendamentosSection });
    };

    let viewYear  = new Date().getFullYear();
    let viewMonth = new Date().getMonth();
    // 'todos' | 'visitas' | 'propostas' | 'funil' | 'retornos' — "Próximos
    // retornos" na Home já abre aqui filtrado, em vez de cair sempre em
    // "Todos" e o usuário precisar clicar no chip de novo.
    let activeFilter = (options && options.filter) || 'todos';
    // Legenda nasce oculta toda vez que a Agenda é aberta (ela já tem
    // muitos tipos numa lista longa) — quem quiser vê-la, clica pra abrir;
    // fica assim (aberta/fechada) enquanto navega entre meses/filtros na
    // mesma visita à tela, mas volta a nascer oculta na próxima vez.
    let legendVisible = false;

    const render = () => {
        const firstDay  = new Date(viewYear, viewMonth, 1);
        const lastDay   = new Date(viewYear, viewMonth + 1, 0);
        const startDow  = firstDay.getDay();
        const monthName = firstDay.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

        const visitsByDay      = {};
        const proposalsByDay   = {};
        const funilByDay       = {};
        const agendamentosByDay = {};

        const showVisitas   = activeFilter === 'todos' || activeFilter === 'visitas';
        const showPropostas = activeFilter === 'todos' || activeFilter === 'propostas';
        const showFunil     = activeFilter === 'todos' || activeFilter === 'funil';
        const showRetornos  = activeFilter === 'todos' || activeFilter === 'retornos' || activeFilter === 'campanha';
        // "Campanha" é um subconjunto de Retornos — só os agendamentos
        // gerados automaticamente por prazo de campanha (ver
        // campanhas.js/createAgendamentoInterno), não todo retorno.
        const agendamentosParaGrade = activeFilter === 'campanha'
            ? agendamentos.filter((a) => a.campanhaOrigemId)
            : agendamentos;

        if (showVisitas) visits.forEach((v) => {
            const d = parseDisplayDate(v.dataVisita);
            if (!d || d.getFullYear() !== viewYear || d.getMonth() !== viewMonth) { return; }
            const key = d.getDate();
            if (!visitsByDay[key]) { visitsByDay[key] = []; }
            visitsByDay[key].push(v);
        });
        if (showPropostas) proposals.forEach((p) => {
            const d = parseDisplayDate(p.data || p.atualizacao);
            if (!d || d.getFullYear() !== viewYear || d.getMonth() !== viewMonth) { return; }
            const key = d.getDate();
            if (!proposalsByDay[key]) { proposalsByDay[key] = []; }
            proposalsByDay[key].push(p);
        });
        if (showFunil) funil.forEach((f) => {
            const d = parseDisplayDate(f.data || f.atualizacao);
            if (!d || d.getFullYear() !== viewYear || d.getMonth() !== viewMonth) { return; }
            const key = d.getDate();
            if (!funilByDay[key]) { funilByDay[key] = []; }
            funilByDay[key].push(f);
        });
        if (showRetornos) agendamentosParaGrade.forEach((a) => {
            const d = parseDisplayDate(a.dataAgendada);
            if (!d || d.getFullYear() !== viewYear || d.getMonth() !== viewMonth) { return; }
            const key = d.getDate();
            if (!agendamentosByDay[key]) { agendamentosByDay[key] = []; }
            agendamentosByDay[key].push(a);
        });

        const todayStr = new Date().toDateString();
        const cells = [];
        for (let i = 0; i < startDow; i++) { cells.push(`<div class="cal-cell cal-cell-empty"></div>`); }
        for (let d = 1; d <= lastDay.getDate(); d++) {
            const dayVisits       = visitsByDay[d]       || [];
            const dayProposals    = proposalsByDay[d]    || [];
            const dayFunil        = funilByDay[d]        || [];
            const dayAgendamentos = agendamentosByDay[d] || [];
            const hasAny = dayVisits.length || dayProposals.length || dayFunil.length || dayAgendamentos.length;
            const isToday = new Date(viewYear, viewMonth, d).toDateString() === todayStr;

            const allDots = [
                ...dayVisits.slice(0, 2).map((v) => `<span class="cal-dot" style="background:${typeColorMap[v.tipoVisita] || '#3b82f6'}" title="Visita: ${escapeHtml(v.cliente)}"></span>`),
                ...dayProposals.slice(0, 1).map(() => `<span class="cal-dot" style="background:${PROPOSAL_COLOR}" title="Proposta"></span>`),
                ...dayFunil.slice(0, 1).map(() => `<span class="cal-dot" style="background:${FUNIL_COLOR}" title="Funil"></span>`),
                ...dayAgendamentos.slice(0, 1).map((a) => `<span class="cal-dot-agendamento" style="color:${AGENDAMENTO_COLOR}" title="${a.campanhaOrigemId ? 'Prazo de campanha' : 'Retorno agendado'}: ${escapeHtml(a.cliente)}" aria-hidden="true">${a.campanhaOrigemId ? '🔗' : '📌'}</span>`)
            ];
            const totalExtra = dayVisits.length + dayProposals.length + dayFunil.length + dayAgendamentos.length - allDots.length;
            const more = totalExtra > 0 ? `<span class="cal-more">+${totalExtra}</span>` : '';

            cells.push(`
                <button type="button" class="cal-cell ${isToday ? 'cal-today' : ''} ${hasAny ? 'cal-has-visits' : ''}" data-day="${d}">
                    <span class="cal-day-num">${d}</span>
                    <div class="cal-dots">${allDots.join('')}${more}</div>
                </button>`);
        }

        // Legenda só com o que existe NESSE mês — types/typeColorMap
        // continuam globais (cor de cada tipo tem que ser sempre a mesma,
        // mês a mês), só a lista exibida é filtrada. Ordena pela ordem
        // global (não alfabética), pra não pular de posição mês a mês.
        const typesThisMonth = types.filter((t) =>
            Object.values(visitsByDay).some((dayVisits) => dayVisits.some((v) => v.tipoVisita === t)));

        const legendHtml = [
            ...(showVisitas ? typesThisMonth.map((t) => `<span class="cal-legend-item"><span class="cal-legend-dot" style="background:${typeColorMap[t]}"></span>${escapeHtml(t)}</span>`) : []),
            ...(showPropostas ? [`<span class="cal-legend-item"><span class="cal-legend-dot" style="background:${PROPOSAL_COLOR}"></span>Proposta</span>`] : []),
            ...(showFunil ? [`<span class="cal-legend-item"><span class="cal-legend-dot" style="background:${FUNIL_COLOR}"></span>Funil</span>`] : []),
            ...(showRetornos ? [`<span class="cal-legend-item"><span class="cal-legend-dot-agendamento" style="color:${AGENDAMENTO_COLOR}" aria-hidden="true">${activeFilter === 'campanha' ? '🔗' : '📌'}</span>${activeFilter === 'campanha' ? 'Prazo de campanha' : 'Retorno agendado'}</span>`] : [])
        ].join('');

        const filterOptions = [
            { key: 'todos', label: 'Todos' },
            { key: 'visitas', label: 'Visitas' },
            { key: 'propostas', label: 'Propostas' },
            { key: 'funil', label: 'Funil' },
            { key: 'retornos', label: 'Retornos' },
            { key: 'campanha', label: 'Campanha' }
        ];
        const filterChipsHtml = filterOptions.map((opt) =>
            `<button type="button" class="pill${activeFilter === opt.key ? ' active' : ''}" data-cal-filter="${opt.key}">${opt.label}</button>`
        ).join('');

        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Agenda</h2><p class="page-subtitle">Visitas, Propostas, Funil e Retornos</p></div>
                <button type="button" class="primary-btn" id="cal-new-agendamento">+ Agendar</button>
            </div>
            <div class="pill-row">${filterChipsHtml}</div>
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
                <div class="cal-legend-toggle-row">
                    <button type="button" class="text-link" id="cal-legend-toggle">${legendVisible ? 'Ocultar legenda' : 'Mostrar legenda'}</button>
                </div>
                ${legendVisible ? `<div class="cal-legend">${legendHtml}</div>` : ''}
            </div>
            <div id="cal-day-panel"></div>
            <div class="card" id="cal-agendamentos-section" style="margin-top:0.75rem"></div>
        `;

        renderAgendamentosSection();

        document.getElementById('cal-legend-toggle').addEventListener('click', () => {
            legendVisible = !legendVisible;
            render();
        });
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
        document.getElementById('cal-new-agendamento')?.addEventListener('click', () => {
            showCreateAgendamentoModal(() => renderCalendarPage());
        });
        mainContent.querySelectorAll('[data-cal-filter]').forEach((btn) => {
            btn.addEventListener('click', () => {
                activeFilter = btn.dataset.calFilter;
                render();
            });
        });

        mainContent.querySelectorAll('[data-day]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const day = Number(btn.dataset.day);
                const dayVisits       = visitsByDay[day]       || [];
                const dayProposals    = proposalsByDay[day]    || [];
                const dayFunil        = funilByDay[day]        || [];
                const dayAgendamentos = agendamentosByDay[day] || [];
                const panel = document.getElementById('cal-day-panel');
                if (!panel) { return; }
                if (!dayVisits.length && !dayProposals.length && !dayFunil.length && !dayAgendamentos.length) {
                    panel.innerHTML = `<p class="helper-text" style="text-align:center;padding:1rem">Sem registros neste dia.</p>`;
                    return;
                }
                const dateLabel = new Date(viewYear, viewMonth, day).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
                const total = dayVisits.length + dayProposals.length + dayFunil.length + dayAgendamentos.length;
                panel.innerHTML = `
                    <div class="visit-month-header" style="margin-top:1rem">
                        <h3>${escapeHtml(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1))}</h3>
                        <span>${total} registro(s)</span>
                    </div>
                    <div class="visits-list">
                        ${dayAgendamentos.map((a) => agendamentoCardHtml(a)).join('')}
                        ${dayVisits.map((v) => `
                        <button type="button" class="visit-card" data-visit-id="${escapeHtml(v.id)}" style="border-left:4px solid ${typeColorMap[v.tipoVisita] || '#3b82f6'}">
                            <div class="visit-card-header">
                                <strong><span aria-hidden="true">${visitTypeIcon(v.tipoVisita)}</span> ${escapeHtml(v.cliente || '-')}</strong>
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
                                <strong><span aria-hidden="true">${proposalStatusIcon(p.status)}</span> ${escapeHtml(p.cliente || '-')}</strong>
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
                                <strong><span aria-hidden="true">${funilStatusIcon(f.status)}</span> ${escapeHtml(f.cliente || '-')}</strong>
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
                bindAgendamentoRowActions(panel, dayAgendamentos, { onMutated: renderAgendamentosSection });
            });
        });

        const todayNum = new Date().getDate();
        if ((visitsByDay[todayNum] || agendamentosByDay[todayNum]) && viewYear === new Date().getFullYear() && viewMonth === new Date().getMonth()) {
            mainContent.querySelector(`[data-day="${todayNum}"]`)?.click();
        }
    };

    render();
}


export async function renderVisitFormPage(visit = null, radarClienteId = null, routeContext = null) {
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
    // Nova Visita "pura" (sem prefill): nenhuma opção de Prospecção vem
    // marcada — o resto do formulário só aparece depois que o usuário
    // escolher Sim/Não.
    const currentProspection = normalizedVisit ? normalizedVisit.prospeccao : '';
    const prospeccaoPendente = !normalizedVisit;
    const currentClient = normalizedVisit ? normalizedVisit.cliente : '';
    // Um prefill parcial (ex.: "Agendar prospecção" do Radar, ou Agendamento
    // concluído virando Visita) só traz Cliente/Cidade — normalizedVisit fica
    // "verdadeiro" mas sem Data/Horário. Sem esse fallback, os campos vinham
    // em branco em vez de cair no padrão "agora" que uma Nova Visita comum já tem.
    // routeContext (ver botão "Salvar e adicionar outra") só carrega
    // data/horário/veículo — os campos que tendem a repetir entre paradas
    // de um mesmo trajeto — nunca Cliente/Observação/etc, e não conta como
    // prefill pra prospeccaoPendente (continua perguntando por cliente).
    const currentDataVisita = (normalizedVisit && normalizedVisit.dataVisita) || (routeContext && routeContext.dataVisita) || formatDateForDisplay(now);
    const currentDataVisitaInput = (normalizedVisit && normalizedVisit.dataVisitaInput)
        || (normalizedVisit && normalizedVisit.dataVisita ? formatInputDateFromDisplay(normalizedVisit.dataVisita) : null)
        || (routeContext && routeContext.dataVisitaInput) || formatDateForInput(now);
    const currentHorario = (normalizedVisit && normalizedVisit.horario) || (routeContext && routeContext.horario) || formatTimeForInput(now);
    // Admin pode reatribuir/corrigir o Vendedor/Gerente de uma visita (ex.:
    // editar visita de outro vendedor sem sobrescrever o dono original).
    // Outros perfis continuam travados no próprio nome, como sempre foi.
    const isAdminUser = String(state.currentUser.profile || '').trim().toLowerCase() === 'admin';
    // Nova Visita: escolher até 3 tipos (cria 1 visita por tipo) só quando o
    // admin liga o toggle em Configurações. Desligado (padrão) = 1 tipo.
    const allowMultiTipo = !isEdit && formData.multiTipoVisita === true;
    const currentVendedorGerente = isAdminUser
        ? (normalizedVisit ? normalizedVisit.vendedorGerente : state.currentUser.name) || ''
        : (state.currentUser.name || '');

    // "Duplicar" (e prefills do Radar/Agendamento concluído) chegam como um
    // objeto sem ID: não é edição, mas também não pode restaurar rascunho
    // por cima do que o usuário pediu pra repetir.
    const hasPrefill = !isEdit && Boolean(visit);
    const visitDraftKey = 'apv_draft_visit_' + (state.currentUser && state.currentUser.email || '');
    const VISIT_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const visitDraft = (!isEdit && !hasPrefill) ? (() => {
        try {
            const raw = JSON.parse(localStorage.getItem(visitDraftKey) || 'null');
            if (raw && raw.savedAt && (Date.now() - raw.savedAt) < VISIT_DRAFT_MAX_AGE_MS && raw.fields) {
                const f = raw.fields;
                if (f.cliente || f.observacao || f.contato || (Array.isArray(f.tiposVisita) && f.tiposVisita.length)) {
                    return raw;
                }
            }
        } catch (e) {}
        return null;
    })() : null;

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-to-visits">Voltar</button>
            <h2>${isEdit ? 'Editar Visita' : 'Nova Visita'}</h2>
        </div>
        <form id="visit-form" class="card form-card form-layout visit-form-layout${prospeccaoPendente ? ' prospeccao-pendente' : ''}">
            <input type="hidden" id="visit-id" value="${escapeHtml(normalizedVisit ? normalizedVisit.id : '')}">
            <div class="form-group full-width" id="prospeccao-field">
                <label>Prospecção</label>
                <p class="field-helper-text">Marque "Sim" apenas para cliente ainda sem cadastro no sistema.</p>
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

            <div class="form-group ${isAdminUser ? '' : 'readonly-group'}">
                <label for="vendedor-gerente">Vendedor / Gerente${isAdminUser ? ' (Admin pode registrar por outro)' : ''}</label>
                ${isAdminUser ? `
                <div class="searchable-select">
                    <input type="text" id="vendedor-gerente" value="${escapeHtml(currentVendedorGerente)}" placeholder="Escolha o vendedor ou gerente" autocomplete="off">
                    <div class="searchable-select-menu" id="vendedor-gerente-menu"></div>
                </div>` : `
                <input type="text" id="vendedor-gerente" value="${escapeHtml(currentVendedorGerente)}" readonly>`}
            </div>
            <div class="form-row-pair full-width">
                <div class="form-group">
                    <label for="data-visita">Data da Visita</label>
                    <div class="date-input-group">
                        <input type="text" id="data-visita" value="${escapeHtml(currentDataVisita)}" placeholder="dd/mm/aaaa" inputmode="numeric" maxlength="10" required>
                        <button type="button" class="date-picker-button" id="open-date-picker" aria-label="Abrir calendario">📅</button>
                        <div class="picker-menu" id="data-visita-menu">
                            <input type="date" id="data-visita-picker" class="picker-native-input" value="${escapeHtml(currentDataVisitaInput)}">
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="horario">Horário</label>
                    <div class="date-input-group">
                        <input type="text" id="horario" value="${escapeHtml(currentHorario)}" placeholder="hh:mm" inputmode="numeric" maxlength="5" required>
                        <button type="button" class="date-picker-button" id="open-time-picker" aria-label="Abrir horario">🕒</button>
                        <div class="picker-menu" id="horario-menu">
                            <input type="time" id="horario-picker" class="picker-native-input" value="${escapeHtml(currentHorario)}">
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
                <label for="tipo-visita">Tipo da Visita${allowMultiTipo ? ' (até 3)' : ''}</label>
                <div class="searchable-select${allowMultiTipo ? ' multi-select' : ''}">
                    <input type="text" id="tipo-visita" value="${escapeHtml(isEdit && normalizedVisit ? normalizedVisit.tipoVisita : '')}" placeholder="${allowMultiTipo ? 'Pesquise e selecione até 3 tipos' : 'Pesquise o tipo da visita'}" ${allowMultiTipo ? '' : 'required'} autocomplete="off">
                    <div class="searchable-select-menu" id="tipo-visita-menu"></div>
                </div>
                ${allowMultiTipo ? '<div class="selected-types" id="selected-visit-types"></div>' : ''}
                ${allowMultiTipo ? '<p class="field-helper-text">Cada tipo selecionado cria uma visita separada com os mesmos dados.</p>' : ''}
            </div>
            <div class="form-group full-width">
                <label>Qual o Veículo?</label>
                <div class="radio-group" id="veiculo-group">
                    ${renderVehicleOptions((normalizedVisit && normalizedVisit.veiculo) || (routeContext && routeContext.veiculo) || 'Particular')}
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
            ${!isEdit ? `
            <div class="form-group full-width">
                <label for="visit-notificar-usuario">Notificar um usuário sobre esta visita <span class="field-helper-text" style="display:inline">(opcional)</span></label>
                <div class="searchable-select">
                    <input type="text" id="visit-notificar-usuario" placeholder="Busque o vendedor/gerente" autocomplete="off">
                    <div class="searchable-select-menu" id="visit-notificar-usuario-menu"></div>
                </div>
            </div>` : ''}
            ${state.canLancarDespesas ? `
            <div class="form-group full-width">
                <label>Teve Despesas?</label>
                <div class="radio-group" id="despesas-group">
                    <label class="radio-pill">
                        <input type="radio" name="teveDespesas" value="Sim" ${normalizedVisit && normalizedVisit.teveDespesas === 'Sim' ? 'checked' : ''}>
                        <span>Sim</span>
                    </label>
                    <label class="radio-pill">
                        <input type="radio" name="teveDespesas" value="Nao" ${!normalizedVisit || normalizedVisit.teveDespesas !== 'Sim' ? 'checked' : ''}>
                        <span>Não</span>
                    </label>
                </div>
                <p class="field-helper-text">Se forem várias visitas no mesmo dia, lance a despesa em apenas uma delas.</p>
                <div class="form-group" id="valor-despesas-group" style="margin-top:0.5rem;${normalizedVisit && normalizedVisit.teveDespesas === 'Sim' ? '' : 'display:none'}">
                    <label for="valor-despesas">Valor R$</label>
                    <input type="text" id="valor-despesas" value="${escapeHtml(normalizedVisit ? normalizedVisit.valorDespesas : '')}" placeholder="0,00" inputmode="decimal">
                </div>
            </div>` : ''}
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-visit">Cancelar</button>
                ${isEdit
                    ? `<button type="submit" id="save-visit">Salvar Alterações</button>`
                    : `<button type="submit" id="save-visit-again" class="secondary-button">Salvar e adicionar outra</button>
                       <button type="submit" id="save-visit">Salvar e sair</button>`}
            </div>
        </form>
    `;

    // Em modo edição, "Voltar"/"Cancelar" retornam pro detalhe no lugar (sem
    // navegar) — igual ao "Editar" fez pra chegar aqui. Em modo criação não
    // existe detalhe pra voltar, então navega normalmente pra lista.
    const exitVisitEdit = () => {
        if (state.formDirty && !confirm('Você tem alterações não salvas. Deseja sair mesmo assim?')) return;
        state.formDirty = false;
        state.inPlaceEditActive = false;
        clearDocumentClickListeners();
        renderVisitDetailPage(normalizedVisit.id);
    };
    document.getElementById('back-to-visits').addEventListener('click', () => { if (isEdit) exitVisitEdit(); else navigateTo('visits'); });
    document.getElementById('cancel-visit').addEventListener('click', () => { if (isEdit) exitVisitEdit(); else navigateTo('visits'); });

    // Sem fallback pra 'Sim': enquanto Prospecção não foi respondida, isso
    // fazia o syncProspectionMode() inicial (chamado incondicionalmente,
    // logo abaixo) tratar como "Sim" e mostrar "Potencial do Cliente" via
    // style inline — que vence a regra CSS que esconde o resto do form
    // (.prospeccao-pendente) por ser mais específica.
    const prospeccaoSelect = { get value() { return document.querySelector('input[name="prospeccao"]:checked')?.value || ''; } };
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
    // Edição usa o tipo único já gravado (o multi-select fica desligado).
    // Na criação, pré-seleciona os tipos vindos de um "Duplicar" ou de um
    // rascunho restaurado — descartando o que não exista mais na lista.
    // Fica seedado ANTES do initializeSearchableInput abaixo, que já
    // renderiza os chips a partir deste array na inicialização.
    let selectedVisitTypes = [];
    if (isEdit && normalizedVisit && normalizedVisit.tipoVisita) {
        selectedVisitTypes = [normalizedVisit.tipoVisita];
    } else {
        const availableTipos = new Set((formData.tiposVisita || []).map((item) => item.tipo));
        const rawTipos = (normalizedVisit && normalizedVisit.tipoVisita)
            ? String(normalizedVisit.tipoVisita).split(',').map((t) => t.trim())
            : (visitDraft && Array.isArray(visitDraft.fields.tiposVisita) ? visitDraft.fields.tiposVisita : []);
        selectedVisitTypes = rawTipos.filter((t) => t && availableTipos.has(t)).slice(0, allowMultiTipo ? 3 : 1);
    }

    initializeSearchableInput({
        input: clienteSelect,
        menu: document.getElementById('cliente-existente-menu'),
        items: formData.clientes.map((client) => clienteSearchItem(client)),
        onSelect: (value) => fillClientData(value)
    });
    initializeSearchableInput({
        input: cidadeSelect,
        menu: document.getElementById('cidade-menu'),
        items: formData.cidades, allowFreeText: true
    });
    initializeSearchableInput({
        input: areaSelect,
        menu: document.getElementById('area-atuacao-menu'),
        items: formData.areasAtuacao, allowFreeText: true
    });
    initializeSearchableInput({
        input: potencialSelect,
        menu: document.getElementById('potencial-cliente-menu'),
        items: formData.potenciaisCliente, allowFreeText: true
    });
    if (isAdminUser && document.getElementById('vendedor-gerente-menu')) {
        initializeSearchableInput({
            input: document.getElementById('vendedor-gerente'),
            menu: document.getElementById('vendedor-gerente-menu'),
            items: (formData.vendedores || []).map((v) => v.nome).filter(Boolean)
        });
    }
    if (document.getElementById('visit-notificar-usuario-menu')) {
        // Lista restrita (não é "notifique qualquer um da empresa"): só o(s)
        // gerente(s) da própria gerência de quem tá registrando + os admins
        // — as pessoas que realmente fazem sentido avisar sobre uma visita.
        // Pro Admin (que não tem uma "própria gerência" fixa pra comparar),
        // a restrição de gerência não faz sentido — vê todos os gerentes.
        const meuGerencia = String(state.currentUser?.gerencia || '').trim().toLowerCase();
        const notificarOptions = (formData.vendedores || []).filter((v) => {
            if (!v.nome || v.nome === state.currentUser?.name) return false;
            const perfil = String(v.perfil || '').trim().toLowerCase();
            if (perfil === 'admin') return true;
            if (perfil !== 'gerente') return false;
            return isAdminUser || String(v.gerencia || '').trim().toLowerCase() === meuGerencia;
        }).map((v) => v.nome);
        initializeSearchableInput({
            input: document.getElementById('visit-notificar-usuario'),
            menu: document.getElementById('visit-notificar-usuario-menu'),
            items: notificarOptions
        });
    }
    initializeSearchableInput({
        input: tipoVisitaInput,
        menu: document.getElementById('tipo-visita-menu'),
        items: formData.tiposVisita.map((item) => item.tipo),
        multiSelect: allowMultiTipo,
        maxSelections: 3,
        selectedItems: selectedVisitTypes,
        selectedContainer: selectedTypesContainer,
        selectionLabel: 'tipo',
        onSelectionChange: (items) => {
            tipoVisitaInput.value = allowMultiTipo ? '' : (items[0] || '');
        }
    });
    // Modo 1 tipo (edição, ou criação com o toggle desligado): restaura o
    // valor vindo de "Duplicar"/rascunho no próprio input.
    if (!allowMultiTipo && !isEdit && selectedVisitTypes[0] && !tipoVisitaInput.value) {
        tipoVisitaInput.value = selectedVisitTypes[0];
    }

    const syncProspectionMode = () => {
        // Prospecção ainda não respondida: nem entra aqui pra mexer em
        // estilo inline nenhum — quem manda nesse estado é só a classe CSS
        // .prospeccao-pendente (esconde tudo menos a própria pergunta). Um
        // inline style setado aqui venceria essa regra e vazaria algum
        // campo antes da hora (era o caso de "Potencial do Cliente").
        if (!document.querySelector('input[name="prospeccao"]:checked')) return;
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
        const client = findClienteByNome(state.formData.clientes, clientName);
        if (!client) {
            contatoInput.disabled = false;
            return;
        }
        // O que fica gravado na visita é o Nome Fantasia (nome oficial só
        // quando o cliente não tem fantasia cadastrado) — regra do negócio.
        const nomeGravar = clienteNomeParaGravar(client);
        clienteSelect.value = nomeGravar;
        clienteInput.value = nomeGravar;
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
        // Admin escolhendo um cliente já cadastrado: sugere o vendedor
        // responsável por ele (coluna "Vendedores" do cadastro), sem travar
        // — o admin ainda pode trocar depois.
        if (isAdminUser && client.vendedores) {
            const vendedorInput = document.getElementById('vendedor-gerente');
            if (vendedorInput) {
                const primeiroNome = String(client.vendedores).split(/[,;/]/)[0].trim();
                if (primeiroNome) {
                    const match = (formData.vendedores || [])
                        .find((v) => String(v.nome || '').trim().toLowerCase() === primeiroNome.toLowerCase());
                    vendedorInput.value = match ? match.nome : primeiroNome;
                }
            }
        }
    };

    // Track dirty state so navigateTo can warn before abandoning
    document.getElementById('visit-form').addEventListener('input', () => { state.formDirty = true; });
    document.getElementById('visit-form').addEventListener('change', () => { state.formDirty = true; });

    initObservacaoField();

    document.querySelectorAll('input[name="prospeccao"]').forEach((radio) => radio.addEventListener('change', () => {
        // Escolheu Sim/Não → revela o resto do formulário.
        document.getElementById('visit-form').classList.remove('prospeccao-pendente');
        syncProspectionMode();
    }));
    document.querySelectorAll('input[name="teveDespesas"]').forEach((radio) => radio.addEventListener('change', (e) => {
        const valorGroup = document.getElementById('valor-despesas-group');
        if (valorGroup) valorGroup.style.display = e.target.value === 'Sim' ? '' : 'none';
    }));
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
        const clearVisitDraft = () => { try { localStorage.removeItem(visitDraftKey); } catch (e) {} };

        // Restaura o formulário INTEIRO (não só cliente/observação como antes)
        // quando há um rascunho recente e o usuário não pediu um prefill
        // específico — assim um reload do PWA ou uma saída sem querer no meio
        // do preenchimento não perde nada. Os tipos já foram restaurados no
        // seed de selectedVisitTypes lá em cima.
        if (visitDraft && !hasPrefill) {
            const f = visitDraft.fields;
            // Prospecção + cliente cadastrado primeiro, pra o syncProspectionMode/
            // fillClientData rodar sobre a base certa; os campos específicos do
            // rascunho são reaplicados depois, preservando ajustes manuais.
            if (f.prospeccao) {
                const r = document.querySelector('input[name="prospeccao"][value="' + f.prospeccao + '"]');
                if (r) { r.checked = true; document.getElementById('visit-form').classList.remove('prospeccao-pendente'); }
            }
            if (f.clienteExistente) { clienteSelect.value = f.clienteExistente; }
            syncProspectionMode();

            if (f.cliente) { clienteInput.value = f.cliente; }
            if (f.contato) { contatoInput.value = f.contato; }
            if (f.dataVisita) {
                dataVisitaInput.value = f.dataVisita;
                const iso = formatInputDateFromDisplay(f.dataVisita);
                if (iso) { dataVisitaPicker.value = iso; }
            }
            if (f.horario) { horarioInput.value = f.horario; horarioPicker.value = f.horario; }
            if (f.cidade) { cidadeSelect.value = f.cidade; }
            if (f.areaAtuacao) { areaSelect.value = f.areaAtuacao; }
            if (f.potencialCliente) { potencialSelect.value = f.potencialCliente; }
            if (f.veiculo) {
                const vr = document.querySelector('input[name="veiculo"][value="' + f.veiculo + '"]');
                if (vr) { vr.checked = true; }
            }
            if (f.observacao) {
                const obsEl = document.getElementById('observacao');
                if (obsEl) { obsEl.value = f.observacao; obsEl.dispatchEvent(new Event('input', { bubbles: true })); }
            }

            const when = (() => {
                try { return new Date(visitDraft.savedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
                catch (e) { return ''; }
            })();
            const banner = document.createElement('div');
            banner.id = 'visit-draft-banner';
            banner.style.cssText = 'display:flex;align-items:center;gap:0.6rem;background:var(--primary-light);border:1px solid var(--border-focus);border-radius:8px;padding:0.55rem 0.75rem;margin-bottom:0.75rem;font-size:0.82rem;color:var(--primary-dark)';
            banner.innerHTML = '<span style="flex:1">📝 Rascunho' + (when ? ' de ' + when : '') + ' restaurado.</span><button type="button" class="mini-button" id="visit-draft-discard">Descartar</button>';
            const formEl = document.getElementById('visit-form');
            formEl.insertBefore(banner, formEl.firstChild);
            document.getElementById('visit-draft-discard').addEventListener('click', () => {
                clearVisitDraft();
                state.formDirty = false;
                navigateTo('visit-new');
            });
        }

        const saveDraft = debounce(function () {
            try {
                localStorage.setItem(visitDraftKey, JSON.stringify({
                    savedAt: Date.now(),
                    fields: {
                        prospeccao: prospeccaoSelect.value,
                        clienteExistente: clienteSelect.value,
                        cliente: clienteInput.value,
                        contato: contatoInput.value,
                        dataVisita: dataVisitaInput.value,
                        horario: horarioInput.value,
                        cidade: cidadeSelect.value,
                        areaAtuacao: areaSelect.value,
                        potencialCliente: potencialSelect.value,
                        veiculo: document.querySelector('input[name="veiculo"]:checked')?.value || '',
                        tiposVisita: selectedVisitTypes.slice(),
                        observacao: document.getElementById('observacao')?.value || ''
                    }
                }));
            } catch (e) {}
        }, 800);
        const formEl = document.getElementById('visit-form');
        formEl.addEventListener('input', saveDraft);
        formEl.addEventListener('change', saveDraft);
        formEl._draftKey = visitDraftKey;
    }

    preventEnterSubmit(document.getElementById('visit-form'));
    document.getElementById('visit-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!document.querySelector('input[name="prospeccao"]:checked')) {
            showToast('Escolha se é prospecção: Sim ou Não.', true);
            document.getElementById('prospeccao-field')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }
        // Nova Visita tem 2 botões de submit ("Salvar e sair" / "Salvar e
        // adicionar outra") — event.submitter diz qual foi clicado.
        const wantsAddAnother = !isEdit && event.submitter && event.submitter.id === 'save-visit-again';
        const saveButton = event.submitter || document.getElementById('save-visit');
        const otherSubmitButton = document.getElementById(wantsAddAnother ? 'save-visit' : 'save-visit-again');
        if (otherSubmitButton) otherSubmitButton.disabled = true;
        const resetSaveButtons = () => {
            setSaving(false, saveButton);
            if (otherSubmitButton) otherSubmitButton.disabled = false;
        };
        setSaving(true, saveButton, isEdit ? 'Salvando...' : 'Criando...');

        const normalizedVisitDate = normalizeDisplayDateValue(dataVisitaInput.value);
        if (!normalizedVisitDate) {
            showToast('Informe a data no formato dd/mm/aaaa.', true);
            resetSaveButtons();
            dataVisitaInput.focus();
            return;
        }

        const normalizedHorario = normalizeTimeValue(horarioInput.value);
        if (!normalizedHorario) {
            showToast('Informe o horário no formato hh:mm.', true);
            resetSaveButtons();
            horarioInput.focus();
            return;
        }

        const payload = {
            id: document.getElementById('visit-id').value,
            prospeccao: prospeccaoSelect.value,
            vendedorGerente: isAdminUser ? (document.getElementById('vendedor-gerente').value.trim() || state.currentUser.name) : state.currentUser.name,
            gerencia: state.currentUser.gerencia,
            dataVisita: normalizedVisitDate,
            horario: normalizedHorario,
            cliente: clienteInput.value.trim(),
            contato: contatoInput.value.trim(),
            cidade: cidadeSelect.value,
            areaAtuacao: areaSelect.value,
            potencialCliente: prospeccaoSelect.value === 'Sim' ? potencialSelect.value : '',
            tipoVisita: allowMultiTipo ? '' : tipoVisitaInput.value,
            tiposVisita: allowMultiTipo ? selectedVisitTypes.slice() : [tipoVisitaInput.value].filter(Boolean),
            veiculo: document.querySelector('input[name="veiculo"]:checked')?.value || 'Particular',
            observacao: document.getElementById('observacao').value.trim(),
            clienteId: (() => {
                const selectedClient = state.formData.clientes.find((item) => String(item.nome || '').trim().toLowerCase() === String(clienteSelect.value || '').trim().toLowerCase());
                return selectedClient ? selectedClient.id : '';
            })(),
            // Sem geolocalização: cria vazio; numa edição, omite (undefined some
            // no JSON) pra não apagar lat/lng que já exista no registro.
            latitude: isEdit ? undefined : '',
            longitude: isEdit ? undefined : '',
            teveDespesas: state.canLancarDespesas ? (document.querySelector('input[name="teveDespesas"]:checked')?.value || 'Nao') : undefined,
            valorDespesas: state.canLancarDespesas ? document.getElementById('valor-despesas')?.value.trim() : undefined,
            notificarUsuario: isEdit ? undefined : (document.getElementById('visit-notificar-usuario')?.value.trim() || ''),
            user: state.currentUser
        };

        if (payload.teveDespesas === 'Sim' && !payload.valorDespesas) {
            showToast('Informe o valor das despesas.', true);
            resetSaveButtons();
            document.getElementById('valor-despesas')?.focus();
            return;
        }

        if (!isEdit && payload.tiposVisita.length === 0) {
            showToast('Selecione pelo menos um tipo de visita.', true);
            resetSaveButtons();
            tipoVisitaInput.focus();
            return;
        }

        if (isEdit && !payload.tipoVisita) {
            showToast('Selecione um tipo de visita.', true);
            resetSaveButtons();
            tipoVisitaInput.focus();
            return;
        }

        if (isEdit) {
            const idx = state.visits.findIndex(v => String(v.ID || v.id) === String(payload.id));
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
                'Observação': payload.observacao,
                'TeveDespesas': payload.teveDespesas ?? (idx >= 0 ? state.visits[idx].teveDespesas : ''),
                'ValorDespesas': payload.valorDespesas ?? (idx >= 0 ? state.visits[idx].valorDespesas : '')
            });
            if (idx >= 0) { state.visits[idx] = updatedVisit; saveCache('visits', state.visits); }
            state.currentVisit = updatedVisit;

            const waConfigEdit = getWhatsappConfigForVisit(payload.tipoVisita);
            if (waConfigEdit && waConfigEdit.obrigatorio) {
                await showMandatoryWhatsappModal(waConfigEdit, updatedVisit);
            }

            state.formDirty = false;
            state.inPlaceEditActive = false;
            showToast('Visita atualizada com sucesso.');
            clearDocumentClickListeners();
            renderVisitDetailPage(payload.id);

            attemptOrQueue('updateVisit', payload, { entity: 'visits', tempId: payload.id })
                .then(res => {
                    if (res && res.status === 'success') {
                        const real = normalizeVisit(res.visit || payload);
                        state.visits = state.visits.map(v => String(v.ID || v.id) === String(payload.id) ? real : v);
                        saveCache('visits', state.visits);
                    } else if (res && res.status === 'queued') {
                        const pendingVisit = { ...updatedVisit, _pending: true };
                        state.visits = state.visits.map(v => String(v.ID || v.id) === String(payload.id) ? pendingVisit : v);
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

            resetSaveButtons();
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
                        resetSaveButtons();
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
            if (radarClienteId) {
                // Best-effort, sem garantia transacional com a criação da Visita
                // acima (mesmo padrão já aceito hoje pro fluxo de Agendamento
                // concluído) — se uma falhar e a outra não, corrige na aba
                // Histórico do Radar depois.
                attemptOrQueue('updateRadarClienteStatus', {
                    user: state.currentUser, id: radarClienteId, status: 'prospeccao_agendada',
                    visitaOrigemId: state.currentVisit.id
                }, { entity: 'radar', tempId: 'radar_' + radarClienteId });
            }
            const tipoAtual = (payload.tiposVisita || [])[0];
            const waConfig = getWhatsappConfigForVisit(tipoAtual);
            if (waConfig && waConfig.obrigatorio) {
                await showMandatoryWhatsappModal(waConfig, state.currentVisit);
            }
            if (result.status === 'success') {
                await showScheduleReturnModal(state.currentVisit);
            }
            state.formDirty = false;
            const _dk = document.getElementById('visit-form')?._draftKey;
            if (_dk) { try { localStorage.removeItem(_dk); } catch(e) {} }
            if (result.status === 'queued') {
                showToast('Sem conexão — a visita foi salva no aparelho e será enviada quando a conexão voltar.');
            } else if (wantsAddAnother) {
                showToast('Visita criada. Pronto para a próxima.');
            } else {
                const _visitMsg = createdVisits.length > 1 ? `${createdVisits.length} visitas criadas` : 'Visita criada com sucesso';
                showToast(_visitMsg, false, () => navigateTo('visit-new'));
                // Renomear botão "Desfazer" para "Nova Visita"
                const _toastBtn = document.getElementById('app-toast')?.querySelector('.toast-undo-btn');
                if (_toastBtn) _toastBtn.textContent = '+ Nova Visita';
            }
            // Oferece jogar esse cliente no Funil de Vendas na sequência —
            // só faz sentido pra prospecção (cliente novo, ainda sem
            // cadastro); cliente já cadastrado normalmente já está no Funil
            // ou não é o caso de abrir oportunidade agora.
            if (payload.cliente && payload.prospeccao === 'Sim' && state.canCreateProposalFunil &&
                await showAddToFunilModal(payload.cliente)) {
                state.funilPrefill = {
                    cliente: payload.cliente,
                    cidade: payload.cidade || '',
                    foco: payload.potencialCliente || '',
                    atuacao: payload.areaAtuacao || ''
                };
                resetSaveButtons();
                await navigateTo('funil-new');
                return;
            }
            if (wantsAddAnother && result.status !== 'queued') {
                // Só os campos que tendem a repetir num mesmo trajeto (data,
                // horário, veículo) — Cliente/Observação/etc. sempre em
                // branco pra próxima parada.
                await navigateTo('visit-new', {
                    routeContext: { dataVisita: payload.dataVisita, horario: payload.horario, veiculo: payload.veiculo }
                });
            } else {
                await navigateTo('visits');
            }
        } else {
            showToast((result && result.message) || 'Não foi possível salvar a visita.', true);
        }

        resetSaveButtons();
    });
}


export async function renderVisitDetailPage(id) {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    // A lista deixa um botão de "voltar ao topo" pra trás (só o próprio
    // addScrollTop remove o anterior, e essa página não chama de novo).
    document.getElementById('page-scroll-top')?.remove();
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

    // Anterior/Próxima seguem a ordem da última lista renderizada
    // (state.visitsNavOrder) — só aparece quando esta visita faz parte dela
    // (senão não haveria "vizinhos" coerentes pra mostrar).
    const navOrder = state.visitsNavOrder || [];
    const navIdx = navOrder.findIndex((navId) => String(navId) === String(visit.id));
    const navPrevId = navIdx > 0 ? navOrder[navIdx - 1] : null;
    const navNextId = navIdx >= 0 && navIdx < navOrder.length - 1 ? navOrder[navIdx + 1] : null;
    const showNav = navIdx >= 0 && navOrder.length > 1;

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Visitas', page: 'visits' }, { label: visit.cliente || 'Visita' }])}
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-visits">Voltar</button>
            ${showNav ? `
            <div class="detail-nav-group">
                <button type="button" class="mini-button mini-button-icon" id="visit-nav-prev" title="Visita anterior" aria-label="Visita anterior" ${!navPrevId ? 'disabled' : ''}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15,18 9,12 15,6"/></svg>
                </button>
                <span class="detail-nav-count">${navIdx + 1}/${navOrder.length}</span>
                <button type="button" class="mini-button mini-button-icon" id="visit-nav-next" title="Próxima visita" aria-label="Próxima visita" ${!navNextId ? 'disabled' : ''}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9,18 15,12 9,6"/></svg>
                </button>
            </div>` : ''}
            <h2>Detalhes da Visita</h2>
            <div class="header-actions-group">
                ${visit.cliente ? `<button type="button" class="mini-button mini-button-icon" id="visit-c360" aria-label="Cliente 360°" title="Ver histórico completo do cliente">${actionIcon('user')}</button>` : ''}
                <button type="button" class="mini-button" id="edit-visit">Editar</button>
                <button type="button" class="mini-button" id="duplicate-visit" title="Nova visita com os mesmos dados">Duplicar</button>
                <button type="button" class="mini-button mini-button-icon mini-button-whatsapp" id="share-whatsapp" aria-label="Compartilhar no WhatsApp" title="Compartilhar no WhatsApp">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                </button>
                ${state.canDelete ? `<button type="button" class="mini-button mini-button-icon mini-button-danger" id="delete-visit" aria-label="Apagar" title="Apagar">${actionIcon('trash')}</button>` : ''}
            </div>
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
            ${visit.teveDespesas === 'Sim' ? renderDetailRow('Despesas', formatCurrency(visit.valorDespesas) || '-') : ''}
            ${visit.latitude && visit.longitude ? `
            <div class="detail-row">
                <span class="detail-label"><span class="detail-label-icon" aria-hidden="true">${actionIcon('pin', 13)}</span>Check-in</span>
                <button type="button" class="mini-button" id="visit-map-link">Ver no mapa</button>
            </div>` : ''}
        </div>
    `;

    document.getElementById('back-visits').addEventListener('click', () => navigateTo('visits'));
    document.getElementById('visit-nav-prev')?.addEventListener('click', () => { if (navPrevId) navigateTo('visit-detail', { id: navPrevId }); });
    document.getElementById('visit-nav-next')?.addEventListener('click', () => { if (navNextId) navigateTo('visit-detail', { id: navNextId }); });
    document.getElementById('edit-visit').addEventListener('click', () => {
        // Edita no lugar, sem navegar pra outra "tela" — sem isso o usuário
        // sente que saiu do detalhe da visita pra um formulário separado.
        clearDocumentClickListeners();
        state.currentVisit = visit;
        state.inPlaceEditActive = true;
        renderVisitFormPage(visit);
    });

    // "Duplicar": abre uma Nova Visita já preenchida com os dados deste
    // cliente. Data/Horário caem no padrão "agora" e a Observação nasce em
    // branco — o objeto vai sem ID, então não é edição.
    document.getElementById('duplicate-visit')?.addEventListener('click', () => {
        navigateTo('visit-new', { prefill: {
            prospeccao: visit.prospeccao,
            cliente: visit.cliente,
            contato: visit.contato,
            cidade: visit.cidade,
            areaAtuacao: visit.areaAtuacao,
            potencialCliente: visit.potencialCliente,
            tipoVisita: visit.tipoVisita,
            veiculo: visit.veiculo
        } });
    });

    document.getElementById('delete-visit')?.addEventListener('click', async (event) => {
        if (!confirm(`Apagar a visita de "${visit.cliente || 'cliente'}"? Essa ação não pode ser desfeita.`)) return;
        const btn = event.currentTarget;
        setSaving(true, btn, 'Apagando...');
        const result = await callAPI('deleteVisit', { id: visit.id, user: state.currentUser });
        if (result && result.status === 'success') {
            // state.visits guarda itens crus do servidor (chave ID) misturados
            // com criados localmente (chave id) — precisa checar as duas, senão
            // a visita apagada continua na lista até o refresh de fundo.
            state.visits = state.visits.filter((v) => String(v.ID || v.id) !== String(visit.id));
            saveCache('visits', state.visits);
            showToast('Visita apagada.');
            navigateTo('visits');
        } else {
            showToast((result && result.message) || 'Não foi possível apagar a visita.', true);
            setSaving(false, btn);
        }
    });

    document.getElementById('share-whatsapp').addEventListener('click', () => {
        const message = buildWhatsappMessage(whatsappInfo?.mensagemPadrao, visit);
        openExternal(`https://wa.me/?text=${encodeURIComponent(message)}`);
    });

    document.getElementById('visit-map-link')?.addEventListener('click', () => {
        openExternal(`https://www.google.com/maps?q=${visit.latitude},${visit.longitude}`);
    });

    document.getElementById('visit-c360')?.addEventListener('click', () => navigateTo('cliente-360', { cliente: visit.cliente }));
}


export async function getVisits(diasParam) {
    const dias = diasParam === 0 ? 0 : (diasParam || state.loadDias || 90);
    const cacheKey = dias === 0 ? 'visits_all' : 'visits';
    // Cache vazio ([]) conta como "sem cache" — senão um refresh incremental
    // (que só busca poucos dias) nunca reconstrói a lista completa, e a tela
    // fica presa vazia até um "Atualizar" manual limpar o cache de verdade.
    const cachedRaw = loadCache(cacheKey);
    const cached = (Array.isArray(cachedRaw) && cachedRaw.length > 0) ? cachedRaw : null;
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
                'Observação': payload.observacao,
                'TeveDespesas': payload.teveDespesas || '',
                'ValorDespesas': payload.valorDespesas || ''
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
        const isAdminUser = String(state.currentUser?.profile || '').trim().toLowerCase() === 'admin';

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card">
                <div style="font-size:2rem;margin-bottom:0.75rem">📱</div>
                <h3>Compartilhamento Obrigatório</h3>
                <p>O tipo de visita selecionado exige compartilhamento via WhatsApp antes de continuar.</p>
                <p class="helper-text" style="margin-top:-0.5rem">Direcione esta mensagem ao grupo correto (manutenção, comercial, etc.) antes de enviar.</p>
                <button type="button" id="modal-wa-share" class="primary-button">Abrir WhatsApp</button>
                ${isAdminUser ? `<button type="button" id="modal-wa-copy" class="secondary-button">Copiar texto</button>` : ''}
                <button type="button" id="modal-wa-done" class="secondary-button">Já compartilhei — Continuar</button>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#modal-wa-share').addEventListener('click', () => {
            openExternal(url);
        });
        overlay.querySelector('#modal-wa-copy')?.addEventListener('click', () => {
            navigator.clipboard?.writeText(msg).then(() => showToast('Texto copiado.'));
        });
        overlay.querySelector('#modal-wa-done').addEventListener('click', () => {
            overlay.remove();
            resolve();
        });
    });
}


export function showScheduleReturnModal(visit) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card">
                <div style="font-size:2rem;margin-bottom:0.75rem">📅</div>
                <h3>Agendar retorno?</h3>
                <p>Deseja programar uma próxima visita para <strong>${escapeHtml(visit.cliente || 'este cliente')}</strong>?</p>
                <button type="button" id="modal-sched-yes" class="primary-button">Sim, agendar</button>
                <button type="button" id="modal-sched-no" class="secondary-button">Não, obrigado</button>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => { overlay.remove(); resolve(); };
        overlay.querySelector('#modal-sched-no').addEventListener('click', close);
        overlay.querySelector('#modal-sched-yes').addEventListener('click', () => {
            const defaultDate = new Date();
            defaultDate.setDate(defaultDate.getDate() + 30);
            const card = overlay.querySelector('.modal-card');
            card.innerHTML = `
                <div style="font-size:2rem;margin-bottom:0.75rem">📅</div>
                <h3>Agendar retorno</h3>
                <div class="form-group full-width" style="text-align:left">
                    <label for="sched-data">Data do retorno</label>
                    <input type="date" id="sched-data" value="${defaultDate.toISOString().slice(0, 10)}">
                </div>
                <div class="form-group full-width" style="text-align:left">
                    <label for="sched-obs">Observação (opcional)</label>
                    <textarea id="sched-obs" rows="2" placeholder="Ex: levar amostra, confirmar pedido..."></textarea>
                </div>
                <button type="button" id="modal-sched-save" class="primary-button">Salvar agendamento</button>
                <button type="button" id="modal-sched-cancel" class="secondary-button">Cancelar</button>
            `;
            card.querySelector('#modal-sched-cancel').addEventListener('click', close);
            card.querySelector('#modal-sched-save').addEventListener('click', async () => {
                const btn = card.querySelector('#modal-sched-save');
                const dataVal = card.querySelector('#sched-data').value;
                if (!dataVal) { showToast('Informe a data do retorno.', true); return; }
                const obsVal = card.querySelector('#sched-obs').value.trim();
                setSaving(true, btn, 'Salvando...');
                const result = await callAPI('createAgendamento', {
                    cliente: visit.cliente, cidade: visit.cidade, dataAgendada: dataVal,
                    observacao: obsVal, visitaOrigemId: visit.id, user: state.currentUser
                });
                if (result && result.status === 'success') {
                    showToast('Retorno agendado com sucesso.');
                    card.innerHTML = `
                        <div style="font-size:2rem;margin-bottom:0.75rem">✅</div>
                        <h3>Retorno agendado</h3>
                        <p>Quer salvar esse compromisso na agenda do seu telefone?</p>
                        <button type="button" id="modal-sched-ics" class="primary-button">Salvar na agenda do telefone</button>
                        <button type="button" id="modal-sched-done" class="secondary-button">Concluir</button>
                    `;
                    card.querySelector('#modal-sched-ics').addEventListener('click', () => {
                        openIcsEvent({
                            title: `Retorno: ${visit.cliente || ''}`,
                            description: obsVal || 'Visita de retorno agendada pelo App de Visitas.',
                            dateStr: dataVal
                        });
                    });
                    card.querySelector('#modal-sched-done').addEventListener('click', close);
                } else {
                    showToast((result && result.message) || 'Erro ao agendar retorno.', true);
                    setSaving(false, btn);
                }
            });
        });
    });
}


// Mesmo estilo do "Agendar retorno" — modal do app, não confirm() nativo.
export function showAddToFunilModal(clienteNome) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card">
                <div style="font-size:2rem;margin-bottom:0.75rem">📊</div>
                <h3>Adicionar ao Funil?</h3>
                <p>Criar uma oportunidade no Funil de Vendas para <strong>${escapeHtml(clienteNome || 'este cliente')}</strong>?</p>
                <button type="button" id="modal-funil-yes" class="primary-button">Sim, adicionar</button>
                <button type="button" id="modal-funil-no" class="secondary-button">Agora não</button>
            </div>
        `;
        document.body.appendChild(overlay);
        const done = (val) => { overlay.remove(); resolve(val); };
        overlay.querySelector('#modal-funil-no').addEventListener('click', () => done(false));
        overlay.querySelector('#modal-funil-yes').addEventListener('click', () => done(true));
    });
}


export async function showCreateAgendamentoModal(onCreated) {
    const formDataResult = await ensureFormData();
    const clientes = (formDataResult.data && formDataResult.data.clientes) || [];
    const vendedoresAll = (formDataResult.data && formDataResult.data.vendedores) || [];
    const NAO_NOTIFICAR = 'Não notificar';
    const notifyOptions = [NAO_NOTIFICAR, ...resolveNotifyOptions(vendedoresAll, state.currentUser)];
    // Só faz sentido exigir a escolha quando existe alguém real pra notificar
    // — sem isso, "Não notificar" seria a única opção da lista, o que não
    // ajuda ninguém.
    const temNotifyReal = notifyOptions.length > 1;

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const defaultDate = new Date();
        defaultDate.setDate(defaultDate.getDate() + 1);
        overlay.innerHTML = `
            <div class="modal-card newag-modal">
                <div class="newag-modal-header">
                    <span class="newag-modal-header-icon" aria-hidden="true">📅</span>
                    <h3>Novo agendamento</h3>
                    <button type="button" class="newag-modal-close" id="newag-close" aria-label="Fechar">✕</button>
                </div>
                <div class="newag-modal-body">
                    <div class="form-row-pair">
                        <div class="form-group">
                            <label for="newag-cliente">Cliente *</label>
                            <div class="searchable-select">
                                <input type="text" id="newag-cliente" placeholder="Nome do cliente" autocomplete="off">
                                <div class="searchable-select-menu" id="newag-cliente-menu"></div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="newag-cidade">Cidade</label>
                            <input type="text" id="newag-cidade" placeholder="Cidade (opcional)">
                        </div>
                    </div>
                    <div class="form-row-pair">
                        <div class="form-group">
                            <label for="newag-data">Data do retorno *</label>
                            <input type="date" id="newag-data" value="${defaultDate.toISOString().slice(0, 10)}">
                        </div>
                        <div class="form-group">
                            <label class="newag-repetir-spacer" aria-hidden="true">&nbsp;</label>
                            <label class="newag-repetir-row">
                                <input type="checkbox" id="newag-repetir" style="width:auto;min-height:0">
                                🔁 Repetir a cada 30 dias
                                <span class="text-link" role="button" tabindex="0" id="newag-repetir-help-toggle" title="O que é isso?">ⓘ</span>
                            </label>
                        </div>
                    </div>
                    <p class="helper-text" id="newag-repetir-help" hidden style="text-align:left;margin:-0.3rem 0 0.6rem">Pra acompanhar algo por mais tempo (ex.: teste de produto) — cria vários agendamentos de uma vez, um a cada 30 dias, cada um independente.</p>
                    <div class="form-group full-width" id="newag-repetir-group" style="text-align:left;display:none">
                        <label for="newag-repetir-meses">Por quantos meses?</label>
                        <select id="newag-repetir-meses">
                            <option value="2">2 meses (2 lembretes)</option>
                            <option value="3" selected>3 meses (3 lembretes)</option>
                            <option value="6">6 meses (6 lembretes)</option>
                            <option value="12">12 meses (12 lembretes)</option>
                        </select>
                    </div>
                    <div class="form-group full-width" style="text-align:left">
                        <label for="newag-obs">Observação <span class="newag-label-optional">(opcional)</span></label>
                        <textarea id="newag-obs" rows="2" placeholder="Ex: ligar antes de ir..."></textarea>
                    </div>
                    ${temNotifyReal ? `
                    <div class="form-group full-width" style="text-align:left">
                        <div class="newag-notify-head">
                            <label for="newag-notify-search">Notificar usuários *</label>
                            <span class="text-link" role="button" tabindex="0" id="newag-notify-selectall">Selecionar todos</span>
                        </div>
                        <div class="newag-notify-search-row">
                            <input type="text" id="newag-notify-search" class="form-input" placeholder="🔍 Buscar usuário">
                            <span class="newag-notify-count" id="newag-notify-count"></span>
                        </div>
                        <input type="hidden" id="newag-notificar">
                        <div class="newag-chip-list" id="newag-notificar-list">
                            ${notifyOptions.map((nome) => `
                                <button type="button" class="newag-chip" data-value="${escapeHtml(nome)}">
                                    <span class="newag-chip-check" aria-hidden="true">✓</span><span>${escapeHtml(nome)}</span>
                                </button>`).join('')}
                        </div>
                    </div>` : ''}
                </div>
                <div class="newag-modal-footer">
                    <button type="button" class="secondary-button" id="modal-newag-cancel">Cancelar</button>
                    <button type="button" class="primary-button" id="modal-newag-save">Salvar agendamento</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Chips clicáveis (não checkbox) — mesma ideia de sempre (marcar
        // mais de um, "Não notificar" exclusivo), só que em formato de
        // pílula lado a lado em vez de lista vertical, com busca e
        // "Selecionar todos" — mais compacto quando tem muita gente na
        // lista, e deixa mais óbvio que é multi-seleção.
        if (temNotifyReal) {
            const notifyListEl = overlay.querySelector('#newag-notificar-list');
            const notifyHidden = overlay.querySelector('#newag-notificar');
            const notifySearch = overlay.querySelector('#newag-notify-search');
            const notifySelectAll = overlay.querySelector('#newag-notify-selectall');
            const notifyCount = overlay.querySelector('#newag-notify-count');
            const chips = Array.from(notifyListEl.querySelectorAll('.newag-chip'));
            const selected = new Set();

            const sync = () => {
                notifyHidden.value = Array.from(selected).join(',');
                chips.forEach((chip) => chip.classList.toggle('is-checked', selected.has(chip.dataset.value)));
                const n = selected.has(NAO_NOTIFICAR) ? 0 : selected.size;
                notifyCount.textContent = n ? `${n} selecionado${n > 1 ? 's' : ''}` : '';
            };
            chips.forEach((chip) => {
                chip.addEventListener('click', () => {
                    const val = chip.dataset.value;
                    if (val === NAO_NOTIFICAR) {
                        selected.clear();
                        if (!chip.classList.contains('is-checked')) selected.add(val);
                    } else {
                        selected.delete(NAO_NOTIFICAR);
                        if (selected.has(val)) selected.delete(val); else selected.add(val);
                    }
                    sync();
                });
            });
            notifySearch.addEventListener('input', () => {
                const q = notifySearch.value.trim().toLowerCase();
                chips.forEach((chip) => {
                    chip.style.display = !q || chip.dataset.value.toLowerCase().includes(q) ? '' : 'none';
                });
            });
            notifySelectAll.addEventListener('click', () => {
                const visiveisReais = chips.filter((c) => c.dataset.value !== NAO_NOTIFICAR && c.style.display !== 'none');
                const todasMarcadas = visiveisReais.length > 0 && visiveisReais.every((c) => selected.has(c.dataset.value));
                selected.delete(NAO_NOTIFICAR);
                visiveisReais.forEach((c) => { if (todasMarcadas) selected.delete(c.dataset.value); else selected.add(c.dataset.value); });
                sync();
            });
            sync();
        }

        overlay.querySelector('#newag-close').addEventListener('click', () => close());
        overlay.querySelector('#newag-repetir').addEventListener('change', (e) => {
            overlay.querySelector('#newag-repetir-group').style.display = e.target.checked ? '' : 'none';
        });
        overlay.querySelector('#newag-repetir-help-toggle').addEventListener('click', () => {
            const help = overlay.querySelector('#newag-repetir-help');
            help.hidden = !help.hidden;
        });

        // Busca no nome do cliente já cadastrado e autopreenche a cidade —
        // mas aceita texto livre (allowFreeText), já que o agendamento
        // também vale pra prospecção que ainda não tem cadastro.
        initializeSearchableInput({
            input: overlay.querySelector('#newag-cliente'),
            menu: overlay.querySelector('#newag-cliente-menu'),
            items: clientes.map((c) => clienteSearchItem(c)),
            allowFreeText: true,
            onSelect: (value) => {
                const match = findClienteByNome(clientes, value);
                if (match && match.cidade) {
                    overlay.querySelector('#newag-cidade').value = match.cidade;
                }
            }
        });

        const close = () => { overlay.remove(); resolve(); };
        overlay.querySelector('#modal-newag-cancel').addEventListener('click', close);
        overlay.querySelector('#modal-newag-save').addEventListener('click', async () => {
            const btn = overlay.querySelector('#modal-newag-save');
            const clienteVal = overlay.querySelector('#newag-cliente').value.trim();
            const dataVal = overlay.querySelector('#newag-data').value;
            if (!clienteVal) { showToast('Informe o cliente.', true); return; }
            if (!dataVal) { showToast('Informe a data do retorno.', true); return; }
            const notificarVal = overlay.querySelector('#newag-notificar')?.value || '';
            if (temNotifyReal && !notificarVal) { showToast('Escolha quem notificar (ou "Não notificar").', true); return; }
            const cidadeVal = overlay.querySelector('#newag-cidade').value.trim();
            const obsVal = overlay.querySelector('#newag-obs').value.trim();
            const repetir = overlay.querySelector('#newag-repetir').checked;
            const qtd = repetir ? Number(overlay.querySelector('#newag-repetir-meses').value) : 1;

            // Cada checkpoint é um agendamento independente de verdade (não
            // uma "série" com vínculo entre si) — dá pra concluir/cancelar/
            // mudar a data de um sem afetar os outros. Criados em sequência
            // (não em paralelo) porque o Id de cada um é gerado por
            // Date.now() no servidor — paralelo arriscaria colisão.
            const checkpoints = [];
            const dataBase = new Date(dataVal + 'T00:00:00');
            for (let i = 0; i < qtd; i++) {
                const d = new Date(dataBase);
                d.setDate(d.getDate() + i * 30);
                checkpoints.push(d);
            }

            setSaving(true, btn, 'Salvando...');
            const criados = [];
            for (let i = 0; i < checkpoints.length; i++) {
                const obsCheckpoint = qtd > 1
                    ? `${obsVal ? obsVal + ' — ' : ''}Acompanhamento (${i + 1}/${qtd})`
                    : obsVal;
                const r = await callAPI('createAgendamento', {
                    cliente: clienteVal, cidade: cidadeVal,
                    dataAgendada: checkpoints[i].toISOString().slice(0, 10),
                    observacao: obsCheckpoint, user: state.currentUser
                }).catch((e) => ({ status: 'error', message: e.message }));
                if (r && r.status === 'success') {
                    criados.push(r.agendamento);
                } else {
                    showToast((r && r.message) || 'Erro ao criar agendamento.', true);
                    setSaving(false, btn);
                    return;
                }
            }

            // Um só aviso pra tudo (não um por checkpoint) — pedido explícito
            // de poder notificar mais de um usuário; best-effort, não trava a
            // tela nem falha a criação se o push não sair.
            const notificarSelecionados = notificarVal.split(',').filter((v) => v && v !== NAO_NOTIFICAR);
            if (notificarSelecionados.length) {
                const detalhe = checkpoints.length > 1
                    ? `${checkpoints.length} agendamentos, a partir de ${formatDateForDisplay(checkpoints[0])}`
                    : formatDateForDisplay(checkpoints[0]);
                callAPI('notifyRegistroCriado', {
                    destinatarios: notificarSelecionados, tipo: 'agendamento', cliente: clienteVal, detalhe,
                    user: state.currentUser
                }).catch(() => {});
            }

            const card = overlay.querySelector('.modal-card');
            if (criados.length > 1) {
                showToast(`${criados.length} agendamentos criados com sucesso.`);
                card.innerHTML = `
                    <div style="font-size:2rem;margin-bottom:0.75rem">✅</div>
                    <h3>${criados.length} agendamentos criados</h3>
                    <p class="helper-text" style="text-align:left;margin:0 0 0.75rem">${checkpoints.map((d) => escapeHtml(formatDateForDisplay(d))).join(' · ')}</p>
                    <button type="button" class="secondary-button" id="modal-newag-done">Concluir</button>
                `;
                card.querySelector('#modal-newag-done').addEventListener('click', () => {
                    overlay.remove();
                    resolve();
                    if (onCreated) onCreated(criados[0]);
                });
                return;
            }

            showToast('Agendamento criado com sucesso.');
            card.innerHTML = `
                <div style="font-size:2rem;margin-bottom:0.75rem">✅</div>
                <h3>Agendamento criado</h3>
                <p>Quer salvar esse compromisso na agenda do seu telefone?</p>
                <button type="button" id="modal-newag-ics" class="primary-button">Salvar na agenda do telefone</button>
                <button type="button" id="modal-newag-done" class="secondary-button">Concluir</button>
            `;
            card.querySelector('#modal-newag-ics').addEventListener('click', () => {
                openIcsEvent({
                    title: `Retorno: ${clienteVal}`,
                    description: obsVal || 'Agendamento criado pelo App de Visitas.',
                    dateStr: dataVal
                });
            });
            card.querySelector('#modal-newag-done').addEventListener('click', () => {
                overlay.remove();
                resolve();
                if (onCreated) onCreated(criados[0]);
            });
        });
    });
}


export function getWhatsappConfigForVisit(tipoVisita) {
    if (!state.formData || !Array.isArray(state.formData.tiposVisita)) {
        return null;
    }
    return state.formData.tiposVisita.find((item) => item.tipo === tipoVisita && (item.obrigatorio || item.mensagemPadrao));
}


// Observação pro compartilhamento: quem cola uma conversa do WhatsApp na
// visita traz linhas como "[16:02, 03/09/2026] Fulano: texto" — no texto
// enviado isso vira só "texto". Com mais de uma linha, vira lista com
// marcador numa linha própria (fica legível no WhatsApp); uma linha só
// continua inline depois do rótulo. Só afeta o texto compartilhado, não
// o que está salvo.
function observacaoParaCompartilhar(observacao) {
    const linhas = String(observacao || '')
        .split('\n')
        .map((l) => l.replace(/^\s*\[\d{1,2}:\d{2},\s*\d{1,2}\/\d{1,2}\/\d{2,4}\]\s*[^:\n]{1,60}:\s*/, '').trim())
        .filter(Boolean);
    if (linhas.length <= 1) return linhas[0] || '';
    return '\n' + linhas.map((l) => `• ${l}`).join('\n');
}

export function buildWhatsappMessage(template, visit) {
    // Mesmo padrão do compartilhamento do Funil (título em negrito com o
    // cliente). Sem emoji no começo — chegava como caractere quebrado em
    // alguns aparelhos. Linha cujo campo estiver vazio é removida abaixo.
    const defaultTemplate = [
        '*Visita - {{cliente}}*',
        '*Data:* {{dataHora}}',
        '*Vendedor:* {{vendedor}}',
        '*Tipo:* {{tipoVisita}}',
        '*Cidade:* {{cidade}}',
        '*Contato:* {{contato}}',
        '*Prospecção:* {{prospeccao}}',
        '*Observação:* {{observacao}}'
    ].join('\n');
    const messageTemplate = template || defaultTemplate;
    const values = {
        cliente: visit.cliente,
        tipoVisita: visit.tipoVisita,
        observacao: observacaoParaCompartilhar(visit.observacao),
        vendedor: visit.vendedorGerente,
        cidade: visit.cidade,
        contato: visit.contato,
        data: visit.dataVisita,
        horario: visit.horario,
        dataHora: visit.dataVisita ? `${visit.dataVisita}${visit.horario ? ' às ' + visit.horario : ''}` : '',
        // Só aparece quando é prospecção — "Não" não acrescenta nada.
        prospeccao: visit.prospeccao === 'Sim' ? 'Sim' : ''
    };

    // Campo vazio marca a linha; se sobrou só o rótulo ("*Contato:*"), a
    // linha inteira some — vale pro modelo padrão e pros configurados no
    // Admin (Notificações), que usam os mesmos {{campos}}.
    const VAZIO = String.fromCharCode(0);
    const preenchido = messageTemplate.replace(/{{\s*([a-zA-Z]+)\s*}}/g, (_, key) => {
        const v = values[key];
        return (v === undefined || v === null || String(v).trim() === '') ? VAZIO : String(v);
    });
    return preenchido
        .split('\n')
        .filter((line) => {
            if (!line.includes(VAZIO)) return true;
            const resto = line.split(VAZIO).join('').trim();
            return !(resto === '' || /:\*?$/.test(resto));
        })
        .join('\n')
        .split(VAZIO).join('')
        .trim();
}


export function shareVisit(visit) {
    // Mesmo texto do botão de WhatsApp do detalhe, pra não ter dois formatos.
    const lines = buildWhatsappMessage(null, visit);

    if (navigator.share) {
        navigator.share({ title: `Visita - ${visit.cliente || ''}`, text: lines }).catch(() => {});
    } else {
        navigator.clipboard.writeText(lines).then(() => showToast('Visita copiada!')).catch(() => showToast('Não foi possível compartilhar.', true));
    }
}
