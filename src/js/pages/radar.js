import { state, navigateTo } from '../app.js';
import { callAPI } from '../api.js';
import { escapeHtml } from '../utils/format.js';
import { debounce, initializeSearchableInput, showToast, loadingState, setSaving } from '../utils/dom.js';
import { ensureStyles } from '../utils/ui.js';
import { BRAZIL_MAP_SIZE, BRAZIL_OUTLINE_PATH, BRAZIL_STATE_PATHS, projectLatLng } from '../data/brazilOutline.js';

const STATUS_LABELS = {
    buscado: 'Nunca contatado',
    ja_atendido: 'Já é cliente',
    recusado: 'Recusou',
    prospeccao_agendada: 'Prospecção agendada'
};

const STATUS_CLASSES = {
    buscado: 'status-pill radar-status-buscado',
    ja_atendido: 'status-pill radar-status-atendido',
    recusado: 'status-pill radar-status-recusado',
    prospeccao_agendada: 'status-pill radar-status-agendada'
};

let activeRadarTab = 'buscar';

// Lista da cidade atualmente carregada — vive só neste módulo (não em
// `state`), já que o Radar não segue o padrão "carrega tudo" do resto do
// app (é filtrado por cidade no servidor), então não faz sentido tratar
// como uma lista global igual state.visits/state.proposals.
let currentClientes = [];
let currentCidade = null; // { cidade, uf } selecionado na aba Buscar

// Aba Histórico: por padrão mostra a mesma cidade selecionada na aba
// Buscar (mesma trava de segurança de escala da seção 4 do plano) — só
// busca todas as cidades sob um clique explícito.
let historicoClientes = [];
let historicoScopeAll = false;
let historicoLoaded = false;

function cidadeLabel(c) {
    return c.uf ? `${c.cidade} - ${c.uf}` : c.cidade;
}

