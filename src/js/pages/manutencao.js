import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, attemptOrQueue } from '../api.js';
import { escapeHtml, isAdminOrGerenteUser, normalizeManutencao, titleCase } from '../utils/format.js';
import {
    debounce, initializeSearchableInput, showToast,
    skeletonList, skeletonDetail, addScrollTop, setSaving, openExternal
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, ensureStyles } from '../utils/ui.js';

// O card da lista (.proposal-card/.proposal-meta) e o cabeçalho do card
// (.visit-card-header) vêm dos bundles de CSS de Propostas/Visitas, não de
// manutencao.css (que só tem estilo específico daqui, ex.: .mnt-report) —
// mesmo esquema que Contratos já usa (reaproveita o visual em vez de
// duplicar CSS). Sem isso, quem abre Manutenção sem ter passado antes por
// Propostas/Visitas na mesma sessão via os cards sem nenhum estilo (caixa
// cinza padrão do navegador).
function ensureManutencaoStyles() {
    ensureStyles('manutencao');
    ensureStyles('proposals');
    ensureStyles('visits');
}

function safeParseJson(value, fallback) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

export function fillManutencaoContent(mainContent, manutencoes) {
    const normalized = (manutencoes || []).map(normalizeManutencao);
    const isAdmGer = isAdminOrGerenteUser();

    if (normalized.length === 0) {
        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Manutenção</h2></div>
                <button type="button" class="btn-add" id="btn-new-manutencao">+ Novo Relatório</button>
            </div>
            <div class="empty-state">
                <span class="empty-state-icon">🔧</span>
                <p>Nenhum relatório de manutenção registrado ainda.</p>
                <button type="button" class="btn-add" id="btn-new-manutencao2">+ Novo Relatório</button>
            </div>
        `;
        document.getElementById('btn-new-manutencao')?.addEventListener('click', () => navigateTo('manutencao-new'));
        document.getElementById('btn-new-manutencao2')?.addEventListener('click', () => navigateTo('manutencao-new'));
        return;
    }

    const availableCidades = Array.from(new Set(normalized.map((m) => m.cidade).filter(Boolean))).sort();
    const availableTecnicos = isAdmGer
        ? Array.from(new Set(normalized.map((m) => m.tecnico).filter(Boolean))).sort()
        : [];

    mainContent.innerHTML = `
        <div class="page-header">
            <div><h2>Manutenção</h2><p class="page-subtitle">${normalized.length} relatório(s)</p></div>
            <button type="button" class="btn-add" id="btn-new-manutencao">+ Novo Relatório</button>
        </div>
        <div class="search-bar-wrapper">
            <div class="search-bar-input-group">
                <span class="search-bar-icon">🔍</span>
                <input type="text" id="mnt-search" placeholder="Buscar cliente, cidade ou técnico..." class="form-input">
            </div>
        </div>
        <div class="card visits-filter-card">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    <button type="button" class="mini-button" id="mnt-filter-clear">Limpar</button>
                    <button type="button" class="mini-button" id="mnt-filter-toggle">Ocultar</button>
                </div>
            </div>
            <div class="visits-filter-grid" id="mnt-filter-panel">
                <div class="form-group">
                    <label for="mnt-cidade">Cidade</label>
                    <div class="searchable-select">
                        <input type="text" id="mnt-cidade" placeholder="Todas" autocomplete="off">
                        <div class="searchable-select-menu" id="mnt-cidade-menu"></div>
                    </div>
                </div>
                ${isAdmGer ? `
                <div class="form-group">
                    <label for="mnt-tecnico">Técnico</label>
                    <div class="searchable-select">
                        <input type="text" id="mnt-tecnico" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="mnt-tecnico-menu"></div>
                    </div>
                </div>` : ''}
            </div>
        </div>
        <div id="manutencao-list-container"></div>
    `;

    const filterPanel  = document.getElementById('mnt-filter-panel');
    const filterToggle = document.getElementById('mnt-filter-toggle');
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
        const search  = document.getElementById('mnt-search')?.value.trim().toLowerCase() || '';
        const cidade  = document.getElementById('mnt-cidade')?.value || '';
        const tecnico = document.getElementById('mnt-tecnico')?.value || '';

        const filtered = normalized.filter((m) => {
            const matchSearch  = !search || [m.cliente, m.cidade, m.tecnico].some((v) => String(v || '').toLowerCase().includes(search));
            const matchCidade  = !cidade || m.cidade === cidade;
            const matchTecnico = !tecnico || m.tecnico === tecnico;
            return matchSearch && matchCidade && matchTecnico;
        });

        const container = document.getElementById('manutencao-list-container');
        if (!container) return;

        if (filtered.length === 0) {
            container.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhum relatório para os filtros selecionados.</p></div>`;
            return;
        }

        const sorted = [...filtered].sort((a, b) => Number(b.id) - Number(a.id));

        container.innerHTML = `<div class="visits-list">${sorted.map((m) => `
            <button type="button" class="proposal-card" data-manutencao-id="${escapeHtml(m.id)}">
                <div class="visit-card-header">
                    <strong><span aria-hidden="true">🔬</span> ${escapeHtml(m.cliente || 'Cliente não informado')}</strong>
                    ${m._pending ? '<span class="pending-badge" title="Aguardando conexão para enviar">⏳ Pendente</span>' : (m.pendenteAprovacao === 'Sim' ? '<span class="status-pill funil-status-proposta">Pendente de aprovação</span>' : '')}
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(m.cidade || '-')}</span>
                    <span>${escapeHtml(titleCase(m.tecnico) || '-')}</span>
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(m.data || '-')}</span>
                </div>
            </button>
        `).join('')}</div>`;

        container.querySelectorAll('[data-manutencao-id]').forEach((btn) => {
            btn.addEventListener('click', () => navigateTo('manutencao-detail', { id: btn.dataset.manutencaoId }));
        });
    };

    initializeSearchableInput({ input: document.getElementById('mnt-cidade'), menu: document.getElementById('mnt-cidade-menu'), items: availableCidades });
    if (isAdmGer) {
        initializeSearchableInput({ input: document.getElementById('mnt-tecnico'), menu: document.getElementById('mnt-tecnico-menu'), items: availableTecnicos });
    }

    const _filterIds = ['mnt-search', 'mnt-cidade', 'mnt-tecnico'];
    const _textFilterIds = new Set(['mnt-search', 'mnt-cidade', 'mnt-tecnico']);
    const _debouncedFilter = debounce(renderFiltered, 250);
    _filterIds.forEach((id) => {
        const isText = _textFilterIds.has(id);
        document.getElementById(id)?.addEventListener(isText ? 'input' : 'change', isText ? _debouncedFilter : renderFiltered);
    });
    document.getElementById('mnt-filter-clear')?.addEventListener('click', () => {
        _filterIds.forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
        renderFiltered();
    });

    document.getElementById('btn-new-manutencao')?.addEventListener('click', () => navigateTo('manutencao-new'));
    renderFiltered();
}

