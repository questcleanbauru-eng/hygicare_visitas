import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData } from '../api.js';
import { escapeHtml, isAdminOrGerenteUser, normalizeContrato, formatInputDateFromDisplay, contratoSituacaoIcon, filterLabelHtml } from '../utils/format.js';
import {
    debounce, initializeSearchableInput, renderDetailRow, showToast,
    loadingState, skeletonDetail, addFabAndScrollTop, openExternal, setSaving
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, ensureStyles } from '../utils/ui.js';

function situacaoLabel(c) {
    if (c.vencido) return 'Vencido';
    if (c.venceEmBreve) return 'Vence em breve';
    return 'Ativo';
}

function situacaoClass(c) {
    if (c.vencido) return 'status-pill funil-status-perdido';
    if (c.venceEmBreve) return 'status-pill funil-status-proposta';
    return 'status-pill funil-status-concluido';
}

export function fillContratosContent(mainContent, contratos) {
    const normalized = (contratos || []).map(normalizeContrato);
    const isAdmGer = isAdminOrGerenteUser();
    const availableCities = Array.from(new Set(normalized.map((c) => c.cidade).filter(Boolean))).sort();
    const availableVendors = Array.from(new Set(normalized.map((c) => c.vendedor).filter(Boolean))).sort();

    mainContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Contratos</h2>
                <p class="page-subtitle">Contratos ativos e vencimentos</p>
            </div>
            <button class="btn-add" id="btn-new-contrato" type="button" ${state.canCreateProposalFunil ? '' : 'disabled title="Peça ao administrador para liberar a criação de contratos."'}>+ Novo</button>
        </div>
        <div class="search-bar-wrapper">
            <div class="search-bar-input-group">
                <span class="search-bar-icon">🔍</span>
                <input type="text" id="ct-search" placeholder="Buscar cliente, cidade ou vendedor..." class="form-input">
            </div>
        </div>
        <div class="card visits-filter-card">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    <button type="button" class="mini-button" id="ct-filter-clear">Limpar</button>
                    <button type="button" class="mini-button" id="ct-filter-toggle">Ocultar</button>
                </div>
            </div>
            <div class="visits-filter-grid" id="ct-filter-panel">
                <div class="form-group">
                    <label for="ct-situacao">${filterLabelHtml('Situação')}</label>
                    <select id="ct-situacao">
                        <option value="">Todas</option>
                        <option value="vence-breve">Vence em breve</option>
                        <option value="vencido">Vencido</option>
                        <option value="ativo">Ativo</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="ct-cidade">${filterLabelHtml('Cidade')}</label>
                    <div class="searchable-select">
                        <input type="text" id="ct-cidade" placeholder="Todas" autocomplete="off">
                        <div class="searchable-select-menu" id="ct-cidade-menu"></div>
                    </div>
                </div>
                ${isAdmGer ? `
                <div class="form-group">
                    <label for="ct-vendor">${filterLabelHtml('Vendedor')}</label>
                    <div class="searchable-select">
                        <input type="text" id="ct-vendor" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="ct-vendor-menu"></div>
                    </div>
                </div>` : ''}
            </div>
        </div>
        <div id="contratos-list-container"></div>
    `;

    const filterToggle = document.getElementById('ct-filter-toggle');
    const filterPanel = document.getElementById('ct-filter-panel');
    const isMobile = window.matchMedia('(max-width: 640px)').matches;
    let collapsed = isMobile;
    filterPanel.classList.toggle('collapsed', collapsed);
    filterToggle.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    filterToggle.addEventListener('click', () => {
        collapsed = !collapsed;
        filterPanel.classList.toggle('collapsed', collapsed);
        filterToggle.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    });

    const renderFiltered = () => {
        const search   = document.getElementById('ct-search')?.value.trim().toLowerCase() || '';
        const situacao = document.getElementById('ct-situacao')?.value || '';
        const cidade   = document.getElementById('ct-cidade')?.value || '';
        const vendor   = document.getElementById('ct-vendor')?.value || '';

        const filtered = normalized.filter((c) => {
            const matchSearch = !search || [c.cliente, c.cidade, c.vendedor].some((v) => String(v || '').toLowerCase().includes(search));
            const matchCidade = !cidade || c.cidade === cidade;
            const matchVendor = !vendor || c.vendedor === vendor;
            const matchSituacao = !situacao
                || (situacao === 'vencido' && c.vencido)
                || (situacao === 'vence-breve' && c.venceEmBreve)
                || (situacao === 'ativo' && !c.vencido && !c.venceEmBreve);
            return matchSearch && matchCidade && matchVendor && matchSituacao;
        });

        const container = document.getElementById('contratos-list-container');
        if (!container) return;

        if (filtered.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>Nenhum contrato encontrado.</p></div>`;
            return;
        }

        const sorted = [...filtered].sort((a, b) => (a.diasRestantes ?? 999999) - (b.diasRestantes ?? 999999));

        container.innerHTML = `<div class="visits-list">${sorted.map((c) => `
            <button type="button" class="proposal-card ${c.vencido ? 'proposal-card-alert' : ''}" data-contrato-id="${escapeHtml(c.id)}">
                <div class="visit-card-header">
                    <strong><span aria-hidden="true">${contratoSituacaoIcon(c)}</span> ${escapeHtml(c.cliente || 'Cliente não informado')}</strong>
                    <span class="${situacaoClass(c)}">${situacaoLabel(c)}</span>
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(c.vendedor || '-')}</span>
                    <span>${escapeHtml(c.cidade || '-')}</span>
                </div>
                <div class="proposal-meta">
                    <span>Fim: ${escapeHtml(c.fim || '-')}</span>
                    <span>${c.diasRestantes === null ? '' : (c.diasRestantes >= 0 ? `${c.diasRestantes} dia(s) restante(s)` : `Vencido há ${Math.abs(c.diasRestantes)} dia(s)`)}</span>
                </div>
            </button>
        `).join('')}</div>`;

        container.querySelectorAll('[data-contrato-id]').forEach((btn) => {
            btn.addEventListener('click', () => navigateTo('contrato-detail', { id: btn.dataset.contratoId }));
        });
    };

    initializeSearchableInput({ input: document.getElementById('ct-cidade'), menu: document.getElementById('ct-cidade-menu'), items: availableCities });
    if (isAdmGer) {
        initializeSearchableInput({ input: document.getElementById('ct-vendor'), menu: document.getElementById('ct-vendor-menu'), items: availableVendors });
    }

    const _ctFilterIds = ['ct-search', 'ct-situacao', 'ct-cidade', 'ct-vendor'];
    const _ctTextFilterIds = new Set(['ct-search', 'ct-cidade', 'ct-vendor']);
    const _debouncedFilter = debounce(renderFiltered, 250);
    _ctFilterIds.forEach((id) => {
        const el = document.getElementById(id);
        const isText = _ctTextFilterIds.has(id);
        el?.addEventListener(isText ? 'input' : 'change', isText ? _debouncedFilter : renderFiltered);
    });

    document.getElementById('ct-filter-clear')?.addEventListener('click', () => {
        _ctFilterIds.forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; } });
        renderFiltered();
    });

    document.getElementById('btn-new-contrato')?.addEventListener('click', () => navigateTo('contrato-new'));

    renderFiltered();
}