export async function renderRadarPage() {
    ensureStyles('radar');
    const isAdmin = String(state.currentUser?.profile || '').trim().toLowerCase() === 'admin';
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        <div class="page-header">
            <div><h2>Radar de Clientes</h2><p class="page-subtitle">Encontre empresas por cidade pra prospectar</p></div>
        </div>
        <div class="radar-tabs-bar">
            <button type="button" class="radar-tab${activeRadarTab === 'buscar' ? ' active' : ''}" data-tab="buscar">Buscar</button>
            <button type="button" class="radar-tab${activeRadarTab === 'historico' ? ' active' : ''}" data-tab="historico">Histórico</button>
            ${isAdmin ? `<button type="button" class="radar-tab${activeRadarTab === 'importar' ? ' active' : ''}" data-tab="importar">Importar CSV</button>` : ''}
        </div>
        <div class="radar-tab-panel${activeRadarTab === 'buscar' ? ' active' : ''}" id="radar-tab-buscar">
            <div id="radar-map-wrap"></div>
            <div class="card radar-search-card">
                <div class="form-group">
                    <label for="radar-cidade">Cidade</label>
                    <div class="searchable-select">
                        <input type="text" id="radar-cidade" placeholder="Escolha uma cidade liberada" autocomplete="off">
                        <div class="searchable-select-menu" id="radar-cidade-menu"></div>
                    </div>
                </div>
                <div class="form-group" id="radar-segmento-group" style="display:none">
                    <label for="radar-segmento">Segmento</label>
                    <input type="text" id="radar-segmento" placeholder="Filtrar por segmento (ex: restaurante, farmácia...)">
                </div>
            </div>
            <div id="radar-results"></div>
        </div>
        <div class="radar-tab-panel${activeRadarTab === 'historico' ? ' active' : ''}" id="radar-tab-historico">
            <div class="card radar-search-card">
                <div class="form-group">
                    <label for="radar-historico-status">Status</label>
                    <select id="radar-historico-status">
                        <option value="todos">Todos</option>
                        <option value="buscado">Nunca contatado</option>
                        <option value="ja_atendido">Já é cliente</option>
                        <option value="recusado">Recusou</option>
                        <option value="prospeccao_agendada">Prospecção agendada</option>
                    </select>
                </div>
                <p class="field-helper-text" id="radar-historico-scope-label"></p>
                <button type="button" class="mini-button" id="radar-historico-scope-btn" style="display:none">Ver todas as cidades</button>
            </div>
            <div id="radar-historico-results"></div>
            ${isAdmin ? `
                <div class="card" style="margin-top:1rem">
                    <h3 style="margin-top:0">Solicitações de cidade pendentes</h3>
                    <div id="radar-solicitacoes-list"><p class="page-subtitle">Carregando...</p></div>
                </div>
            ` : ''}
        </div>
        ${isAdmin ? `
            <div class="radar-tab-panel${activeRadarTab === 'importar' ? ' active' : ''}" id="radar-tab-importar">
                <div class="card">
                    <h3 style="margin-top:0">Importar base do Radar (CSV)</h3>
                    <p class="helper-text" style="text-align:left">
                        Sobe o CSV exportado do programa de consulta de CNPJ. Empresa nova entra
                        como "nunca contatada"; empresa já cadastrada (mesmo CNPJ) só atualiza os
                        dados informativos — o status dado pelo vendedor nunca é sobrescrito.
                        Cidade nova é liberada automaticamente pra todo mundo.
                    </p>
                    <div class="form-group full-width">
                        <label for="radar-import-file">Arquivo CSV</label>
                        <input type="file" id="radar-import-file" accept=".csv,text/csv">
                    </div>
                    <div class="form-actions">
                        <button type="button" class="primary-button" id="radar-import-btn" disabled>Importar</button>
                    </div>
                    <div id="radar-import-summary" style="margin-top:1rem"></div>
                </div>
            </div>
        ` : ''}
    `;

    document.querySelectorAll('.radar-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            activeRadarTab = tab.dataset.tab;
            document.querySelectorAll('.radar-tab').forEach((t) => t.classList.remove('active'));
            document.querySelectorAll('.radar-tab-panel').forEach((p) => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`radar-tab-${tab.dataset.tab}`)?.classList.add('active');
            if (tab.dataset.tab === 'historico' && !historicoLoaded) {
                historicoLoaded = true;
                loadHistorico();
                if (isAdmin) { loadSolicitacoes(); }
            }
        });
    });

    if (isAdmin) { bindImportTab(); }

    await renderBuscarTab();

    if (activeRadarTab === 'historico') {
        historicoLoaded = true;
        await loadHistorico();
        if (isAdmin) { await loadSolicitacoes(); }
    }
}

function bindImportTab() {
    const fileInput = document.getElementById('radar-import-file');
    const importBtn = document.getElementById('radar-import-btn');
    const summaryEl = document.getElementById('radar-import-summary');
    let selectedFile = null;

    fileInput.addEventListener('change', () => {
        selectedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        importBtn.disabled = !selectedFile;
        summaryEl.innerHTML = '';
    });

    importBtn.addEventListener('click', () => {
        if (!selectedFile) return;
        setSaving(true, importBtn, 'Importando...');
        summaryEl.innerHTML = '';
        const reader = new FileReader();
        reader.onload = async () => {
            const csvText = String(reader.result || '');
            const result = await callAPI('importRadarClientesCsv', { user: state.currentUser, csvText });
            setSaving(false, importBtn);
            if (result.status !== 'success') {
                summaryEl.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao importar o CSV.')}</p>`;
                return;
            }
            summaryEl.innerHTML = `
                <div class="card" style="background:var(--bg-alt, #f8fafc)">
                    <p style="margin:0 0 0.4rem"><strong>${result.novas}</strong> empresa(s) nova(s)</p>
                    <p style="margin:0 0 0.4rem"><strong>${result.atualizadas}</strong> empresa(s) atualizada(s)</p>
                    ${result.cidadesAdicionadas ? `<p style="margin:0 0 0.4rem"><strong>${result.cidadesAdicionadas}</strong> cidade(s) nova(s) liberada(s)</p>` : ''}
                    ${result.solicitacoesAtendidas ? `<p style="margin:0 0 0.4rem"><strong>${result.solicitacoesAtendidas}</strong> solicitação(ões) de cidade atendida(s)</p>` : ''}
                    ${result.ignoradas ? `<p style="margin:0 0 0.4rem">${result.ignoradas} linha(s) ignorada(s) (sem CNPJ, Cliente ou Cidade)</p>` : ''}
                    ${result.duplicadasNoArquivo ? `<p style="margin:0">${result.duplicadasNoArquivo} linha(s) duplicada(s) dentro do próprio arquivo</p>` : ''}
                </div>
            `;
            showToast('Importação concluída.');
            fileInput.value = '';
            selectedFile = null;
            importBtn.disabled = true;
            historicoLoaded = false;
        };
        reader.onerror = () => {
            setSaving(false, importBtn);
            summaryEl.innerHTML = `<p class="error-message">Não foi possível ler o arquivo.</p>`;
        };
        reader.readAsText(selectedFile, 'UTF-8');
    });
}