export async function renderManutencaoPage() {
    ensureManutencaoStyles();
    const mainContent = document.getElementById('main-content');
    const cachedRaw = loadCache('manutencoes');
    const cached = (Array.isArray(cachedRaw) && cachedRaw.length > 0) ? cachedRaw : null;
    if (cached) {
        state.manutencoes = cached;
        fillManutencaoContent(mainContent, state.manutencoes);
        addScrollTop();
        initPullToRefresh(async () => {
            const r = await getManutencoes();
            if (r.status === 'success' && state.currentPage === 'manutencao') {
                state.manutencoes = r.manutencoes || [];
                const el = document.getElementById('main-content');
                if (el) fillManutencaoContent(el, state.manutencoes);
            }
        });
        getManutencoes();
        return;
    }
    mainContent.innerHTML = skeletonList(5);
    const result = await getManutencoes();
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar relatórios de manutenção.')}</p>`;
        return;
    }
    state.manutencoes = result.manutencoes || [];
    fillManutencaoContent(mainContent, state.manutencoes);
    addScrollTop();
    initPullToRefresh(async () => {
        const r = await getManutencoes();
        if (r.status === 'success' && state.currentPage === 'manutencao') {
            state.manutencoes = r.manutencoes || [];
            const el = document.getElementById('main-content');
            if (el) fillManutencaoContent(el, state.manutencoes);
        }
    });
}

