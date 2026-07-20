import { state, navigateTo } from '../app.js';
import { callAPI } from '../api.js';
import { escapeHtml } from '../utils/format.js';
import { debounce, initializeSearchableInput, showToast, loadingState, setSaving } from '../utils/dom.js';
import { ensureStyles } from '../utils/ui.js';

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
        </div>
        <div class="radar-tab-panel${activeRadarTab === 'buscar' ? ' active' : ''}" id="radar-tab-buscar">
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

    await renderBuscarTab();

    if (activeRadarTab === 'historico') {
        historicoLoaded = true;
        await loadHistorico();
        if (isAdmin) { await loadSolicitacoes(); }
    }
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

    initializeSearchableInput({
        input: cidadeInput,
        menu: cidadeMenu,
        items: cidades.map(cidadeLabel),
        onSelect: async (value) => {
            const match = cidades.find((c) => cidadeLabel(c) === value);
            if (!match) return;

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
        }
    });

    segmentoInput.addEventListener('input', debounce(() => renderRadarResults(resultsEl), 250));
}

function renderRadarResults(resultsEl) {
    const segmento = document.getElementById('radar-segmento')?.value.trim().toLowerCase() || '';
    const filtered = segmento
        ? currentClientes.filter((c) =>
            String(c.cnaeDescricao || '').toLowerCase().includes(segmento) ||
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
            <button type="button" class="proposal-card" data-radar-id="${escapeHtml(c.id)}">
                <div class="visit-card-header">
                    <strong>${escapeHtml(c.nomeFantasia || c.nome || 'Empresa')}</strong>
                    <span class="${STATUS_CLASSES[c.status] || 'status-pill'}">${escapeHtml(STATUS_LABELS[c.status] || c.status)}</span>
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(c.cnaeDescricao || '-')}</span>
                    <span>${escapeHtml(cidadeLabel(c))}</span>
                </div>
                ${c.status === 'recusado' && c.statusRetornoPrevisto
                    ? `<div class="proposal-meta"><span>Retornar em: ${escapeHtml(c.statusRetornoPrevisto)}</span></div>`
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

function openRadarDetailCard(cliente, onUpdated) {
    const refresh = onUpdated || rerenderRadarList;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left">
            <h3 style="margin-top:0">${escapeHtml(cliente.nomeFantasia || cliente.nome || 'Empresa')}</h3>
            ${cliente.nomeFantasia && cliente.nome && cliente.nomeFantasia !== cliente.nome
                ? `<p class="helper-text" style="margin:0 0 0.5rem;text-align:left">${escapeHtml(cliente.nome)}</p>` : ''}
            <p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(cidadeLabel(cliente))}</p>
            <p class="helper-text" style="text-align:left;margin:0 0 0.85rem">${escapeHtml(cliente.cnaeDescricao || '-')}</p>
            <span class="${STATUS_CLASSES[cliente.status] || 'status-pill'}" style="margin-bottom:1rem;display:inline-block">${escapeHtml(STATUS_LABELS[cliente.status] || cliente.status)}</span>
            <div class="form-actions" style="flex-direction:column;gap:0.5rem;margin-top:0.5rem">
                <button type="button" class="primary-button" id="radar-btn-atendido">Já é atendido</button>
                <button type="button" class="mini-button-danger" style="width:100%;padding:0.7rem;border-radius:var(--radius-sm)" id="radar-btn-recusou">Recusou / não quer</button>
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
