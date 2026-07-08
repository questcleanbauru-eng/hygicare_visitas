import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, getSyncTimestamp, setSyncTimestamp, mergeById, attemptOrQueue } from '../api.js';
import {
    escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate,
    calculateDaysFromDisplayDate, formatDateForDisplay, formatDateFromDisplay, formatInputDateFromDisplay
} from '../utils/format.js';
import {
    debounce, renderDetailRow, showToast, renderSimpleOptions,
    showRefreshIndicator, hideRefreshIndicator, skeletonDetail, loadingState, addFabAndScrollTop,
    openExternal, initializeSearchableInput, renderYearChips
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, updateFunilBadge, ensureStyles } from '../utils/ui.js';
import { trackUpdate, getSummaryCount, shareSummaryAndClear } from '../utils/updateSummary.js';

export function fillFunilContent(mainContent, funil) {
    let funilData = funil || [];
    const isAdmGer = isAdminOrGerenteUser();

    const newFunilDisabledAttr = state.canCreateProposalFunil ? '' : 'disabled title="Peça ao administrador para liberar a criação de oportunidades."';

    if (funilData.length === 0) {
        const scopeIsLimited = state.funilScope && state.funilScope !== 'all';
        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Funil de Vendas</h2></div>
                <button type="button" class="btn-add" id="btn-new-funil" ${newFunilDisabledAttr}>+ Novo</button>
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
                <span class="empty-state-icon">📊</span>
                ${scopeIsLimited
                    ? `<p>Nenhum registro nos últimos ${state.loadDias || 90} dias.</p>`
                    : `<p>Nenhum registro encontrado no funil.</p>
                       <button type="button" class="btn-add" id="btn-new-funil-empty" ${newFunilDisabledAttr}>+ Novo</button>`
                }
                <button type="button" class="secondary-button" id="funil-force-refresh" style="margin-top:0.5rem">↺ Recarregar</button>
            </div>
        `;
        document.getElementById('btn-new-funil')?.addEventListener('click', () => navigateTo('funil-new'));
        document.getElementById('btn-new-funil-empty')?.addEventListener('click', () => navigateTo('funil-new'));
        if (scopeIsLimited) {
            document.getElementById('scope-load-days')?.addEventListener('click', () => {
                const v = parseInt(document.getElementById('scope-dias-input')?.value, 10);
                if (v > 0) { state.loadDias = v; saveCache('funil', null); navigateTo('funil'); }
            });
            document.getElementById('scope-load-all')?.addEventListener('click', () => {
                state.navLoadAll = 'funil'; navigateTo('funil');
            });
        }
        document.getElementById('funil-force-refresh')?.addEventListener('click', () => {
            saveCache('funil', null);
            saveCache('funil_all', null);
            state.funil = [];
            navigateTo('funil');
        });
        return;
    }

    const availableStatuses = Array.from(new Set(funilData.map((f) => f.status).filter(Boolean)));
    const availableCidades  = Array.from(new Set(funilData.map((f) => f.cidade).filter(Boolean))).sort();
    const availableVendors  = isAdmGer
        ? Array.from(new Set(funilData.map((f) => f.vendedor).filter(Boolean))).sort()
        : [];

    const summaryCount = getSummaryCount();
    mainContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Funil de Vendas</h2>
                <p class="page-subtitle">${funilData.length} oportunidade(s)</p>
            </div>
            <button type="button" class="btn-add" id="btn-new-funil" ${newFunilDisabledAttr}>+ Novo</button>
        </div>
        ${summaryCount > 0 ? `<div style="margin-bottom:0.75rem">
            <button type="button" class="csv-export-btn" id="update-summary-btn" title="Compartilhar resumo de atualizações">
                📤 Resumo <span class="pending-badge" style="margin-left:0.2rem">${summaryCount}</span>
            </button>
        </div>` : ''}
        <div class="card funil-filter-card">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    <button type="button" class="mini-button" id="funil-filter-clear">Limpar</button>
                    <button type="button" class="mini-button" id="funil-filter-toggle">Ocultar</button>
                </div>
            </div>
            <div class="visits-filter-grid" id="funil-filter-panel">
                <div class="form-group">
                    <label for="funil-filter-search">Busca</label>
                    <input type="text" id="funil-filter-search" placeholder="Cliente, foco ou obs">
                </div>
                <div class="form-group">
                    <label for="funil-filter-status">Status</label>
                    <div class="searchable-select">
                        <input type="text" id="funil-filter-status" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="funil-filter-status-menu"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="funil-filter-cidade">Cidade</label>
                    <div class="searchable-select">
                        <input type="text" id="funil-filter-cidade" placeholder="Todas" autocomplete="off">
                        <div class="searchable-select-menu" id="funil-filter-cidade-menu"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="funil-filter-ativo">Ativo</label>
                    <select id="funil-filter-ativo">
                        <option value="">Todos</option>
                        <option value="SIM">Sim</option>
                        <option value="NAO">Não</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="funil-filter-atrasado">Situação</label>
                    <select id="funil-filter-atrasado">
                        <option value="">Todas</option>
                        <option value="sim">Precisam de atualização</option>
                        <option value="nao">Em dia</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="funil-filter-period">Período</label>
                    <select id="funil-filter-period">
                        <option value="">Todos</option>
                        <option value="mes-atual">Mês atual</option>
                        <option value="ultimos-3m">Últimos 3 meses</option>
                    </select>
                </div>
                ${isAdmGer ? `
                <div class="form-group">
                    <label for="funil-filter-vendor">Vendedor</label>
                    <div class="searchable-select">
                        <input type="text" id="funil-filter-vendor" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="funil-filter-vendor-menu"></div>
                    </div>
                </div>` : ''}
                <div class="form-group">
                    <label for="funil-filter-vl">Valor minimo R$</label>
                    <input type="number" id="funil-filter-vl" placeholder="0" min="0">
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
        <div id="funil-year-chips" class="year-chips-row"></div>
        <div id="funil-list-container"></div>
    `;

    const filterToggle = document.getElementById('funil-filter-toggle');
    const filterPanel = document.getElementById('funil-filter-panel');
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
        const dateFromCheck = document.getElementById('funil-filter-date-from')?.value || '';
        if (state.funilScope !== 'all' && dateFromCheck) {
            const cutoffDias = new Date();
            cutoffDias.setDate(cutoffDias.getDate() - (state.loadDias || 90));
            if (new Date(dateFromCheck) < cutoffDias) {
                const listEl = document.getElementById('funil-list-container');
                if (listEl) listEl.innerHTML = `<div class="scope-loading">Carregando histórico completo...</div>`;
                try {
                    const r = await callAPI('getFunil', { user: state.currentUser, meses: 0 });
                    if (r.status === 'success') {
                        state.funil = r.funil || r.data || [];
                        state.funilScope = 'all';
                        saveCache('funil_all', state.funil);
                        funilData = state.funil;
                    }
                } catch(e) {}
            }
        }
        const search       = document.getElementById('funil-filter-search')?.value.trim().toLowerCase() || '';
        const statusFilter = document.getElementById('funil-filter-status')?.value || '';
        const cidadeFilter = document.getElementById('funil-filter-cidade')?.value || '';
        const ativoFilter  = document.getElementById('funil-filter-ativo')?.value || '';
        const atrasadoFilter = document.getElementById('funil-filter-atrasado')?.value || '';
        const period       = document.getElementById('funil-filter-period')?.value || '';
        const vendorFilter = document.getElementById('funil-filter-vendor')?.value || '';
        const vlMin        = Number(document.getElementById('funil-filter-vl')?.value || 0);
        const { start: periodStart, end: periodEnd } = getDateRangeForPeriod(period);

        const filtered = funilData.filter((f) => {
            const matchSearch  = !search || [f.cliente, f.cidade, f.foco, f.atuacao, f.comentarios].some((v) => String(v || '').toLowerCase().includes(search));
            const matchStatus  = !statusFilter || f.status === statusFilter;
            const matchCidade  = !cidadeFilter || f.cidade === cidadeFilter;
            const matchAtivo   = !ativoFilter || (ativoFilter === 'SIM' ? String(f.ativo).toLowerCase() === 'sim' : String(f.ativo).toLowerCase() !== 'sim');
            const isOverdue    = String(f.ativo || '').toLowerCase() === 'sim'
                && !['CONCLUIDO', 'PERDIDO'].includes(String(f.status || '').toUpperCase())
                && calculateDaysFromDisplayDate(f.atualizacao || f.data || '') > 30;
            const matchAtrasado = !atrasadoFilter || (atrasadoFilter === 'sim' ? isOverdue : !isOverdue);
            const matchVendor  = !vendorFilter || f.vendedor === vendorFilter;
            const atuDate      = parseDisplayDate(f.atualizacao) || parseDisplayDate(f.data);
            const matchPeriod  = !period || (atuDate && atuDate >= periodStart && atuDate <= periodEnd);
            const matchVl      = !vlMin || Number(String(f.vlMensal).replace(/[^\d.]/g, '') || 0) >= vlMin;
            const matchYear    = !state.funilYearFilter || (atuDate && atuDate.getFullYear() === state.funilYearFilter);
            return matchSearch && matchStatus && matchCidade && matchAtivo && matchAtrasado && matchVendor && matchPeriod && matchVl && matchYear;
        });

        const container = document.getElementById('funil-list-container');
        if (!container) { return; }

        if (filtered.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>Nenhum registro encontrado para os filtros.</p></div>`;
            return;
        }

        const sorted = [...filtered].sort((a, b) => {
            const da = parseDisplayDate(a.atualizacao) || parseDisplayDate(a.data);
            const db = parseDisplayDate(b.atualizacao) || parseDisplayDate(b.data);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });

        container.innerHTML = `<div class="visits-list">${sorted.map((f) => {
            const overdue = String(f.ativo || '').toLowerCase() === 'sim'
                && !['CONCLUIDO', 'PERDIDO'].includes(String(f.status || '').toUpperCase())
                && calculateDaysFromDisplayDate(f.atualizacao || f.data || '') > 30;
            return `
            <button type="button" class="proposal-card funil-card ${overdue ? 'proposal-card-alert' : ''}" data-funil-id="${escapeHtml(f.id)}">
                <div class="visit-card-header">
                    <strong>${escapeHtml(f.cliente || 'Cliente não informado')}</strong>
                    ${f._pending ? '<span class="pending-badge" title="Aguardando conexão para enviar">⏳ Pendente</span>' : `<span class="status-pill funil-status-${escapeHtml((f.status || '').toLowerCase())}">${escapeHtml(f.status || '-')}</span>`}
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(f.foco || '-')}</span>
                    <span>${escapeHtml(f.cidade || '-')}</span>
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(f.vendedor || '-')}</span>
                    <span>${escapeHtml(f.atualizacao || f.data || '-')}</span>
                </div>
                ${f.vlMensal ? `<div class="funil-value">R$ ${escapeHtml(f.vlMensal)}</div>` : ''}
                ${overdue ? '<div class="alert-text">Sem atualização há mais de 30 dias.</div>' : ''}
            </button>
        `;
        }).join('')}</div>`;

        container.querySelectorAll('[data-funil-id]').forEach((btn) => {
            btn.addEventListener('click', () => navigateTo('funil-detail', { id: btn.dataset.funilId }));
        });
    };

    const _funilFilterIds = ['funil-filter-search', 'funil-filter-status', 'funil-filter-cidade', 'funil-filter-ativo',
        'funil-filter-atrasado', 'funil-filter-period', 'funil-filter-vendor', 'funil-filter-vl'];
    initializeSearchableInput({ input: document.getElementById('funil-filter-status'), menu: document.getElementById('funil-filter-status-menu'), items: availableStatuses });
    initializeSearchableInput({ input: document.getElementById('funil-filter-cidade'), menu: document.getElementById('funil-filter-cidade-menu'), items: availableCidades });
    if (isAdmGer) {
        initializeSearchableInput({ input: document.getElementById('funil-filter-vendor'), menu: document.getElementById('funil-filter-vendor-menu'), items: availableVendors });
    }

    const _funilTextFilterIds = new Set(['funil-filter-search', 'funil-filter-vl', 'funil-filter-status', 'funil-filter-cidade', 'funil-filter-vendor']);
    const _debouncedFunilFilter = debounce(renderFiltered, 250);
    _funilFilterIds.forEach((id) => {
        const el = document.getElementById(id);
        const isText = _funilTextFilterIds.has(id);
        el?.addEventListener(isText ? 'input' : 'change', isText ? _debouncedFunilFilter : renderFiltered);
    });

    document.getElementById('funil-filter-clear')?.addEventListener('click', () => {
        _funilFilterIds.forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; } });
        state.funilYearFilter = null;
        renderFiltered();
        updateYearChips();
    });

    document.getElementById('scope-load-days')?.addEventListener('click', () => {
        const v = parseInt(document.getElementById('scope-dias-input')?.value, 10);
        if (v > 0) { state.loadDias = v; saveCache('funil', null); navigateTo('funil'); }
    });

    function updateYearChips() {
        const chipsEl = document.getElementById('funil-year-chips');
        if (!chipsEl) return;
        if (state.funilScope !== 'all') { chipsEl.innerHTML = ''; return; }
        const dates = funilData.map((f) => parseDisplayDate(f.atualizacao) || parseDisplayDate(f.data));
        renderYearChips(chipsEl, dates, state.funilYearFilter, (year) => {
            state.funilYearFilter = year;
            renderFiltered();
            updateYearChips();
        });
    }
    updateYearChips();

    document.getElementById('scope-load-all')?.addEventListener('click', async () => {
        const listEl = document.getElementById('funil-list-container');
        if (listEl) listEl.innerHTML = `<div class="scope-loading">Carregando histórico completo...</div>`;
        try {
            const r = await callAPI('getFunil', { user: state.currentUser, meses: 0 });
            if (r.status === 'success') {
                state.funil = r.funil || r.data || [];
                state.funilScope = 'all';
                saveCache('funil_all', state.funil);
                funilData = state.funil;
                document.querySelector('.scope-banner')?.remove();
                initializeSearchableInput({ input: document.getElementById('funil-filter-status'), menu: document.getElementById('funil-filter-status-menu'), items: Array.from(new Set(funilData.map((f) => f.status).filter(Boolean))) });
                initializeSearchableInput({ input: document.getElementById('funil-filter-cidade'), menu: document.getElementById('funil-filter-cidade-menu'), items: Array.from(new Set(funilData.map((f) => f.cidade).filter(Boolean))).sort() });
                if (isAdmGer) initializeSearchableInput({ input: document.getElementById('funil-filter-vendor'), menu: document.getElementById('funil-filter-vendor-menu'), items: Array.from(new Set(funilData.map((f) => f.vendedor).filter(Boolean))).sort() });
                renderFiltered();
                updateYearChips();
            }
        } catch(e) {}
    });

    document.getElementById('btn-new-funil')?.addEventListener('click', () => navigateTo('funil-new'));
    document.getElementById('update-summary-btn')?.addEventListener('click', () => {
        if (confirm('Compartilhar o resumo de atualizações no WhatsApp e limpar a lista?')) {
            shareSummaryAndClear();
            navigateTo('funil');
        }
    });

    renderFiltered();
}


export async function renderFunilPage() {
    ensureStyles('funil');
    const mainContent = document.getElementById('main-content');
    const loadAll = state.navLoadAll === 'funil';
    state.navLoadAll = null;
    const cachedAll  = loadCache('funil_all');
    const cached3m   = loadCache('funil');
    const cachedFunil = loadAll ? cachedAll : (cachedAll || (cached3m && Array.isArray(cached3m) && cached3m.length > 0 ? cached3m : null));
    if (cachedFunil) {
        state.funilScope = cachedAll ? 'all' : '3m';
        state.funil = cachedFunil;
        fillFunilContent(mainContent, state.funil);
        const overdueCountCached = state.funil.filter((f) => calculateDaysFromDisplayDate(f.atualizacao || f.data || '') > 30).length;
        updateFunilBadge(overdueCountCached);
        addFabAndScrollTop('Nova Oportunidade', () => {
            if (state.canCreateProposalFunil) { navigateTo('funil-new'); }
            else { showToast('Peça ao administrador para liberar a criação de oportunidades.', true); }
        });
        initPullToRefresh(() => { saveCache('funil', null); saveCache('funil_all', null); navigateTo('funil'); });
        getFunil(loadAll || cachedAll ? 0 : 3);
        return;
    }
    mainContent.innerHTML = loadingState('📊', 'Carregando o funil de vendas...');

    const result = await getFunil(loadAll ? 0 : undefined);
    state.funilScope = result.scope || 'all';
    if (result.status !== 'success') {
        mainContent.innerHTML = `
            <div class="page-header"><div><h2>Funil de Vendas</h2></div></div>
            <div class="empty-state">
                <span class="empty-state-icon">⚠️</span>
                <p>${escapeHtml(result.message || 'Erro ao carregar o funil.')}</p>
                <button type="button" class="btn-add" id="funil-retry">Tentar novamente</button>
            </div>`;
        document.getElementById('funil-retry')?.addEventListener('click', () => {
            saveCache('funil', null);
            state.funil = [];
            navigateTo('funil');
        });
        return;
    }
    state.funil = result.funil || [];
    fillFunilContent(mainContent, state.funil);
    const overdueCount = state.funil.filter((f) => {
        const days = calculateDaysFromDisplayDate(f.atualizacao || f.data || '');
        return days > 30;
    }).length;
    updateFunilBadge(overdueCount);
    addFabAndScrollTop('Nova Oportunidade', () => {
        if (state.canCreateProposalFunil) { navigateTo('funil-new'); }
        else { showToast('Peça ao administrador para liberar a criação de oportunidades.', true); }
    });
    initPullToRefresh(() => { saveCache('funil', null); saveCache('funil_all', null); navigateTo('funil'); });
}


export async function renderFunilCreatePage() {
    ensureStyles('funil');
    const mainContent = document.getElementById('main-content');
    if (!state.formData) {
        mainContent.innerHTML = `
            <div class="page-header compact-header">
                <button type="button" class="mini-button" id="back-funil-overlay">Voltar</button>
                <h2>Novo Funil</h2>
                <span></span>
            </div>
            <div class="card form-card" style="position:relative;min-height:200px;">
                <div class="form-loading-overlay">
                    <div class="form-loading-spinner"></div>
                    <span>Carregando formulario...</span>
                </div>
            </div>
        `;
        document.getElementById('back-funil-overlay')?.addEventListener('click', () => navigateTo('funil'));
    }

    const fdResult = await ensureFormData();
    const cidades = (fdResult.data && fdResult.data.cidades) || [];
    const potenciais = (fdResult.data && fdResult.data.potenciaisCliente) || [];
    const areas = (fdResult.data && fdResult.data.areasAtuacao) || [];
    const aplicacoes = (fdResult.data && fdResult.data.aplicacoes) || [];
    const equipamentosList = (fdResult.data && fdResult.data.equipamentos) || [];

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-funil-create">Voltar</button>
            <h2>Novo Funil</h2>
            <span></span>
        </div>
        <form id="funil-create-form" class="card form-card form-layout">
            <div class="form-group full-width">
                <label for="fc-cliente">Cliente *</label>
                <input type="text" id="fc-cliente" placeholder="Nome do cliente" required>
            </div>
            <div class="form-group">
                <label for="fc-cidade">Cidade</label>
                <div class="searchable-select">
                    <input type="text" id="fc-cidade" placeholder="Pesquise a cidade" autocomplete="off">
                    <div class="searchable-select-menu" id="fc-cidade-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="fc-foco">Foco</label>
                <div class="searchable-select">
                    <input type="text" id="fc-foco" placeholder="Pesquise o potencial" autocomplete="off">
                    <div class="searchable-select-menu" id="fc-foco-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="fc-atuacao">Atuacao</label>
                <div class="searchable-select">
                    <input type="text" id="fc-atuacao" placeholder="Pesquise a area" autocomplete="off">
                    <div class="searchable-select-menu" id="fc-atuacao-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="fc-aplicacao">Aplicacao</label>
                <div class="searchable-select">
                    <input type="text" id="fc-aplicacao" placeholder="Pesquise a aplicacao" autocomplete="off">
                    <div class="searchable-select-menu" id="fc-aplicacao-menu"></div>
                </div>
            </div>
            <div class="form-group full-width">
                <label for="fc-equipamentos">Equipamentos</label>
                <div class="searchable-select">
                    <input type="text" id="fc-equipamentos" placeholder="Pesquise o equipamento" autocomplete="off">
                    <div class="searchable-select-menu" id="fc-equipamentos-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="fc-status">Status</label>
                <select id="fc-status">
                    ${renderSimpleOptions(['IDENTIFICAR', 'PROPOSTA', 'NEGOCIAR', 'CONCLUIDO', 'PERDIDO', 'RETOMAR'], 'IDENTIFICAR')}
                </select>
            </div>
            <div class="form-group">
                <label for="fc-vl-mensal">VL Mensal R$</label>
                <input type="text" id="fc-vl-mensal" placeholder="0,00">
            </div>
            <div class="form-group">
                <label for="fc-conclusao">Conclusao (data)</label>
                <input type="date" id="fc-conclusao">
            </div>
            <div class="form-group full-width">
                <label for="fc-inf">Inf Importantes</label>
                <input type="text" id="fc-inf" placeholder="Informações relevantes">
            </div>
            <div class="form-group full-width">
                <label for="fc-comentarios">Comentarios</label>
                <textarea id="fc-comentarios" rows="4" placeholder="Observacoes e proximos passos"></textarea>
            </div>
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-funil-create">Cancelar</button>
                <button type="submit" id="save-funil-create">Salvar Funil</button>
            </div>
        </form>
    `;

    initializeSearchableInput({
        input: document.getElementById('fc-cidade'),
        menu: document.getElementById('fc-cidade-menu'),
        items: cidades
    });
    initializeSearchableInput({
        input: document.getElementById('fc-foco'),
        menu: document.getElementById('fc-foco-menu'),
        items: potenciais
    });
    initializeSearchableInput({
        input: document.getElementById('fc-atuacao'),
        menu: document.getElementById('fc-atuacao-menu'),
        items: areas
    });
    initializeSearchableInput({
        input: document.getElementById('fc-aplicacao'),
        menu: document.getElementById('fc-aplicacao-menu'),
        items: aplicacoes
    });
    initializeSearchableInput({
        input: document.getElementById('fc-equipamentos'),
        menu: document.getElementById('fc-equipamentos-menu'),
        items: equipamentosList
    });

    document.getElementById('back-funil-create').addEventListener('click', () => navigateTo('funil'));
    document.getElementById('cancel-funil-create').addEventListener('click', () => navigateTo('funil'));

    document.getElementById('funil-create-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const btn = document.getElementById('save-funil-create');
        btn.disabled = true;
        btn.textContent = 'Salvando...';

        const conclusaoValue = document.getElementById('fc-conclusao').value;
        const funilPayload = {
            cliente:        document.getElementById('fc-cliente').value.trim(),
            cidade:         document.getElementById('fc-cidade').value.trim(),
            foco:           document.getElementById('fc-foco').value.trim(),
            atuacao:        document.getElementById('fc-atuacao').value.trim(),
            aplicacao:      document.getElementById('fc-aplicacao').value.trim(),
            equipamentos:   document.getElementById('fc-equipamentos').value.trim(),
            status:         document.getElementById('fc-status').value,
            vlMensal:       document.getElementById('fc-vl-mensal').value.trim(),
            conclusao:      conclusaoValue ? formatDateFromDisplay(conclusaoValue) : '',
            infImportantes: document.getElementById('fc-inf').value.trim(),
            comentarios:    document.getElementById('fc-comentarios').value.trim(),
        };

        const tempFCId = 'temp_' + Date.now();
        const nowFCDisplay = formatDateForDisplay(new Date());
        const optimisticFunil = {
            id: tempFCId, data: nowFCDisplay, atualizacao: nowFCDisplay, ativo: 'Sim',
            vendedor: state.currentUser.name, gerencia: state.currentUser.gerencia,
            ...funilPayload
        };
        state.funil = [optimisticFunil, ...(state.funil || [])];
        saveCache('funil', state.funil);

        showToast('Funil criado com sucesso.');
        navigateTo('funil');

        attemptOrQueue('createFunil', { ...funilPayload, user: state.currentUser }, { entity: 'funil', tempId: tempFCId })
            .then(result => {
                if (result && result.status === 'success') {
                    const real = result.funil || optimisticFunil;
                    state.funil = state.funil.map(f => f.id === tempFCId ? real : f);
                    saveCache('funil', state.funil);
                } else if (result && result.status === 'queued') {
                    state.funil = state.funil.map(f => f.id === tempFCId ? { ...optimisticFunil, _pending: true } : f);
                    saveCache('funil', state.funil);
                    showToast('Sem conexão — o registro foi salvo no aparelho e será enviado quando a conexão voltar.');
                } else {
                    state.funil = state.funil.filter(f => f.id !== tempFCId);
                    saveCache('funil', state.funil);
                    showToast((result && result.message) || 'Erro ao criar funil.', true);
                }
            })
            .catch(() => {
                state.funil = state.funil.filter(f => f.id !== tempFCId);
                saveCache('funil', state.funil);
                showToast('Erro ao criar funil.', true);
            });
    });
}


export async function renderFunilDetailPage(id) {
    ensureStyles('funil');
    const mainContent = document.getElementById('main-content');
    const existing = state.funil.find((f) => String(f.id) === String(id));
    if (!existing) {
        mainContent.innerHTML = skeletonDetail(12);
    }

    const result = existing
        ? { status: 'success', funil: existing }
        : await getFunilById(id);

    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Registro não encontrado.')}</p>`;
        return;
    }

    const f = result.funil;
    state.currentFunil = f;

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Funil', page: 'funil' }, { label: f.cliente || 'Oportunidade' }])}
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-funil">Voltar</button>
            <h2>Funil de Vendas</h2>
            <button type="button" class="mini-button" id="edit-funil">Editar</button>
        </div>
        <div class="funil-status-banner funil-status-${escapeHtml((f.status || '').toLowerCase())}">
            ${escapeHtml(f.status || '-')}
        </div>
        <div class="card detail-card">
            ${renderDetailRow('Cliente', f.cliente)}
            ${renderDetailRow('Vendedor', f.vendedor)}
            ${renderDetailRow('Cidade', f.cidade)}
            ${renderDetailRow('Data', f.data)}
            ${renderDetailRow('Ativo', f.ativo)}
            ${renderDetailRow('Foco', f.foco)}
            ${renderDetailRow('Atuacao', f.atuacao)}
            ${renderDetailRow('Aplicacao', f.aplicacao)}
            ${renderDetailRow('Equipamentos', f.equipamentos)}
            ${renderDetailRow('Gerência', f.gerencia)}
            ${renderDetailRow('VL Mensal R$', f.vlMensal || '-')}
            ${renderDetailRow('Conclusão', f.conclusao || '-')}
            ${renderDetailRow('Inf Importantes', f.infImportantes || '-')}
            ${renderDetailRow('Comentários', f.comentarios || '-')}
        </div>
        <div class="sticky-action-bar">
            <button type="button" id="share-funil-whatsapp" class="proposal-action-whatsapp">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                WhatsApp
            </button>
        </div>
        ${state.canDelete ? `<div style="margin-top:0.75rem"><button type="button" class="danger-button" id="delete-funil">Apagar</button></div>` : ''}
    `;

    document.querySelectorAll('#back-funil').forEach((el) => el.addEventListener('click', () => navigateTo('funil')));
    document.getElementById('edit-funil').addEventListener('click', () => navigateTo('funil-edit', { funil: f }));
    document.getElementById('share-funil-whatsapp').addEventListener('click', () => {
        const text = `*Funil - ${f.cliente}*\nStatus: ${f.status}\nFoco: ${f.foco || '-'}\nCidade: ${f.cidade || '-'}\nVL Mensal: ${f.vlMensal ? 'R$ ' + f.vlMensal : '-'}\nAtualização: ${f.atualizacao || f.data || '-'}`;
        openExternal(`https://wa.me/?text=${encodeURIComponent(text)}`);
    });
    document.getElementById('delete-funil')?.addEventListener('click', async () => {
        if (!confirm(`Apagar o registro de "${f.cliente || 'cliente'}"? Essa ação não pode ser desfeita.`)) return;
        const result = await callAPI('deleteFunil', { id: f.id, user: state.currentUser });
        if (result && result.status === 'success') {
            state.funil = state.funil.filter((item) => String(item.id) !== String(f.id));
            saveCache('funil', state.funil);
            showToast('Registro apagado.');
            navigateTo('funil');
        } else {
            showToast((result && result.message) || 'Não foi possível apagar o registro.', true);
        }
    });
}