export async function renderManutencaoDetailPage(id) {
    ensureManutencaoStyles();
    const mainContent = document.getElementById('main-content');
    if (!state.manutencoes.find((m) => String(m.Id || m.id) === String(id))) {
        mainContent.innerHTML = skeletonDetail(10);
    }
    // A lista deixa um botão de "voltar ao topo" pra trás (só o próprio
    // addScrollTop remove o anterior, e essa página não chama de novo).
    document.getElementById('page-scroll-top')?.remove();

    const result = await getManutencaoById(id);
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Relatório não encontrado.')}</p>`;
        return;
    }

    const m = normalizeManutencao(result.manutencao);
    state.currentManutencao = m;
    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const jaAssinado = !!(m.assinaturaTecnico && m.assinaturaCliente);
    const itens = safeParseJson(m.itensTabela, []);

    let statusKey = 'nao-assinado';
    let statusLabel = 'Não assinado';
    if (m.pendenteAprovacao === 'Sim') { statusKey = 'pendente'; statusLabel = 'Pendente de aprovação'; }
    else if (jaAssinado) { statusKey = 'assinado'; statusLabel = 'Assinado'; }

    const afericaoRowsHtml = itens.length ? itens.map((i) => `
        <div class="mnt-afericao-row">
            <div class="mnt-field"><span class="mnt-field-label">Equipamento</span><span class="mnt-field-value">${escapeHtml(i.equipamento || '-')}</span></div>
            <div class="mnt-field"><span class="mnt-field-label">Produto</span><span class="mnt-field-value">${escapeHtml(i.produto || '-')}</span></div>
            <div class="mnt-field"><span class="mnt-field-label">Diluição</span><span class="mnt-field-value">${escapeHtml(i.diluicao || '-')}</span></div>
            <div class="mnt-field"><span class="mnt-field-label">Aferido</span><span class="mnt-field-value${i.aferido === 'Sim' ? ' mnt-aferido-sim' : ''}">${i.aferido === 'Sim' ? '✓ Sim' : escapeHtml(i.aferido || '-')}</span></div>
        </div>
    `).join('') : '<p class="helper-text" style="margin:0.75rem">Sem itens registrados.</p>';

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Manutenção', page: 'manutencao' }, { label: m.cliente || 'Relatório' }])}
        <div class="page-header compact-header no-print">
            <button type="button" class="mini-button" id="back-manutencao">Voltar</button>
            <h2>Detalhes do Relatório</h2>
            <div class="header-actions-group">
                <button type="button" class="mini-button" id="edit-manutencao">Editar</button>
                <button type="button" class="mini-button" id="print-manutencao" aria-label="Imprimir ou salvar em PDF" title="Imprimir ou salvar em PDF">📄 PDF</button>
                <button type="button" class="mini-button mini-button-whatsapp" id="share-manutencao-whatsapp" aria-label="Compartilhar no WhatsApp" title="Compartilhar no WhatsApp">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                </button>
                ${state.canDelete ? '<button type="button" class="mini-button mini-button-danger" id="delete-manutencao" aria-label="Apagar" title="Apagar">🗑️</button>' : ''}
            </div>
        </div>
        ${m.pendenteAprovacao === 'Sim' ? `
        <div class="alert-banner no-print">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span style="flex:1">Este relatório foi editado após ser assinado e está pendente de aprovação.</span>
            ${isAdmin ? '<button type="button" class="mini-button" id="approve-manutencao" style="margin-left:0.5rem">Aprovar</button>' : ''}
        </div>` : ''}
        <div class="mnt-report">
            <div class="mnt-report-header">
                <div>
                    <strong class="mnt-report-brand">Hygicare</strong>
                    <div class="mnt-report-title">Relatório de Manutenção <span class="mnt-report-os">Nº ${escapeHtml(m.id)}</span></div>
                </div>
                <span class="mnt-status-badge mnt-status-${statusKey}">${statusLabel}</span>
            </div>
            <div class="mnt-report-body">
                <div class="mnt-report-section">
                    <div class="mnt-grid-2x2">
                        <div class="mnt-field"><span class="mnt-field-label">Cliente</span><span class="mnt-field-value">${escapeHtml(titleCase(m.cliente) || '-')}</span></div>
                        <div class="mnt-field"><span class="mnt-field-label">Cidade</span><span class="mnt-field-value">${escapeHtml(titleCase(m.cidade) || '-')}</span></div>
                        <div class="mnt-field"><span class="mnt-field-label">Técnico</span><span class="mnt-field-value">${escapeHtml(titleCase(m.tecnico) || '-')}</span></div>
                        <div class="mnt-field"><span class="mnt-field-label">Data</span><span class="mnt-field-value">${escapeHtml(m.data || '-')}</span></div>
                    </div>
                </div>
                <div class="mnt-report-section">
                    <p class="mnt-section-title">Aferição de Vazão</p>
                    <div class="mnt-afericao-card">${afericaoRowsHtml}</div>
                </div>
                <div class="mnt-report-section">
                    <p class="mnt-section-title">Observação</p>
                    <div class="mnt-observacao-block">${escapeHtml(m.observacao || 'Nenhuma observação registrada.')}</div>
                </div>
                <div class="mnt-report-section">
                    <p class="mnt-section-title">Assinaturas</p>
                    <div class="mnt-signatures-grid">
                        <div class="mnt-signature-block">
                            <div class="mnt-signature-box">${m.assinaturaTecnico ? `<img src="${escapeHtml(m.assinaturaTecnico)}" alt="Assinatura do técnico">` : ''}</div>
                            <p class="mnt-signature-name">${escapeHtml(titleCase(m.tecnico) || 'Técnico')}</p>
                        </div>
                        <div class="mnt-signature-block">
                            <div class="mnt-signature-box">${m.assinaturaCliente ? `<img src="${escapeHtml(m.assinaturaCliente)}" alt="Assinatura do cliente">` : ''}</div>
                            <p class="mnt-signature-name">${escapeHtml(titleCase(m.cliente) || 'Cliente')}</p>
                        </div>
                    </div>
                </div>
            </div>
            <div class="mnt-report-footer">
                <span>${escapeHtml(window.location.origin)}</span>
                <span>Gerado em ${new Date().toLocaleString('pt-BR')}</span>
            </div>
        </div>
    `;

    document.getElementById('back-manutencao').addEventListener('click', () => navigateTo('manutencao'));
    document.getElementById('edit-manutencao').addEventListener('click', () => navigateTo('manutencao-edit', { manutencao: m }));
    document.getElementById('print-manutencao').addEventListener('click', () => window.print());
    document.getElementById('share-manutencao-whatsapp').addEventListener('click', () => {
        const text = `*Relatório de Manutenção - ${m.cliente}*\nCidade: ${m.cidade || '-'}\nTécnico: ${m.tecnico || '-'}\nData: ${m.data || '-'}\nObservação: ${m.observacao || '-'}`;
        openExternal(`https://wa.me/?text=${encodeURIComponent(text)}`);
    });
    document.getElementById('approve-manutencao')?.addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        setSaving(true, btn, 'Aprovando...');
        const result2 = await callAPI('approveManutencao', { id: m.id, user: state.currentUser });
        if (result2 && result2.status === 'success') {
            showToast('Relatório aprovado.');
            saveCache('manutencoes', null);
            state.manutencoes = [];
            navigateTo('manutencao-detail', { id: m.id });
        } else {
            showToast((result2 && result2.message) || 'Não foi possível aprovar.', true);
            setSaving(false, btn);
        }
    });
    document.getElementById('delete-manutencao')?.addEventListener('click', async (event) => {
        if (!confirm(`Apagar o relatório de "${m.cliente || 'cliente'}"? Essa ação não pode ser desfeita.`)) return;
        const btn = event.currentTarget;
        setSaving(true, btn, 'Apagando...');
        const result2 = await callAPI('deleteManutencao', { id: m.id, user: state.currentUser });
        if (result2 && result2.status === 'success') {
            state.manutencoes = state.manutencoes.filter((item) => String(item.id) !== String(m.id));
            saveCache('manutencoes', state.manutencoes);
            showToast('Relatório apagado.');
            navigateTo('manutencao');
        } else {
            showToast((result2 && result2.message) || 'Não foi possível apagar o relatório.', true);
            setSaving(false, btn);
        }
    });
}