async function renderBuscarTab() {
    const resultsEl = document.getElementById('radar-results');
    resultsEl.innerHTML = loadingState('📡', 'Carregando cidades liberadas...');

    const cidadesResult = await callAPI('getRadarCidadesDisponiveis', { user: state.currentUser });
    if (cidadesResult.status !== 'success') {
        resultsEl.innerHTML = `<p class="error-message">${escapeHtml(cidadesResult.message || 'Não foi possível carregar as cidades.')}</p>`;
        return;
    }
    const cidades = cidadesResult.cidades || [];

    if (cidades.length === 0) {
        resultsEl.innerHTML = `
            <div class="empty-state">
                <span class="empty-state-icon">📍</span>
                <p>Nenhuma cidade liberada ainda.</p>
                <button type="button" class="btn-add" id="radar-solicitar-cidade-btn">Solicitar cidade</button>
            </div>
        `;
        document.getElementById('radar-solicitar-cidade-btn')?.addEventListener('click', () => openSolicitarCidadeModal());
        return;
    }

    resultsEl.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Escolha uma cidade acima pra ver as empresas.</p></div>`;

    const cidadeInput = document.getElementById('radar-cidade');
    const cidadeMenu = document.getElementById('radar-cidade-menu');
    const segmentoGroup = document.getElementById('radar-segmento-group');
    const segmentoInput = document.getElementById('radar-segmento');

    const selectCidade = async (match) => {
        cidadeInput.value = cidadeLabel(match);
        resultsEl.innerHTML = loadingState('📡', 'Buscando empresas...');
        const result = await callAPI('getRadarClientes', { user: state.currentUser, cidade: match.cidade, uf: match.uf });
        if (result.status !== 'success') {
            resultsEl.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao buscar empresas.')}</p>`;
            return;
        }
        currentClientes = result.clientes || [];
        currentCidade = { cidade: match.cidade, uf: match.uf };
        segmentoGroup.style.display = '';
        segmentoInput.value = '';
        renderRadarResults(resultsEl);
        updateHistoricoScopeLabel();
        document.querySelectorAll('.radar-map-pin').forEach((pin) => {
            pin.classList.toggle('active', pin.dataset.cidade === match.cidade && pin.dataset.uf === match.uf);
        });
        document.querySelectorAll('.radar-map-state').forEach((state) => {
            state.classList.toggle('active', state.dataset.uf === match.uf);
        });
    };

    initializeSearchableInput({
        input: cidadeInput,
        menu: cidadeMenu,
        items: cidades.map(cidadeLabel),
        onSelect: (value) => {
            const match = cidades.find((c) => cidadeLabel(c) === value);
            if (match) selectCidade(match);
        }
    });

    segmentoInput.addEventListener('input', debounce(() => renderRadarResults(resultsEl), 250));

    renderCidadeMapa(cidades, selectCidade);
}

const MAP_ZOOM_MIN = 1;
const MAP_ZOOM_MAX = 10;