export async function renderContratosPage() {
    ensureStyles('proposals');
    const mainContent = document.getElementById('main-content');
    const cached = loadCache('contratos');
    if (cached) {
        state.contratos = cached;
        fillContratosContent(mainContent, state.contratos);
        addFabAndScrollTop('Novo Contrato', () => {
            if (state.canCreateProposalFunil) { navigateTo('contrato-new'); }
            else { showToast('Peça ao administrador para liberar a criação de contratos.', true); }
        });
        initPullToRefresh(async () => {
            const r = await getContratos();
            if (r.status === 'success' && state.currentPage === 'contratos') {
                state.contratos = r.contratos || [];
                const el = document.getElementById('main-content');
                if (el) { fillContratosContent(el, state.contratos); }
            }
        });
        getContratos().then((r) => {
            if (r.status === 'success' && state.currentPage === 'contratos') {
                state.contratos = r.contratos || [];
                fillContratosContent(document.getElementById('main-content'), state.contratos);
            }
        });
        return;
    }
    mainContent.innerHTML = loadingState('📑', 'Carregando contratos...');
    const result = await getContratos();
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar contratos.')}</p>`;
        return;
    }
    state.contratos = result.contratos || [];
    fillContratosContent(mainContent, state.contratos);
    addFabAndScrollTop('Novo Contrato', () => {
        if (state.canCreateProposalFunil) { navigateTo('contrato-new'); }
        else { showToast('Peça ao administrador para liberar a criação de contratos.', true); }
    });
    initPullToRefresh(async () => {
            const r = await getContratos();
            if (r.status === 'success' && state.currentPage === 'contratos') {
                state.contratos = r.contratos || [];
                const el = document.getElementById('main-content');
                if (el) { fillContratosContent(el, state.contratos); }
            }
        });
}