function itemRowHtml(item = {}) {
    return `
    <div class="mnt-item-row" data-item-row>
        <input type="text" placeholder="Equipamento" class="mnt-item-equipamento" value="${escapeHtml(item.equipamento || '')}">
        <input type="text" placeholder="Produto" class="mnt-item-produto" value="${escapeHtml(item.produto || '')}">
        <input type="text" placeholder="Diluição" class="mnt-item-diluicao" value="${escapeHtml(item.diluicao || '')}">
        <select class="mnt-item-aferido">
            <option value="" ${!item.aferido ? 'selected' : ''}>Aferido?</option>
            <option value="Sim" ${item.aferido === 'Sim' ? 'selected' : ''}>Sim</option>
            <option value="Não" ${item.aferido === 'Não' ? 'selected' : ''}>Não</option>
        </select>
        <button type="button" class="mini-button mini-button-danger mnt-item-remove" aria-label="Remover linha">×</button>
    </div>`;
}

function bindItemRowRemove(container) {
    container.querySelectorAll('.mnt-item-remove').forEach((btn) => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => btn.closest('[data-item-row]')?.remove());
    });
}

function collectItens(container) {
    const rows = Array.from(container.querySelectorAll('[data-item-row]'));
    return rows.map((row) => ({
        equipamento: row.querySelector('.mnt-item-equipamento').value.trim(),
        produto: row.querySelector('.mnt-item-produto').value.trim(),
        diluicao: row.querySelector('.mnt-item-diluicao').value.trim(),
        aferido: row.querySelector('.mnt-item-aferido').value.trim()
    })).filter((i) => i.equipamento || i.produto || i.diluicao || i.aferido);
}