// Mapa esquemático (contorno estático + pins) por cima da lista de
// cidades — só entram cidades com Lat/Lng resolvida (ver seção 6 do
// plano); quem não tem coordenada continua acessível pelo campo de busca
// acima, que não muda nada com ou sem mapa. Arrastar (mouse/touch) e zoom
// (scroll, pinça de 2 dedos, botões +/-) via transform num <g> interno —
// o path/pins em si nunca mudam, só a transformação aplicada por cima.
function renderCidadeMapa(cidades, onSelect) {
    const wrap = document.getElementById('radar-map-wrap');
    if (!wrap) return;
    const comCoordenada = cidades.filter((c) => c.lat !== null && c.lng !== null && !Number.isNaN(c.lat) && !Number.isNaN(c.lng));
    if (comCoordenada.length === 0) { wrap.innerHTML = ''; return; }

    const pins = comCoordenada.map((c) => {
        const { x, y } = projectLatLng(c.lat, c.lng);
        return `<circle class="radar-map-pin" cx="${x}" cy="${y}" r="5" data-cidade="${escapeHtml(c.cidade)}" data-uf="${escapeHtml(c.uf)}"><title>${escapeHtml(cidadeLabel(c))}</title></circle>`;
    }).join('');
    const estados = BRAZIL_STATE_PATHS.map((s) =>
        `<path d="${s.d}" class="radar-map-state${currentCidade && currentCidade.uf === s.sigla ? ' active' : ''}" data-uf="${s.sigla}"><title>${s.sigla}</title></path>`
    ).join('');

    wrap.innerHTML = `
        <div class="card radar-map-card">
            <div class="radar-map-viewport">
                <svg viewBox="0 0 ${BRAZIL_MAP_SIZE} ${BRAZIL_MAP_SIZE}" class="radar-map-svg" id="radar-map-svg" role="img" aria-label="Mapa com as cidades liberadas do Radar — arraste pra mover, use scroll ou pinça pra dar zoom">
                    <g id="radar-map-group">
                        <path d="${BRAZIL_OUTLINE_PATH}" class="radar-map-outline"></path>
                        ${estados}
                        ${pins}
                    </g>
                </svg>
                <div class="radar-map-toolbar">
                    <button type="button" class="radar-map-zoom-btn" id="radar-map-zoom-in" aria-label="Aumentar zoom">+</button>
                    <button type="button" class="radar-map-zoom-btn" id="radar-map-zoom-out" aria-label="Diminuir zoom">−</button>
                    <button type="button" class="radar-map-zoom-btn" id="radar-map-zoom-reset" aria-label="Redefinir zoom">⟲</button>
                </div>
            </div>
        </div>
    `;

    wrap.querySelectorAll('.radar-map-pin').forEach((pin) => {
        pin.addEventListener('click', () => {
            if (mapDragged) return; // arrastar não deve também selecionar a cidade
            const match = comCoordenada.find((c) => c.cidade === pin.dataset.cidade && c.uf === pin.dataset.uf);
            if (match) onSelect(match);
        });
    });

    const svg = document.getElementById('radar-map-svg');
    const group = document.getElementById('radar-map-group');
    let scale = 1, tx = 0, ty = 0;
    let mapDragged = false;

    function applyTransform() {
        group.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
    }
    applyTransform();

    function clampPan(nextScale, nextTx, nextTy) {
        const slack = BRAZIL_MAP_SIZE * 0.4;
        const min = (1 - nextScale) * BRAZIL_MAP_SIZE - slack;
        const max = slack;
        return { tx: Math.min(max, Math.max(min, nextTx)), ty: Math.min(max, Math.max(min, nextTy)) };
    }

    function toSvgPoint(clientX, clientY) {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        const p = pt.matrixTransform(ctm.inverse());
        return { x: p.x, y: p.y };
    }

    function zoomAt(svgPoint, nextScaleRaw) {
        const nextScale = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, nextScaleRaw));
        // Ponto do desenho (espaço interno do <g>, antes do transform) que
        // está embaixo do cursor/centro do gesto — precisa continuar embaixo
        // dele depois do zoom, senão o mapa "pula".
        const localX = (svgPoint.x - tx) / scale;
        const localY = (svgPoint.y - ty) / scale;
        const nextTx = svgPoint.x - localX * nextScale;
        const nextTy = svgPoint.y - localY * nextScale;
        scale = nextScale;
        ({ tx, ty } = clampPan(scale, nextTx, nextTy));
        applyTransform();
    }

    svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        zoomAt(toSvgPoint(e.clientX, e.clientY), scale * factor);
    }, { passive: false });

    document.getElementById('radar-map-zoom-in').addEventListener('click', () => {
        zoomAt(toSvgPoint(...svgCenterClient()), scale * 1.4);
    });
    document.getElementById('radar-map-zoom-out').addEventListener('click', () => {
        zoomAt(toSvgPoint(...svgCenterClient()), scale / 1.4);
    });
    document.getElementById('radar-map-zoom-reset').addEventListener('click', () => {
        scale = 1; tx = 0; ty = 0;
        applyTransform();
    });

    function svgCenterClient() {
        const rect = svg.getBoundingClientRect();
        return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    }

    // Arrastar com mouse/caneta/1 dedo; pinça com 2 dedos pra zoom — tudo
    // via Pointer Events (unifica mouse e touch num só conjunto de handlers).
    const activePointers = new Map(); // pointerId -> {x, y} (client)
    let dragStart = null; // { svgX, svgY, tx, ty }
    let pinch = null; // { startDist, startScale, midSvg }

    function pointerDistance() {
        const pts = Array.from(activePointers.values());
        return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    svg.addEventListener('pointerdown', (e) => {
        svg.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        mapDragged = false;
        if (activePointers.size === 2) {
            dragStart = null;
            const pts = Array.from(activePointers.values());
            const midClient = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            pinch = { startDist: pointerDistance(), startScale: scale, midSvg: toSvgPoint(midClient.x, midClient.y) };
        } else {
            const p = toSvgPoint(e.clientX, e.clientY);
            dragStart = { svgX: p.x, svgY: p.y, tx, ty };
        }
    });

    svg.addEventListener('pointermove', (e) => {
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (activePointers.size === 2 && pinch) {
            const factor = pointerDistance() / pinch.startDist;
            zoomAt(pinch.midSvg, pinch.startScale * factor);
            return;
        }
        if (dragStart) {
            const p = toSvgPoint(e.clientX, e.clientY);
            const dx = p.x - dragStart.svgX;
            const dy = p.y - dragStart.svgY;
            if (Math.hypot(dx, dy) > 2) mapDragged = true;
            ({ tx, ty } = clampPan(scale, dragStart.tx + dx, dragStart.ty + dy));
            applyTransform();
        }
    });

    const endPointer = (e) => {
        activePointers.delete(e.pointerId);
        if (activePointers.size < 2) pinch = null;
        if (activePointers.size === 0) {
            dragStart = null;
            // Só some a flag depois do 'click' (que o navegador dispara logo
            // após o pointerup) já ter checado — senão o clique some junto.
            setTimeout(() => { mapDragged = false; }, 0);
        }
    };
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
}

