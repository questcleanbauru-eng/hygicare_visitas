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

// Lista da cidade atualmente carregada — vive só neste módulo (não em
// `state`), já que o Radar não segue o padrão "carrega tudo" do resto do
// app (é filtrado por cidade no servidor), então não faz sentido tratar
// como uma lista global igual state.visits/state.proposals.
let currentClientes = [];

function cidadeLabel(c) {
    return c.uf ? `${c.cidade} - ${c.uf}` : c.cidade;
}

export async function renderRadarPage() {
    ensureStyles('radar');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        <div class="page-header">
            <div><h2>Radar de Clientes</h2><p class="page-subtitle">Encontre empresas por cidade pra prospectar</p></div>
        </div>
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
    `;

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
            segmentoGroup.style.display = '';
            segmentoInput.value = '';
            renderRadarResults(resultsEl);
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

    if (filtered.length === 0) {
        resultsEl.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhuma empresa encontrada.</p></div>`;
        return;
    }

    // Prioriza quem nunca foi contatado — é literalmente o objetivo do Radar.
    const priority = { buscado: 0, prospeccao_agendada: 1, recusado: 2, ja_atendido: 3 };
    const sorted = [...filtered].sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));

    resultsEl.innerHTML = `
        <p class="page-subtitle" style="margin-bottom:0.5rem">${filtered.length} empresa(s)</p>
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
            const cliente = currentClientes.find((c) => String(c.id) === btn.dataset.radarId);
            if (cliente) openRadarDetailCard(cliente);
        });
    });
}

function rerenderRadarList() {
    const el = document.getElementById('radar-results');
    if (el) renderRadarResults(el);
}

function openRadarDetailCard(cliente) {
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
            rerenderRadarList();
        } else {
            showToast(result.message || 'Não foi possível atualizar.', true);
            setSaving(false, btn);
        }
    });

    overlay.querySelector('#radar-btn-recusou').addEventListener('click', () => {
        close();
        openRecusarModal(cliente);
    });

    overlay.querySelector('#radar-btn-agendar').addEventListener('click', () => {
        close();
        navigateTo('visit-new', {
            prefill: { Cliente: cliente.nomeFantasia || cliente.nome, Cidade: cliente.cidade },
            radarClienteId: cliente.id
        });
    });
}

function openRecusarModal(cliente) {
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
            rerenderRadarList();
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