// Assinatura desenhada na tela (dedo no celular, mouse no desktop) — Pointer
// Events cobre os dois com o mesmo código. O canvas nasce em CSS (100% de
// largura, altura fixa) mas o <canvas> por padrão desenha numa resolução
// interna fixa (300x150) — sem ajustar width/height reais pro tamanho
// exibido (considerando devicePixelRatio), o traço sai borrado/esticado.
function bindSignaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a1a1a';

    let drawing = false;
    let last = null;
    const pos = (e) => {
        const r = canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
        drawing = true;
        canvas.setPointerCapture(e.pointerId);
        last = pos(e);
        canvas.dataset.signed = '1';
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const p = pos(e);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last = p;
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointerleave', stop);
    canvas.addEventListener('pointercancel', stop);
}

function clearSignaturePad(canvas) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    canvas.dataset.signed = '';
}

// Editar um relatório que já tem assinatura salva pré-carrega o traço no
// canvas — se o usuário não mexer nele, o valor é reenviado igual no
// submit; se clicar em "Limpar", o dataset.signed some e a assinatura sai
// do relatório.
function loadSignatureIntoCanvas(canvas, dataUrl) {
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
        const ratio = window.devicePixelRatio || 1;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width / ratio, canvas.height / ratio);
        canvas.dataset.signed = '1';
    };
    img.src = dataUrl;
}

function signaturePadToDataUrl(canvas) {
    return canvas.dataset.signed ? canvas.toDataURL('image/png') : '';
}