function renderRadarResults(resultsEl) {
    const segmento = document.getElementById('radar-segmento')?.value.trim().toLowerCase() || '';
    const filtered = segmento
        ? currentClientes.filter((c) =>
            String(c.cnaeDescricao || '').toLowerCase().includes(segmento) ||
            String(c.segmento || '').toLowerCase().includes(segmento) ||
            String(c.cnaeCodigo || '').toLowerCase().includes(segmento))
        : currentClientes;

    renderClienteCards(filtered, resultsEl, {
        emptyMessage: 'Nenhuma empresa encontrada.',
        onUpdated: () => renderRadarResults(resultsEl)
    });
}

function rerenderRadarList() {
    const el = document.getElementById('radar-results');
    if (el) renderRadarResults(el);
}

// Compartilhado entre a aba Buscar e a aba Histórico — mesmo card
// (.proposal-card com status-pill), mesma ordenação por prioridade de
// contato, só muda a lista de entrada e o callback de refresh pós-ação.
function renderClienteCards(list, resultsEl, { emptyMessage, onUpdated }) {
    if (list.length === 0) {
        resultsEl.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>${escapeHtml(emptyMessage)}</p></div>`;
        return;
    }

    // Prioriza quem nunca foi contatado — é literalmente o objetivo do Radar.
    const priority = { buscado: 0, prospeccao_agendada: 1, recusado: 2, ja_atendido: 3 };
    const sorted = [...list].sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));

    resultsEl.innerHTML = `
        <p class="page-subtitle" style="margin-bottom:0.5rem">${list.length} empresa(s)</p>
        <div class="visits-list">${sorted.map((c) => `
            <button type="button" class="radar-cliente-card" data-radar-id="${escapeHtml(c.id)}">
                <div class="radar-cliente-header">
                    <strong>${escapeHtml(c.nomeFantasia || c.nome || 'Empresa')}</strong>
                    <span class="${STATUS_CLASSES[c.status] || 'status-pill'}">${escapeHtml(STATUS_LABELS[c.status] || c.status)}</span>
                </div>
                ${c.nomeFantasia && c.nome && c.nomeFantasia !== c.nome ? `<div class="radar-cliente-meta"><span>${escapeHtml(c.nome)}</span></div>` : ''}
                <div class="radar-cliente-meta">
                    ${c.telefone ? `<span>📞 ${escapeHtml(c.telefone)}</span>` : ''}
                    <span>${escapeHtml(cidadeLabel(c))}</span>
                </div>
                ${c.status === 'recusado' && c.statusRetornoPrevisto
                    ? `<div class="radar-cliente-meta"><span>Retornar em: ${escapeHtml(c.statusRetornoPrevisto)}</span></div>`
                    : ''}
            </button>
        `).join('')}</div>
    `;

    resultsEl.querySelectorAll('[data-radar-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const cliente = list.find((c) => String(c.id) === btn.dataset.radarId);
            if (cliente) openRadarDetailCard(cliente, onUpdated);
        });
    });
}

function updateHistoricoScopeLabel() {
    const label = document.getElementById('radar-historico-scope-label');
    const btn = document.getElementById('radar-historico-scope-btn');
    if (!label || !btn) return;
    if (historicoScopeAll) {
        label.textContent = 'Mostrando empresas de todas as cidades.';
        btn.style.display = 'none';
    } else if (currentCidade) {
        label.textContent = `Mostrando empresas de ${cidadeLabel(currentCidade)}.`;
        btn.style.display = '';
    } else {
        label.textContent = 'Escolha uma cidade na aba Buscar, ou veja todas as cidades.';
        btn.style.display = '';
    }
}

async function loadHistorico() {
    updateHistoricoScopeLabel();
    const statusSelect = document.getElementById('radar-historico-status');
    statusSelect?.addEventListener('change', () => renderHistoricoResults());
    document.getElementById('radar-historico-scope-btn')?.addEventListener('click', async () => {
        historicoScopeAll = true;
        updateHistoricoScopeLabel();
        const resultsEl = document.getElementById('radar-historico-results');
        resultsEl.innerHTML = loadingState('📡', 'Carregando todas as cidades...');
        const result = await callAPI('getRadarClientes', { user: state.currentUser, scope: 'all' });
        if (result.status !== 'success') {
            resultsEl.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao buscar empresas.')}</p>`;
            return;
        }
        historicoClientes = result.clientes || [];
        renderHistoricoResults();
    });
    renderHistoricoResults();
}