export async function renderContratoDetailPage(id) {
    ensureStyles('proposals');
    const mainContent = document.getElementById('main-content');
    if (!(state.contratos || []).find((c) => String(c.Id || c.id) === String(id))) {
        mainContent.innerHTML = skeletonDetail(9);
    }

    const result = await getContratoById(id);
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Contrato não encontrado.')}</p>`;
        return;
    }

    const contrato = normalizeContrato(result.contrato);
    state.currentContrato = contrato;

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Contratos', page: 'contratos' }, { label: contrato.cliente || 'Contrato' }])}
        <div class="page-header compact-header">
            <button type="button" id="back-contratos" style="background:none;border:none;color:#64748B;font-size:0.87rem;cursor:pointer;display:flex;align-items:center;gap:0.3rem;padding:0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15,18 9,12 15,6"/></svg>
                Voltar
            </button>
            <h2>Detalhes do Contrato</h2>
            <button type="button" class="mini-button" id="edit-contrato">Editar</button>
        </div>
        ${contrato.vencido ? `
        <div class="alert-banner">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Este contrato está vencido.
        </div>` : contrato.venceEmBreve ? `
        <div class="alert-banner">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Este contrato vence em ${contrato.diasRestantes} dia(s).
        </div>` : ''}
        <div class="card detail-card">
            ${renderDetailRow('ID', contrato.id)}
            ${renderDetailRow('Cliente', contrato.cliente)}
            ${renderDetailRow('Vendedor', contrato.vendedor)}
            ${renderDetailRow('Cidade', contrato.cidade)}
            ${renderDetailRow('Ativo', contrato.ativo)}
            ${renderDetailRow('Assinado', contrato.assinado)}
            ${renderDetailRow('Início', contrato.inicio || '-')}
            ${renderDetailRow('Fim', contrato.fim || '-')}
            ${renderDetailRow('Enviar Aviso de vencimento', contrato.enviarAviso)}
            ${renderDetailRow('Obs', contrato.obs || '-')}
        </div>
        ${contrato.anexo ? `
        <div class="sticky-action-bar">
            <button type="button" id="ver-anexo-contrato" class="proposal-action-whatsapp">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                Ver PDF do contrato
            </button>
        </div>` : ''}
        ${state.canDelete ? `<div style="margin-top:0.75rem"><button type="button" class="danger-button" id="delete-contrato">Apagar</button></div>` : ''}
    `;

    document.getElementById('back-contratos').addEventListener('click', () => navigateTo('contratos'));
    document.getElementById('edit-contrato').addEventListener('click', () => navigateTo('contrato-edit', { contrato }));
    document.getElementById('ver-anexo-contrato')?.addEventListener('click', () => openExternal(contrato.anexo));
    document.getElementById('delete-contrato')?.addEventListener('click', async (event) => {
        if (!confirm(`Apagar o contrato de "${contrato.cliente || 'cliente'}"? Essa ação não pode ser desfeita.`)) return;
        const btn = event.currentTarget;
        setSaving(true, btn, 'Apagando...');
        const result = await callAPI('deleteContrato', { id: contrato.id, user: state.currentUser });
        if (result && result.status === 'success') {
            state.contratos = (state.contratos || []).filter((c) => String(c.id) !== String(contrato.id));
            saveCache('contratos', state.contratos);
            showToast('Contrato apagado.');
            navigateTo('contratos');
        } else {
            showToast((result && result.message) || 'Não foi possível apagar o contrato.', true);
            setSaving(false, btn);
        }
    });
}


export async function renderContratoFormPage(contrato) {
    ensureStyles('proposals');
    const isEdit = !!contrato;
    const normalized = normalizeContrato(contrato || {});
    const isAdmGer = isAdminOrGerenteUser();
    const mainContent = document.getElementById('main-content');

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-contrato-form">Voltar</button>
            <h2>${isEdit ? 'Editar Contrato' : 'Novo Contrato'}</h2>
            <span></span>
        </div>
        <div class="card form-card" style="position:relative;min-height:120px" id="contrato-form-wrapper">
            <div class="form-loading-overlay">
                <div class="form-loading-spinner"></div>
                <span>Carregando formulário...</span>
            </div>
        </div>
    `;
    document.getElementById('back-contrato-form').addEventListener('click', () => navigateTo(isEdit ? 'contrato-detail' : 'contratos', { id: normalized.id }));

    const fdResult = await ensureFormData();
    const cidades = (fdResult.data && fdResult.data.cidades) || [];

    const wrapper = document.getElementById('contrato-form-wrapper');
    wrapper.innerHTML = `
        <form id="contrato-form" class="form-layout">
            <div class="form-group full-width">
                <label for="ctf-cliente">Cliente *</label>
                <input type="text" id="ctf-cliente" value="${escapeHtml(normalized.cliente)}" placeholder="Nome do cliente" required>
            </div>
            <div class="form-group">
                <label for="ctf-cidade">Cidade</label>
                <div class="searchable-select">
                    <input type="text" id="ctf-cidade" value="${escapeHtml(normalized.cidade)}" placeholder="Pesquise a cidade" autocomplete="off">
                    <div class="searchable-select-menu" id="ctf-cidade-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="ctf-vendedor">Vendedor</label>
                <input type="text" id="ctf-vendedor" value="${escapeHtml(normalized.vendedor || state.currentUser.name)}" ${isAdmGer ? '' : 'readonly'}>
            </div>
            <div class="form-row-pair full-width">
                <div class="form-group">
                    <label for="ctf-inicio">Início</label>
                    <input type="date" id="ctf-inicio" value="${normalized.inicio ? formatInputDateFromDisplay(normalized.inicio) : ''}">
                </div>
                <div class="form-group">
                    <label for="ctf-fim">Fim</label>
                    <input type="date" id="ctf-fim" value="${normalized.fim ? formatInputDateFromDisplay(normalized.fim) : ''}">
                </div>
            </div>
            <div class="form-group full-width">
                <label>Assinado</label>
                <div class="radio-group">
                    <label class="radio-pill"><input type="radio" name="ctf-assinado" value="Sim" ${normalized.assinado === 'Sim' ? 'checked' : ''}><span>Sim</span></label>
                    <label class="radio-pill"><input type="radio" name="ctf-assinado" value="Nao" ${normalized.assinado !== 'Sim' ? 'checked' : ''}><span>Não</span></label>
                </div>
            </div>
            ${isEdit ? `
            <div class="form-group full-width">
                <label>Ativo</label>
                <div class="radio-group">
                    <label class="radio-pill"><input type="radio" name="ctf-ativo" value="Sim" ${normalized.ativo === 'Sim' ? 'checked' : ''}><span>Sim</span></label>
                    <label class="radio-pill"><input type="radio" name="ctf-ativo" value="Nao" ${normalized.ativo !== 'Sim' ? 'checked' : ''}><span>Não</span></label>
                </div>
            </div>` : ''}
            <div class="form-group full-width">
                <label>Enviar aviso de vencimento</label>
                <div class="radio-group">
                    <label class="radio-pill"><input type="radio" name="ctf-aviso" value="Sim" ${normalized.enviarAviso !== 'Nao' ? 'checked' : ''}><span>Sim</span></label>
                    <label class="radio-pill"><input type="radio" name="ctf-aviso" value="Nao" ${normalized.enviarAviso === 'Nao' ? 'checked' : ''}><span>Não</span></label>
                </div>
            </div>
            <div class="form-group full-width">
                <label for="ctf-obs">Observações</label>
                <textarea id="ctf-obs" rows="4">${escapeHtml(normalized.obs || '')}</textarea>
            </div>
            <div class="form-group full-width">
                <label for="ctf-anexo">Anexo (link do Drive)</label>
                <input type="url" id="ctf-anexo" value="${escapeHtml(normalized.anexo || '')}" placeholder="Cole aqui o link compartilhável do PDF no Drive">
                <p class="helper-text" style="margin-top:0.35rem">Suba o PDF no seu Google Drive, copie o link "Qualquer pessoa com o link" e cole aqui.</p>
            </div>
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-contrato-form">Cancelar</button>
                <button type="submit" id="save-contrato-form">Salvar Contrato</button>
            </div>
        </form>
    `;

    initializeSearchableInput({ input: document.getElementById('ctf-cidade'), menu: document.getElementById('ctf-cidade-menu'), items: cidades });
    document.getElementById('cancel-contrato-form').addEventListener('click', () => navigateTo(isEdit ? 'contrato-detail' : 'contratos', { id: normalized.id }));

    document.getElementById('contrato-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const btn = document.getElementById('save-contrato-form');
        setSaving(true, btn, 'Salvando...');

        const payload = {
            cliente: document.getElementById('ctf-cliente').value.trim(),
            cidade: document.getElementById('ctf-cidade').value.trim(),
            vendedor: document.getElementById('ctf-vendedor').value.trim(),
            inicio: document.getElementById('ctf-inicio').value || '',
            fim: document.getElementById('ctf-fim').value || '',
            assinado: document.querySelector('input[name="ctf-assinado"]:checked')?.value || 'Nao',
            enviarAviso: document.querySelector('input[name="ctf-aviso"]:checked')?.value || 'Sim',
            obs: document.getElementById('ctf-obs').value.trim(),
            anexo: document.getElementById('ctf-anexo').value.trim(),
            user: state.currentUser
        };
        if (isEdit) {
            payload.id = normalized.id;
            payload.ativo = document.querySelector('input[name="ctf-ativo"]:checked')?.value || 'Sim';
        }

        const result = await callAPI(isEdit ? 'updateContrato' : 'createContrato', payload);
        if (result && result.status === 'success') {
            saveCache('contratos', null);
            state.contratos = [];
            showToast(isEdit ? 'Contrato atualizado.' : 'Contrato criado com sucesso.');
            navigateTo('contrato-detail', { id: result.contrato.id });
        } else {
            showToast((result && result.message) || 'Erro ao salvar contrato.', true);
            setSaving(false, btn);
        }
    });
}


export async function renderContratoCreatePage() {
    await renderContratoFormPage(null);
}


export async function getContratos() {
    try {
        const r = await callAPI('getContratos', { user: state.currentUser });
        if (r.status === 'success') { saveCache('contratos', r.contratos || []); }
        return r;
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export async function getContratoById(id) {
    try {
        return await callAPI('getContratoById', { id, user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}