export async function renderManutencaoFormPage(record) {
    ensureManutencaoStyles();
    const mainContent = document.getElementById('main-content');
    const isEdit = Boolean(record && (record.Id || record.id));
    const m = isEdit ? normalizeManutencao(record) : normalizeManutencao({});
    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';

    if (!state.formData) {
        mainContent.innerHTML = `
            <div class="page-header compact-header">
                <button type="button" class="mini-button" id="back-manutencao-overlay">Voltar</button>
                <h2>${isEdit ? 'Editar Relatório' : 'Novo Relatório de Manutenção'}</h2>
            </div>
            <div class="card form-card" style="position:relative;min-height:200px;">
                <div class="form-loading-overlay">
                    <div class="form-loading-spinner"></div>
                    <span>Carregando formulario...</span>
                </div>
            </div>
        `;
        document.getElementById('back-manutencao-overlay')?.addEventListener('click', () => navigateTo(isEdit ? 'manutencao-detail' : 'manutencao', isEdit ? { id: m.id } : {}));
    }

    const fdResult = await ensureFormData();
    const cidades = (fdResult.data && fdResult.data.cidades) || [];
    const clientes = (fdResult.data && fdResult.data.clientes) || [];

    const itensIniciais = isEdit ? safeParseJson(m.itensTabela, []) : [];

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-manutencao-form">Voltar</button>
            <h2>${isEdit ? 'Editar Relatório' : 'Novo Relatório de Manutenção'}</h2>
        </div>
        <form id="manutencao-form" class="card form-card form-layout">
            <div class="form-group full-width">
                <label for="mnt-cliente">Cliente</label>
                <div class="searchable-select">
                    <input type="text" id="mnt-cliente" value="${escapeHtml(m.cliente)}" placeholder="Busque ou digite o cliente" autocomplete="off" required>
                    <div class="searchable-select-menu" id="mnt-cliente-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="mnt-cidade">Cidade</label>
                <div class="searchable-select">
                    <input type="text" id="mnt-cidade" value="${escapeHtml(m.cidade)}" placeholder="Pesquise a cidade" autocomplete="off">
                    <div class="searchable-select-menu" id="mnt-cidade-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="mnt-tecnico">Técnico</label>
                <input type="text" id="mnt-tecnico" value="${escapeHtml(m.tecnico || state.currentUser?.name || '')}" ${isAdmin ? '' : 'readonly'}>
            </div>

            <div class="form-group full-width">
                <label>Tabela de Aferição</label>
                <div id="mnt-itens-container">${(itensIniciais.length ? itensIniciais : [{}, {}, {}]).map((i) => itemRowHtml(i)).join('')}</div>
                <button type="button" class="mini-button" id="mnt-add-item" style="margin-top:0.5rem">+ Adicionar linha</button>
            </div>

            <div class="form-group full-width">
                <label for="mnt-observacao">Observação</label>
                <textarea id="mnt-observacao" rows="5">${escapeHtml(m.observacao || '')}</textarea>
            </div>

            <div class="form-group full-width">
                <label>Assinatura do Técnico</label>
                <canvas id="mnt-signature-tecnico" class="signature-pad"></canvas>
                <div class="signature-pad-actions"><button type="button" class="mini-button" id="mnt-signature-tecnico-clear">Limpar assinatura</button></div>
            </div>
            <div class="form-group full-width">
                <label>Assinatura do Cliente</label>
                <canvas id="mnt-signature-cliente" class="signature-pad"></canvas>
                <div class="signature-pad-actions"><button type="button" class="mini-button" id="mnt-signature-cliente-clear">Limpar assinatura</button></div>
            </div>

            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-manutencao">Cancelar</button>
                <button type="submit" id="save-manutencao">Salvar Relatório</button>
            </div>
        </form>
    `;

    const sigTecnico = document.getElementById('mnt-signature-tecnico');
    const sigCliente = document.getElementById('mnt-signature-cliente');
    bindSignaturePad(sigTecnico);
    bindSignaturePad(sigCliente);
    if (isEdit) {
        loadSignatureIntoCanvas(sigTecnico, m.assinaturaTecnico);
        loadSignatureIntoCanvas(sigCliente, m.assinaturaCliente);
    }
    document.getElementById('mnt-signature-tecnico-clear').addEventListener('click', () => clearSignaturePad(sigTecnico));
    document.getElementById('mnt-signature-cliente-clear').addEventListener('click', () => clearSignaturePad(sigCliente));

    initializeSearchableInput({
        input: document.getElementById('mnt-cliente'),
        menu: document.getElementById('mnt-cliente-menu'),
        items: clientes.map((c) => c.nome),
        allowFreeText: true
    });
    initializeSearchableInput({
        input: document.getElementById('mnt-cidade'),
        menu: document.getElementById('mnt-cidade-menu'),
        items: cidades
    });

    const itensContainer = document.getElementById('mnt-itens-container');
    bindItemRowRemove(itensContainer);
    document.getElementById('mnt-add-item').addEventListener('click', () => {
        itensContainer.insertAdjacentHTML('beforeend', itemRowHtml());
        bindItemRowRemove(itensContainer);
    });

    document.getElementById('back-manutencao-form').addEventListener('click', () => navigateTo(isEdit ? 'manutencao-detail' : 'manutencao', isEdit ? { id: m.id } : {}));
    document.getElementById('cancel-manutencao').addEventListener('click', () => navigateTo(isEdit ? 'manutencao-detail' : 'manutencao', isEdit ? { id: m.id } : {}));

    document.getElementById('manutencao-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = document.getElementById('save-manutencao');
        setSaving(true, button, 'Salvando...');

        const clienteVal = document.getElementById('mnt-cliente').value.trim();
        if (!clienteVal) {
            showToast('Informe o cliente.', true);
            setSaving(false, button);
            return;
        }
        const cidadeVal = document.getElementById('mnt-cidade').value.trim();
        const tecnicoVal = document.getElementById('mnt-tecnico').value.trim();
        const observacaoVal = document.getElementById('mnt-observacao').value.trim();

        const payload = {
            cliente: clienteVal, cidade: cidadeVal, tecnico: tecnicoVal,
            observacao: observacaoVal,
            itensTabela: JSON.stringify(collectItens(itensContainer)),
            // Sempre manda o que está no canvas agora (mesmo vazio) — assim
            // clicar em "Limpar" numa edição realmente apaga a assinatura
            // salva, em vez de deixar o valor antigo intocado no servidor.
            assinaturaTecnico: signaturePadToDataUrl(sigTecnico),
            assinaturaCliente: signaturePadToDataUrl(sigCliente),
            user: state.currentUser
        };

        if (isEdit) {
            const idx = state.manutencoes.findIndex((item) => String(item.id) === String(m.id));
            const result = await attemptOrQueue('updateManutencao', { id: m.id, ...payload }, { entity: 'manutencao', tempId: m.id });
            if (result && result.status === 'success') {
                if (idx >= 0) { state.manutencoes[idx] = normalizeManutencao(result.manutencao); saveCache('manutencoes', state.manutencoes); }
                showToast('Relatório atualizado.');
                navigateTo('manutencao-detail', { id: m.id });
            } else if (result && result.status === 'queued') {
                showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                navigateTo('manutencao-detail', { id: m.id });
            } else {
                showToast((result && result.message) || 'Erro ao salvar. Tente novamente.', true);
                setSaving(false, button);
            }
        } else {
            const tempId = 'temp_' + Date.now();
            const result = await attemptOrQueue('createManutencao', payload, { entity: 'manutencao', tempId });
            if (result && result.status === 'success') {
                showToast('Relatório criado com sucesso.');
                saveCache('manutencoes', null);
                state.manutencoes = [];
                navigateTo('manutencao');
            } else if (result && result.status === 'queued') {
                showToast('Sem conexão — o relatório foi salvo no aparelho e será enviado quando a conexão voltar.');
                navigateTo('manutencao');
            } else {
                showToast((result && result.message) || 'Erro ao criar relatório.', true);
                setSaving(false, button);
            }
        }
    });
}

export async function renderManutencaoCreatePage() {
    await renderManutencaoFormPage(null);
}

export async function getManutencoes() {
    try {
        const result = await callAPI('getManutencoes', { user: state.currentUser });
        if (result.status === 'success') { saveCache('manutencoes', result.manutencoes || []); }
        return result;
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

export async function getManutencaoById(id) {
    const existing = state.manutencoes.find((item) => String(item.Id || item.id) === String(id));
    if (existing) return { status: 'success', manutencao: existing };
    try {
        return await callAPI('getManutencaoById', { id, user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}