function renderHistoricoResults() {
    const resultsEl = document.getElementById('radar-historico-results');
    if (!resultsEl) return;
    const source = historicoScopeAll ? historicoClientes : currentClientes;

    if (!historicoScopeAll && !currentCidade) {
        resultsEl.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🕘</span><p>Nenhuma cidade selecionada ainda.</p></div>`;
        return;
    }

    const status = document.getElementById('radar-historico-status')?.value || 'todos';
    const filtered = status === 'todos' ? source : source.filter((c) => c.status === status);

    renderClienteCards(filtered, resultsEl, {
        emptyMessage: 'Nenhuma empresa encontrada.',
        onUpdated: () => renderHistoricoResults()
    });
}

async function loadSolicitacoes() {
    const listEl = document.getElementById('radar-solicitacoes-list');
    if (!listEl) return;
    const result = await callAPI('getRadarSolicitacoesCidade', { user: state.currentUser });
    if (result.status !== 'success') {
        listEl.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar solicitações.')}</p>`;
        return;
    }
    const solicitacoes = result.solicitacoes || [];
    if (solicitacoes.length === 0) {
        listEl.innerHTML = `<p class="page-subtitle">Nenhuma solicitação pendente.</p>`;
        return;
    }
    listEl.innerHTML = `
        <div class="visits-list">${solicitacoes.map((s) => `
            <div class="proposal-card" style="cursor:default">
                <div class="visit-card-header">
                    <strong>${escapeHtml(s.uf ? `${s.cidadeSolicitada} - ${s.uf}` : s.cidadeSolicitada)}</strong>
                    ${s.urgente ? '<span class="status-pill radar-status-recusado">Urgente</span>' : ''}
                </div>
                <div class="proposal-meta">
                    <span>Solicitado por ${escapeHtml(s.solicitadoPor || '-')}</span>
                    <span>${escapeHtml(s.dataSolicitacao || '-')}</span>
                </div>
            </div>
        `).join('')}</div>
    `;
}