export async function renderFunilFormPage(funil) {
    ensureStyles('funil');
    const f = funil || state.currentFunil;
    const mainContent = document.getElementById('main-content');

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-funil-detail">Voltar</button>
            <h2>Atualizar Funil</h2>
        </div>
        <div class="card form-card">
            <div class="funil-readonly-info">
                <div class="funil-readonly-row"><span>Cliente</span><strong>${escapeHtml(f.cliente || '-')}</strong></div>
                <div class="funil-readonly-row"><span>Foco</span><strong>${escapeHtml(f.foco || '-')}</strong></div>
                <div class="funil-readonly-row"><span>Cidade</span><strong>${escapeHtml(f.cidade || '-')}</strong></div>
            </div>
        </div>
        <form id="funil-form" class="card form-card form-layout">
            <input type="hidden" id="funil-id" value="${escapeHtml(f.id)}">
            <div class="form-group full-width">
                <label for="funil-status">Status</label>
                <select id="funil-status" required>
                    ${renderSimpleOptions(['IDENTIFICAR', 'PROPOSTA', 'NEGOCIAR', 'CONCLUIDO', 'PERDIDO', 'RETOMAR'], f.status)}
                </select>
            </div>
            <div class="form-group">
                <label for="funil-vl-mensal">VL Mensal R$</label>
                <input type="text" id="funil-vl-mensal" value="${escapeHtml(f.vlMensal || '')}" placeholder="0,00">
            </div>
            <div class="form-group">
                <label for="funil-conclusao">Conclusao (data)</label>
                <input type="date" id="funil-conclusao" value="${escapeHtml(formatInputDateFromDisplay(f.conclusao) || '')}">
            </div>
            <div class="form-group full-width">
                <label for="funil-inf">Inf Importantes</label>
                <input type="text" id="funil-inf" value="${escapeHtml(f.infImportantes || '')}" placeholder="Informações relevantes">
            </div>
            <div class="form-group full-width">
                <label for="funil-comentarios">Comentarios</label>
                <textarea id="funil-comentarios" rows="4" placeholder="Observacoes e proximos passos">${escapeHtml(f.comentarios || '')}</textarea>
            </div>
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-funil">Cancelar</button>
                <button type="submit" id="save-funil">Salvar</button>
            </div>
        </form>
    `;

    document.getElementById('back-funil-detail').addEventListener('click', () => navigateTo('funil-detail', { id: f.id }));
    document.getElementById('cancel-funil').addEventListener('click', () => navigateTo('funil-detail', { id: f.id }));

    document.getElementById('funil-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const btn = document.getElementById('save-funil');
        btn.disabled = true;
        btn.textContent = 'Salvando...';

        const conclusaoValue = document.getElementById('funil-conclusao').value;
        const newFStatus   = document.getElementById('funil-status').value;
        const newFVl       = document.getElementById('funil-vl-mensal').value.trim();
        const newFConcl    = conclusaoValue ? formatDateFromDisplay(conclusaoValue) : '';
        const newFInf      = document.getElementById('funil-inf').value.trim();
        const newFComent   = document.getElementById('funil-comentarios').value.trim();

        const fIdx = state.funil.findIndex(item => String(item.id) === String(f.id));
        const fOriginal = fIdx >= 0 ? { ...state.funil[fIdx] } : null;
        const nowFDisplay = formatDateForDisplay(new Date());

        if (fIdx >= 0) {
            state.funil[fIdx] = { ...state.funil[fIdx], status: newFStatus, vlMensal: newFVl,
                conclusao: newFConcl, infImportantes: newFInf, comentarios: newFComent, atualizacao: nowFDisplay };
            saveCache('funil', state.funil);
        }

        showToast('Funil atualizado com sucesso.');
        navigateTo('funil-detail', { id: f.id });

        attemptOrQueue('updateFunil', { id: f.id, status: newFStatus, vlMensal: newFVl,
            conclusao: newFConcl, infImportantes: newFInf, comentarios: newFComent, user: state.currentUser },
            { entity: 'funil', tempId: f.id })
            .then(result => {
                if (result && result.status === 'success') {
                    state.funil = state.funil.map(item => String(item.id) === String(f.id) ? result.funil : item);
                    saveCache('funil', state.funil);
                    trackUpdate('funil', { id: f.id, cliente: f.cliente, status: newFStatus });
                } else if (result && result.status === 'queued') {
                    if (fIdx >= 0) {
                        state.funil[fIdx] = { ...state.funil[fIdx], _pending: true };
                        saveCache('funil', state.funil);
                    }
                    showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                    trackUpdate('funil', { id: f.id, cliente: f.cliente, status: newFStatus });
                } else {
                    if (fIdx >= 0 && fOriginal) { state.funil[fIdx] = fOriginal; saveCache('funil', state.funil); }
                    showToast((result && result.message) || 'Erro ao salvar. Tente novamente.', true);
                }
            })
            .catch(() => {
                if (fIdx >= 0 && fOriginal) { state.funil[fIdx] = fOriginal; saveCache('funil', state.funil); }
                showToast('Erro ao salvar. Tente novamente.', true);
            });

        btn.disabled = false;
        btn.textContent = 'Salvar';
    });
}


export async function getFunil(diasParam) {
    const dias = diasParam === 0 ? 0 : (diasParam || state.loadDias || 90);
    const cacheKey = dias === 0 ? 'funil_all' : 'funil';
    const cached = loadCache(cacheKey);
    const sinceTs = (cached && cached.length > 0) ? getSyncTimestamp(cacheKey) : 0;
    const fresh = callAPI('getFunil', { user: state.currentUser, dias: dias, since: sinceTs || undefined })
        .then(function(r) {
            if (r.status === 'success') {
                const incoming = r.funil || r.data || [];
                let merged = (sinceTs && cached) ? mergeById(cached, incoming, 'id') : incoming;
                const pending = (state.funil || []).filter((f) => f._pending);
                if (pending.length) { merged = [...pending, ...merged]; }
                saveCache(cacheKey, merged);
                if (typeof r.serverNow === 'number') { setSyncTimestamp(cacheKey, r.serverNow); }
                state.funilScope = r.scope || 'all';
                return { status: 'success', funil: merged, scope: r.scope || 'all' };
            }
            return r;
        })
        .catch(function(e) { return { status: 'error', message: e.message }; });
    if (cached && Array.isArray(cached) && cached.length > 0) {
        showRefreshIndicator();
        fresh.then(function(r) {
            hideRefreshIndicator();
            if (r.status === 'success' && state.currentPage === 'funil') {
                state.funil = r.funil || [];
                const el = document.getElementById('main-content');
                if (el) { fillFunilContent(el, state.funil); }
            }
        });
        return { status: 'success', funil: cached, scope: dias === 0 ? 'all' : dias + 'd' };
    }
    return fresh;
}


export async function getFunilById(id) {
    const existing = state.funil.find(f => String(f.id) === String(id));
    if (existing) return { status: 'success', funil: existing };
    try {
        return await callAPI('getFunilById', { id, user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


