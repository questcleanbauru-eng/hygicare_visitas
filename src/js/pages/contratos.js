import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, attemptOrQueue } from '../api.js';
import { escapeHtml, isAdminOrGerenteUser, normalizeContrato, formatInputDateFromDisplay, contratoSituacaoIcon, filterLabelHtml } from '../utils/format.js';
import {
    debounce, initializeSearchableInput, renderDetailRow, actionIcon, showToast,
    loadingState, skeletonDetail, addScrollTop, openExternal, setSaving
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, ensureStyles } from '../utils/ui.js';

// "anexo" só conta se for um link http(s) de verdade — contratos antigos
// têm texto/rabisco no campo que não abre nada.
function anexoUrl(c) {
    const v = String((c && c.anexo) || '').trim();
    return /^https?:\/\//i.test(v) ? v : '';
}

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
    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const availableCities = Array.from(new Set(normalized.map((c) => c.cidade).filter(Boolean))).sort();
    const availableVendors = Array.from(new Set(normalized.map((c) => c.vendedor).filter(Boolean))).sort();

    // Edição rápida (só admin, só desktop): lista à esquerda + form completo
    // do contrato à direita, na mesma tela.
    let quickEdit = isAdmin && (() => { try { return localStorage.getItem('contratos_quick_edit') === '1'; } catch (e) { return false; } })();
    let qeSelectedId = null;
    const qeActive = () => quickEdit && isAdmin && window.innerWidth >= 1024;

    mainContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Contratos</h2>
                <p class="page-subtitle">Contratos ativos e vencimentos</p>
            </div>
            <div class="page-header-actions">
                ${isAdmin ? `<button type="button" class="mini-button qe-toggle${quickEdit ? ' is-on' : ''}" id="ct-qe-toggle" title="Editar na mesma tela, um contrato após o outro">⚡ Edição rápida</button>` : ''}
                <button class="btn-add" id="btn-new-contrato" type="button" ${state.canCreateProposalFunil ? '' : 'disabled title="Peça ao administrador para liberar a criação de contratos."'}>+ Novo</button>
            </div>
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

        if (normalized.length === 0) {
            container.innerHTML = `<div class="empty-state">
                <span class="empty-state-icon">📑</span>
                <p>Nenhum contrato cadastrado ainda.</p>
                <button type="button" class="btn-add" id="btn-new-contrato2" ${state.canCreateProposalFunil ? '' : 'disabled title="Peça ao administrador para liberar a criação de contratos."'}>+ Novo Contrato</button>
            </div>`;
            document.getElementById('btn-new-contrato2')?.addEventListener('click', () => navigateTo('contrato-new'));
            return;
        }

        if (filtered.length === 0) {
            container.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhum contrato para os filtros selecionados.</p></div>`;
            return;
        }

        const sorted = [...filtered].sort((a, b) => (a.diasRestantes ?? 999999) - (b.diasRestantes ?? 999999));
        const qe = qeActive();

        const cardsHtml = sorted.map((c) => `
            <button type="button" class="proposal-card ${c.vencido ? 'proposal-card-alert' : ''}${qe && String(c.id) === String(qeSelectedId) ? ' qe-selected' : ''}" data-contrato-id="${escapeHtml(c.id)}">
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
                <div class="proposal-meta ct-anexo-row">
                    <span class="ct-anexo-flag ${anexoUrl(c) ? 'ct-anexo-ok' : 'ct-anexo-missing'}">${anexoUrl(c) ? '📎 Contrato anexado' : '⚠️ Falta anexar o contrato'}</span>
                    ${anexoUrl(c) ? `<span class="ct-anexo-view" role="button" tabindex="0" data-anexo="${escapeHtml(anexoUrl(c))}">Ver PDF</span>` : ''}
                </div>
            </button>
        `).join('');

        if (qe) {
            container.classList.add('qe-layout');
            container.innerHTML = `<div class="qe-list">${cardsHtml}</div>`
                + `<div class="qe-panel" id="qe-panel"><p class="qe-empty">Escolha um contrato na lista pra editar aqui.</p></div>`;
            if (qeSelectedId && sorted.some((c) => String(c.id) === String(qeSelectedId))) {
                openContratoQuickPanel(qeSelectedId);
            }
        } else {
            container.classList.remove('qe-layout');
            container.innerHTML = `<div class="visits-list">${cardsHtml}</div>`;
        }

        container.querySelectorAll('[data-contrato-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (qeActive()) {
                    qeSelectedId = btn.dataset.contratoId;
                    container.querySelectorAll('.proposal-card').forEach((el) => el.classList.toggle('qe-selected', el === btn));
                    openContratoQuickPanel(qeSelectedId);
                } else {
                    navigateTo('contrato-detail', { id: btn.dataset.contratoId });
                }
            });
        });
        container.querySelectorAll('[data-anexo]').forEach((el) => {
            const open = (e) => { e.stopPropagation(); openExternal(el.dataset.anexo); };
            el.addEventListener('click', open);
            el.addEventListener('mousedown', (e) => e.stopPropagation());
            el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
        });
    };

    // ── Painel de edição rápida: form completo do contrato à direita ──────
    async function openContratoQuickPanel(id) {
        const panel = document.getElementById('qe-panel');
        if (!panel) return;
        const c = normalized.find((x) => String(x.id) === String(id));
        if (!c) { panel.innerHTML = '<p class="qe-empty">Contrato não encontrado.</p>'; return; }
        panel.innerHTML = '<p class="qe-empty">Carregando…</p>';

        const fd = state.formData || (await ensureFormData().then((r) => r.data).catch(() => null));
        if (String(qeSelectedId) !== String(id) || document.getElementById('qe-panel') !== panel) return;
        const cidades = (fd && fd.cidades) || [];

        panel.innerHTML = `
            <div class="qe-panel-inner">
            <form id="qe-ct-form" class="form-layout">
                <div class="form-group full-width">
                    <label for="qe-ct-cliente">Cliente *</label>
                    <input type="text" id="qe-ct-cliente" value="${escapeHtml(c.cliente || '')}" placeholder="Nome do cliente" required>
                </div>
                <div class="form-group">
                    <label for="qe-ct-cidade">Cidade</label>
                    <div class="searchable-select">
                        <input type="text" id="qe-ct-cidade" value="${escapeHtml(c.cidade || '')}" placeholder="Pesquise a cidade" autocomplete="off">
                        <div class="searchable-select-menu" id="qe-ct-cidade-menu"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="qe-ct-vendedor">Vendedor</label>
                    <input type="text" id="qe-ct-vendedor" value="${escapeHtml(c.vendedor || '')}" ${isAdmGer ? '' : 'readonly'}>
                </div>
                <div class="form-row-pair full-width">
                    <div class="form-group">
                        <label for="qe-ct-inicio">Início</label>
                        <input type="date" id="qe-ct-inicio" value="${c.inicio ? formatInputDateFromDisplay(c.inicio) : ''}">
                    </div>
                    <div class="form-group">
                        <label for="qe-ct-fim">Fim</label>
                        <input type="date" id="qe-ct-fim" value="${c.fim ? formatInputDateFromDisplay(c.fim) : ''}">
                    </div>
                </div>
                <div class="form-group full-width">
                    <label>Ativo</label>
                    <div class="radio-group">
                        <label class="radio-pill"><input type="radio" name="qe-ct-ativo" value="Sim" ${c.ativo === 'Sim' ? 'checked' : ''}><span>Sim</span></label>
                        <label class="radio-pill"><input type="radio" name="qe-ct-ativo" value="Nao" ${c.ativo !== 'Sim' ? 'checked' : ''}><span>Não</span></label>
                    </div>
                </div>
                <div class="form-group full-width">
                    <label>Assinado</label>
                    <div class="radio-group">
                        <label class="radio-pill"><input type="radio" name="qe-ct-assinado" value="Sim" ${c.assinado === 'Sim' ? 'checked' : ''}><span>Sim</span></label>
                        <label class="radio-pill"><input type="radio" name="qe-ct-assinado" value="Nao" ${c.assinado !== 'Sim' ? 'checked' : ''}><span>Não</span></label>
                    </div>
                </div>
                <div class="form-group full-width">
                    <label>Enviar aviso de vencimento</label>
                    <div class="radio-group">
                        <label class="radio-pill"><input type="radio" name="qe-ct-aviso" value="Sim" ${/^n/i.test(String(c.enviarAviso || 'Sim')) ? '' : 'checked'}><span>Sim</span></label>
                        <label class="radio-pill"><input type="radio" name="qe-ct-aviso" value="Nao" ${/^n/i.test(String(c.enviarAviso || 'Sim')) ? 'checked' : ''}><span>Não</span></label>
                    </div>
                </div>
                <div class="form-group full-width">
                    <label for="qe-ct-obs">Observações</label>
                    <textarea id="qe-ct-obs" rows="3">${escapeHtml(c.obs || '')}</textarea>
                </div>
                <div class="form-group full-width">
                    <label>PDF do contrato</label>
                    <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
                        <label class="mini-button" for="qe-ct-anexo-file" style="cursor:pointer">📎 Enviar PDF</label>
                        <input type="file" id="qe-ct-anexo-file" accept="application/pdf" hidden>
                        <span id="qe-ct-anexo-status" class="helper-text">${anexoUrl(c) ? '✅ PDF anexado' : 'Nenhum PDF ainda'}</span>
                        ${anexoUrl(c) ? '<button type="button" class="mini-button" id="qe-ct-anexo-open">Ver</button>' : ''}
                    </div>
                    <input type="url" id="qe-ct-anexo" value="${escapeHtml(c.anexo || '')}" placeholder="…ou cole aqui um link do Drive" style="margin-top:0.4rem">
                </div>
                <div class="form-actions full-width">
                    <button type="submit" class="primary-button" id="qe-ct-save">Salvar contrato</button>
                </div>
            </form>
            </div>`;

        initializeSearchableInput({ input: document.getElementById('qe-ct-cidade'), menu: document.getElementById('qe-ct-cidade-menu'), items: cidades, allowFreeText: true });

        const anexoInput = document.getElementById('qe-ct-anexo');
        const anexoStatus = document.getElementById('qe-ct-anexo-status');
        document.getElementById('qe-ct-anexo-open')?.addEventListener('click', () => {
            if (anexoInput.value.trim()) openExternal(anexoInput.value.trim());
        });
        document.getElementById('qe-ct-anexo-file').addEventListener('change', async (ev) => {
            const file = ev.target.files && ev.target.files[0];
            ev.target.value = '';
            if (!file) return;
            if (file.type !== 'application/pdf') { showToast('Selecione um arquivo PDF.', true); return; }
            if (file.size > 4 * 1024 * 1024) { showToast('PDF muito grande (máx. ~4 MB).', true); return; }
            anexoStatus.textContent = 'Enviando PDF...';
            try {
                const dataUrl = await new Promise((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(fr.result);
                    fr.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
                    fr.readAsDataURL(file);
                });
                const r = await callAPI('uploadContratoPdf', { pdf: dataUrl, cliente: document.getElementById('qe-ct-cliente').value.trim(), user: state.currentUser });
                if (r && r.status === 'success' && r.anexo) { anexoInput.value = r.anexo; anexoStatus.textContent = '✅ PDF anexado'; }
                else { anexoStatus.textContent = 'Nenhum PDF ainda'; showToast((r && r.message) || 'Não foi possível enviar o PDF.', true); }
            } catch (e) { anexoStatus.textContent = 'Nenhum PDF ainda'; showToast(e.message || 'Falha ao enviar o PDF.', true); }
        });

        document.getElementById('qe-ct-form').addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const btn = document.getElementById('qe-ct-save');
            const payload = {
                id: c.id,
                cliente: document.getElementById('qe-ct-cliente').value.trim(),
                cidade: document.getElementById('qe-ct-cidade').value.trim(),
                vendedor: document.getElementById('qe-ct-vendedor').value.trim(),
                inicio: document.getElementById('qe-ct-inicio').value || '',
                fim: document.getElementById('qe-ct-fim').value || '',
                ativo: document.querySelector('input[name="qe-ct-ativo"]:checked')?.value || 'Sim',
                assinado: document.querySelector('input[name="qe-ct-assinado"]:checked')?.value || 'Nao',
                enviarAviso: document.querySelector('input[name="qe-ct-aviso"]:checked')?.value || 'Sim',
                obs: document.getElementById('qe-ct-obs').value.trim(),
                anexo: document.getElementById('qe-ct-anexo').value.trim(),
                user: state.currentUser
            };
            if (!payload.cliente) { showToast('Informe o cliente.', true); return; }
            setSaving(true, btn, 'Salvando...');
            try {
                const r = await attemptOrQueue('updateContrato', payload, { entity: 'contratos', tempId: String(c.id) });
                if (r && (r.status === 'success' || r.status === 'queued')) {
                    saveCache('contratos', null);
                    const idx = (state.contratos || []).findIndex((x) => String(x.id || x.Id) === String(c.id));
                    if (idx >= 0 && r.contrato) state.contratos[idx] = r.contrato;
                    showToast(r.status === 'queued' ? 'Sem conexão — será enviado depois.' : 'Contrato atualizado.');
                    getContratos().then((rr) => {
                        if (rr.status === 'success' && state.currentPage === 'contratos') {
                            state.contratos = rr.contratos || [];
                            fillContratosContent(document.getElementById('main-content'), state.contratos);
                        }
                    });
                } else {
                    showToast((r && r.message) || 'Não foi possível salvar.', true);
                    setSaving(false, btn);
                }
            } catch (e) {
                showToast('Erro ao salvar. Tente de novo.', true);
                setSaving(false, btn);
            }
        });
    }

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

    document.getElementById('ct-qe-toggle')?.addEventListener('click', (e) => {
        quickEdit = !quickEdit;
        try { localStorage.setItem('contratos_quick_edit', quickEdit ? '1' : '0'); } catch (err) {}
        e.currentTarget.classList.toggle('is-on', quickEdit);
        qeSelectedId = null;
        renderFiltered();
        const goingOn = quickEdit;
        requestAnimationFrame(() => {
            if (goingOn) {
                document.getElementById('contratos-list-container')?.scrollIntoView({ block: 'start', behavior: 'auto' });
            } else {
                document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'auto' });
                window.scrollTo({ top: 0, behavior: 'auto' });
            }
        });
    });

    renderFiltered();
}


export async function renderContratosPage() {
    ensureStyles('proposals');
    // Edição rápida sempre começa desligada — o usuário liga clicando.
    try { localStorage.removeItem('contratos_quick_edit'); } catch (e) {}
    const mainContent = document.getElementById('main-content');
    const cached = loadCache('contratos');
    if (cached) {
        state.contratos = cached;
        fillContratosContent(mainContent, state.contratos);
        addScrollTop();
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
    addScrollTop();
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
    // A lista deixa um botão de "voltar ao topo" pra trás (só o próprio
    // addScrollTop remove o anterior, e essa página não chama de novo).
    document.getElementById('page-scroll-top')?.remove();
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
            <div class="header-actions-group">
                ${contrato.cliente ? `<button type="button" class="mini-button mini-button-icon" id="contrato-c360" aria-label="Cliente 360°" title="Ver histórico completo do cliente">${actionIcon('user')}</button>` : ''}
                <button type="button" class="mini-button" id="edit-contrato">Editar</button>
                ${anexoUrl(contrato) ? `<button type="button" class="mini-button mini-button-icon mini-button-whatsapp" id="ver-anexo-contrato" aria-label="Ver PDF do contrato" title="Ver PDF do contrato">${actionIcon('file')}</button>` : ''}
                ${state.canDelete ? `<button type="button" class="mini-button mini-button-icon mini-button-danger" id="delete-contrato" aria-label="Apagar" title="Apagar">${actionIcon('trash')}</button>` : ''}
            </div>
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
            <div class="detail-row">
                <span class="detail-label">PDF do contrato</span>
                <span class="detail-value">
                    ${anexoUrl(contrato)
                        ? '<button type="button" class="mini-button" id="ver-contrato-pdf">📎 Ver contrato</button>'
                        : '<strong class="ct-anexo-missing">⚠️ Falta anexar</strong>'}
                </span>
            </div>
            ${renderDetailRow('Obs', contrato.obs || '-')}
        </div>
    `;

    document.getElementById('back-contratos').addEventListener('click', () => navigateTo('contratos'));
    document.getElementById('contrato-c360')?.addEventListener('click', () => navigateTo('cliente-360', { cliente: contrato.cliente }));
    document.getElementById('edit-contrato').addEventListener('click', () => navigateTo('contrato-edit', { contrato }));
    document.getElementById('ver-anexo-contrato')?.addEventListener('click', () => openExternal(anexoUrl(contrato)));
    document.getElementById('ver-contrato-pdf')?.addEventListener('click', () => openExternal(anexoUrl(contrato)));
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
                <label for="ctf-anexo">PDF do contrato</label>
                <div class="ctf-anexo-row" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
                    <label class="mini-button ctf-anexo-upload" for="ctf-anexo-file" style="cursor:pointer">📎 Enviar PDF</label>
                    <input type="file" id="ctf-anexo-file" accept="application/pdf" hidden>
                    <span id="ctf-anexo-status" class="helper-text">${anexoUrl(normalized) ? '✅ PDF anexado' : 'Nenhum PDF ainda'}</span>
                    ${anexoUrl(normalized) ? '<button type="button" class="mini-button" id="ctf-anexo-open">Ver</button>' : ''}
                </div>
                <input type="url" id="ctf-anexo" value="${escapeHtml(normalized.anexo || '')}" placeholder="…ou cole aqui um link do Drive" style="margin-top:0.4rem">
                <p class="helper-text" style="margin-top:0.35rem">O PDF vai pra pasta "Contratos App" no Drive e pode ser consultado pelo app.</p>
            </div>
            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-contrato-form">Cancelar</button>
                <button type="submit" id="save-contrato-form">${isEdit ? 'Salvar Alterações' : 'Salvar Contrato'}</button>
            </div>
        </form>
    `;

    initializeSearchableInput({ input: document.getElementById('ctf-cidade'), menu: document.getElementById('ctf-cidade-menu'), items: cidades });
    document.getElementById('cancel-contrato-form').addEventListener('click', () => navigateTo(isEdit ? 'contrato-detail' : 'contratos', { id: normalized.id }));

    // Upload do PDF pro Drive (pasta "Contratos App") — preenche o campo anexo.
    const anexoFile = document.getElementById('ctf-anexo-file');
    const anexoInput = document.getElementById('ctf-anexo');
    const anexoStatus = document.getElementById('ctf-anexo-status');
    document.getElementById('ctf-anexo-open')?.addEventListener('click', () => {
        if (anexoInput.value.trim()) openExternal(anexoInput.value.trim());
    });
    anexoFile?.addEventListener('change', async () => {
        const file = anexoFile.files && anexoFile.files[0];
        anexoFile.value = '';
        if (!file) return;
        if (file.type !== 'application/pdf') { showToast('Selecione um arquivo PDF.', true); return; }
        if (file.size > 4 * 1024 * 1024) { showToast('PDF muito grande (máx. ~4 MB). Comprima o arquivo e tente de novo.', true); return; }
        anexoStatus.textContent = 'Enviando PDF...';
        try {
            const dataUrl = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
                fr.readAsDataURL(file);
            });
            const r = await callAPI('uploadContratoPdf', {
                pdf: dataUrl,
                cliente: document.getElementById('ctf-cliente').value.trim(),
                user: state.currentUser
            });
            if (r && r.status === 'success' && r.anexo) {
                anexoInput.value = r.anexo;
                anexoStatus.textContent = '✅ PDF anexado';
            } else {
                anexoStatus.textContent = 'Nenhum PDF ainda';
                showToast((r && r.message) || 'Não foi possível enviar o PDF.', true);
            }
        } catch (e) {
            anexoStatus.textContent = 'Nenhum PDF ainda';
            showToast(e.message || 'Falha ao enviar o PDF.', true);
        }
    });

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

        try {
            const result = await attemptOrQueue(isEdit ? 'updateContrato' : 'createContrato', payload,
                { entity: 'contratos', tempId: String(payload.id || Date.now()) });
            if (result && result.status === 'success') {
                saveCache('contratos', null);
                state.contratos = [];
                showToast(isEdit ? 'Contrato atualizado.' : 'Contrato criado com sucesso.');
                navigateTo('contrato-detail', { id: result.contrato.id });
            } else if (result && result.status === 'queued') {
                saveCache('contratos', null);
                state.contratos = [];
                showToast('Sem conexão — o contrato foi salvo no aparelho e será enviado quando a conexão voltar.');
                navigateTo('contratos');
            } else {
                showToast((result && result.message) || 'Erro ao salvar contrato.', true);
                setSaving(false, btn);
            }
        } catch (error) {
            showToast('Erro ao salvar contrato. Tente novamente.', true);
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