// Junta Endereco/Numero/Complemento/Bairro/Cep (colunas separadas na
// planilha, fiel ao CSV) numa única linha legível pro card de detalhe.
function formatEndereco(c) {
    const parts = [];
    if (c.endereco) parts.push(c.numero ? `${c.endereco}, ${c.numero}` : c.endereco);
    if (c.complemento) parts.push(c.complemento);
    if (c.bairro) parts.push(c.bairro);
    if (c.cep) parts.push(`CEP ${c.cep}`);
    return parts.join(' - ');
}

function openRadarDetailCard(cliente, onUpdated) {
    const refresh = onUpdated || rerenderRadarList;
    const endereco = formatEndereco(cliente);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left">
            <h3 style="margin-top:0">${escapeHtml(cliente.nomeFantasia || cliente.nome || 'Empresa')}</h3>
            ${cliente.nomeFantasia && cliente.nome && cliente.nomeFantasia !== cliente.nome
                ? `<p class="helper-text" style="margin:0 0 0.5rem;text-align:left">${escapeHtml(cliente.nome)}</p>` : ''}
            <p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(cidadeLabel(cliente))}</p>
            <p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(cliente.cnaeDescricao || '-')}</p>
            ${cliente.segmento ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(cliente.segmento)}</p>` : ''}
            ${endereco ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">📍 ${escapeHtml(endereco)}</p>` : ''}
            ${cliente.telefone ? `<p class="helper-text" style="text-align:left;margin:0 0 0.85rem">📞 <a href="tel:${escapeHtml(cliente.telefone.replace(/\D/g, ''))}">${escapeHtml(cliente.telefone)}</a></p>` : ''}
            <span class="${STATUS_CLASSES[cliente.status] || 'status-pill'}" style="margin-bottom:1rem;display:inline-block">${escapeHtml(STATUS_LABELS[cliente.status] || cliente.status)}</span>
            <div class="form-actions" style="flex-direction:column;gap:0.5rem;margin-top:0.5rem">
                <button type="button" class="primary-button" id="radar-btn-atendido">Já é atendido</button>
                <button type="button" class="mini-button-danger" style="width:100%;padding:0.7rem;border-radius:var(--radius-sm);background:#fef2f2;color:#b91c1c;border:1.5px solid #fecaca" id="radar-btn-recusou">Recusou / não quer</button>
                <button type="button" class="secondary-button" id="radar-btn-agendar">Agendar prospecção</button>
                <button type="button" class="secondary-button" id="radar-btn-fechar">Fechar</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#radar-btn-fechar').addEventListener('click', close);

    overlay.querySelector('#radar-btn-atendido').addEventListener('click', async () => {
        const btn = overlay.querySelector('#radar-btn-atendido');
        setSaving(true, btn, 'Salvando...');
        const result = await callAPI('updateRadarClienteStatus', { user: state.currentUser, id: cliente.id, status: 'ja_atendido' });
        if (result.status === 'success') {
            cliente.status = 'ja_atendido';
            showToast('Marcado como já atendido.');
            close();
            refresh();
        } else {
            showToast(result.message || 'Não foi possível atualizar.', true);
            setSaving(false, btn);
        }
    });

    overlay.querySelector('#radar-btn-recusou').addEventListener('click', () => {
        close();
        openRecusarModal(cliente, refresh);
    });

    overlay.querySelector('#radar-btn-agendar').addEventListener('click', () => {
        close();
        navigateTo('visit-new', {
            prefill: { Cliente: cliente.nomeFantasia || cliente.nome, Cidade: cliente.cidade },
            radarClienteId: cliente.id
        });
    });
}

function openRecusarModal(cliente, refresh) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left">
            <h3 style="margin-top:0">Recusou / não quer</h3>
            <p class="helper-text" style="text-align:left">${escapeHtml(cliente.nomeFantasia || cliente.nome || '')}</p>
            <div class="form-group full-width">
                <label for="radar-motivo">Motivo (opcional)</label>
                <textarea id="radar-motivo" rows="3" placeholder="Ex: já tem fornecedor, não teve interesse..."></textarea>
            </div>
            <div class="form-group full-width">
                <label for="radar-retorno">Retornar em (opcional)</label>
                <input type="date" id="radar-retorno">
                <div style="display:flex;gap:0.4rem;margin-top:0.4rem">
                    <button type="button" class="mini-button" data-shortcut="3">+3 meses</button>
                    <button type="button" class="mini-button" data-shortcut="6">+6 meses</button>
                </div>
            </div>
            <div class="form-actions">
                <button type="button" class="secondary-button" id="radar-recusar-cancelar">Cancelar</button>
                <button type="button" class="primary-button" id="radar-recusar-salvar">Salvar</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#radar-recusar-cancelar').addEventListener('click', close);
    overlay.querySelectorAll('[data-shortcut]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const months = Number(btn.dataset.shortcut);
            const d = new Date();
            d.setMonth(d.getMonth() + months);
            document.getElementById('radar-retorno').value = d.toISOString().slice(0, 10);
        });
    });

    overlay.querySelector('#radar-recusar-salvar').addEventListener('click', async () => {
        const btn = overlay.querySelector('#radar-recusar-salvar');
        setSaving(true, btn, 'Salvando...');
        const motivo = document.getElementById('radar-motivo').value.trim();
        const retorno = document.getElementById('radar-retorno').value;
        const result = await callAPI('updateRadarClienteStatus', {
            user: state.currentUser, id: cliente.id, status: 'recusado', motivo, retornoPrevisto: retorno || undefined
        });
        if (result.status === 'success') {
            cliente.status = 'recusado';
            showToast('Marcado como recusado.');
            close();
            refresh();
        } else {
            showToast(result.message || 'Não foi possível atualizar.', true);
            setSaving(false, btn);
        }
    });
}

function openSolicitarCidadeModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left">
            <h3 style="margin-top:0">Solicitar cidade</h3>
            <div class="form-group full-width">
                <label for="radar-sol-cidade">Cidade *</label>
                <input type="text" id="radar-sol-cidade" placeholder="Nome da cidade">
            </div>
            <div class="form-group full-width">
                <label for="radar-sol-uf">UF</label>
                <input type="text" id="radar-sol-uf" placeholder="Ex: SP" maxlength="2" style="text-transform:uppercase">
            </div>
            <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.87rem;cursor:pointer;margin-bottom:0.5rem">
                <input type="checkbox" id="radar-sol-urgente" style="width:auto">
                Urgente
            </label>
            <div class="form-actions">
                <button type="button" class="secondary-button" id="radar-sol-cancelar">Cancelar</button>
                <button type="button" class="primary-button" id="radar-sol-salvar">Enviar</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#radar-sol-cancelar').addEventListener('click', close);
    overlay.querySelector('#radar-sol-salvar').addEventListener('click', async () => {
        const btn = overlay.querySelector('#radar-sol-salvar');
        const cidade = document.getElementById('radar-sol-cidade').value.trim();
        if (!cidade) { showToast('Informe a cidade.', true); return; }
        setSaving(true, btn, 'Enviando...');
        const uf = document.getElementById('radar-sol-uf').value.trim();
        const urgente = document.getElementById('radar-sol-urgente').checked;
        const result = await callAPI('createRadarSolicitacaoCidade', { user: state.currentUser, cidade, uf, urgente });
        if (result.status === 'success') {
            showToast('Solicitação enviada.');
            close();
        } else {
            showToast(result.message || 'Não foi possível enviar a solicitação.', true);
            setSaving(false, btn);
        }
    });
}
