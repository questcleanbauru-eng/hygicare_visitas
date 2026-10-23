import { state } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData } from '../api.js';
import { escapeHtml, resolveNotifyOptions, multiCheckFilterFieldHtml } from '../utils/format.js';
import { showToast, setSaving, loadingState, addScrollTop, wireMultiCheckFilter } from '../utils/dom.js';
import { initPullToRefresh, ensureStyles } from '../utils/ui.js';

// "Lembretes administrativos" — pedido explícito do Bruno: usar o robô de
// WhatsApp como agenda/lembrete pra cobrar o time administrativo de algo
// (ex.: "comprar tal coisa todo mês", "mandar nota fiscal"), sem misturar
// isso com Agendamentos (que é retorno de visita a cliente, entra nos
// relatórios/contagens de vendedor). Só admin cria; quem está marcado como
// destinatário vê e pode concluir/cancelar o que é dele. Lista simples (sem
// filtros/busca — volume baixo por natureza) com um modal de criação.

function statusLabel(l) {
    if (l.status === 'Concluido') return 'Concluído';
    if (l.status === 'Cancelado') return 'Cancelado';
    const d = parseDisplayDateLocal(l.dataAlvo);
    if (d) {
        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
        if (d < hoje) return 'Atrasado';
        if (d.getTime() === hoje.getTime()) return 'Hoje';
    }
    return 'Pendente';
}

function statusClass(l) {
    if (l.status === 'Concluido') return 'pedido';
    if (l.status === 'Cancelado') return 'erro';
    const label = statusLabel(l);
    if (label === 'Atrasado') return 'erro';
    if (label === 'Hoje') return 'apresentacao';
    return 'preventiva';
}

function parseDisplayDateLocal(value) {
    if (!value || String(value).indexOf('/') === -1) return null;
    const [d, m, y] = String(value).split('/');
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    date.setHours(0, 0, 0, 0);
    return isNaN(date) ? null : date;
}

export async function getLembretesAdmin() {
    try {
        const r = await callAPI('getLembretesAdmin', { user: state.currentUser });
        if (r.status === 'success') { saveCache('lembretesAdmin', r.lembretes || []); }
        return r;
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

export async function renderLembretesPage() {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    const cached = loadCache('lembretesAdmin');
    if (cached) {
        state.lembretesAdmin = cached;
        fillLembretesContent(mainContent, state.lembretesAdmin);
        addScrollTop();
        initPullToRefresh(async () => { await refreshLembretes(); });
        getLembretesAdmin().then((r) => {
            if (r.status === 'success' && state.currentPage === 'lembretes') {
                state.lembretesAdmin = r.lembretes || [];
                fillLembretesContent(document.getElementById('main-content'), state.lembretesAdmin);
            }
        });
        return;
    }
    mainContent.innerHTML = loadingState('📌', 'Carregando lembretes...');
    const result = await getLembretesAdmin();
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar lembretes.')}</p>`;
        return;
    }
    state.lembretesAdmin = result.lembretes || [];
    fillLembretesContent(mainContent, state.lembretesAdmin);
    addScrollTop();
    initPullToRefresh(async () => { await refreshLembretes(); });
}

async function refreshLembretes() {
    const r = await getLembretesAdmin();
    if (r.status === 'success' && state.currentPage === 'lembretes') {
        state.lembretesAdmin = r.lembretes || [];
        const el = document.getElementById('main-content');
        if (el) fillLembretesContent(el, state.lembretesAdmin);
    }
}

function lembreteCardHtml(l, { isAdmin, podeAgir }) {
    const badgeRecorrencia = l.recorrencia === 'mensal' ? '<span class="status-tag preventiva" title="Repete todo mês">🔁 Mensal</span>' : '';
    const acoes = [];
    if (podeAgir && l.status === 'Pendente') {
        acoes.push(`<button type="button" class="text-link" data-lembrete-concluir="${escapeHtml(l.id)}">✅ Concluir</button>`);
        acoes.push(`<button type="button" class="text-link" data-lembrete-cancelar="${escapeHtml(l.id)}">Cancelar</button>`);
    }
    if (isAdmin) {
        acoes.push(`<button type="button" class="text-link" data-lembrete-apagar="${escapeHtml(l.id)}">🗑️ Apagar</button>`);
    }
    return `
        <div class="card" data-lembrete-id="${escapeHtml(l.id)}" style="margin-bottom:0.5rem">
            <div class="item-top">
                <span class="item-name">${escapeHtml(l.texto || '-')}</span>
                <span class="status-tag ${statusClass(l)}">${statusLabel(l)}</span>
            </div>
            <div class="item-meta">${escapeHtml(['📅 ' + (l.dataAlvo || '-'), '👤 ' + (l.destinatarios || []).join(', ')].filter(Boolean).join(' · '))} ${badgeRecorrencia}</div>
            ${acoes.length ? `<div style="display:flex;gap:0.9rem;margin-top:0.5rem;flex-wrap:wrap">${acoes.join('')}</div>` : ''}
        </div>`;
}

function fillLembretesContent(mainContent, lembretes) {
    const isAdmin = String(state.currentUser?.profile || '').trim().toLowerCase() === 'admin';
    const userName = String(state.currentUser?.name || '').trim().toLowerCase();
    const podeAgirEm = (l) => isAdmin || (l.destinatarios || []).some((d) => String(d).trim().toLowerCase() === userName);

    const pendentes = [...lembretes]
        .filter((l) => l.status === 'Pendente')
        .sort((a, b) => (parseDisplayDateLocal(a.dataAlvo)?.getTime() || 0) - (parseDisplayDateLocal(b.dataAlvo)?.getTime() || 0));
    const historico = [...lembretes]
        .filter((l) => l.status !== 'Pendente')
        .sort((a, b) => (parseDisplayDateLocal(b.dataAlvo)?.getTime() || 0) - (parseDisplayDateLocal(a.dataAlvo)?.getTime() || 0));

    mainContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Lembretes</h2>
                <p class="page-subtitle">Avisos recorrentes pro time administrativo, via WhatsApp</p>
            </div>
            ${isAdmin ? '<button class="primary-btn" id="btn-new-lembrete" type="button">+ Novo Lembrete</button>' : ''}
        </div>
        ${pendentes.length === 0 && historico.length === 0 ? `
            <div class="empty-state">
                <span class="empty-state-icon">📌</span>
                <p>Nenhum lembrete ${isAdmin ? 'criado' : 'atribuído a você'} ainda.</p>
            </div>
        ` : `
            <p class="section-label">Pendentes</p>
            ${pendentes.length
                ? pendentes.map((l) => lembreteCardHtml(l, { isAdmin, podeAgir: podeAgirEm(l) })).join('')
                : '<p class="helper-text" style="text-align:center;padding:0.5rem 0">Nenhum lembrete pendente.</p>'}
            ${historico.length ? `
                <p style="margin:0.75rem 0 0.4rem">
                    <span class="text-link" role="button" tabindex="0" id="lembretes-historico-toggle">👁️ Mostrar histórico (${historico.length})</span>
                </p>
                <div id="lembretes-historico" hidden>
                    ${historico.map((l) => lembreteCardHtml(l, { isAdmin, podeAgir: false })).join('')}
                </div>
            ` : ''}
        `}
    `;

    document.getElementById('btn-new-lembrete')?.addEventListener('click', () => openCreateLembreteModal());

    document.getElementById('lembretes-historico-toggle')?.addEventListener('click', () => {
        const el = document.getElementById('lembretes-historico');
        const toggle = document.getElementById('lembretes-historico-toggle');
        el.hidden = !el.hidden;
        toggle.textContent = el.hidden ? `👁️ Mostrar histórico (${historico.length})` : '🙈 Ocultar histórico';
    });

    mainContent.querySelectorAll('[data-lembrete-concluir]').forEach((btn) => {
        btn.addEventListener('click', () => atualizarStatusLembrete(btn.dataset.lembreteConcluir, 'Concluido', btn));
    });
    mainContent.querySelectorAll('[data-lembrete-cancelar]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!confirm('Cancelar este lembrete? Se for mensal, a série para aqui (não gera o próximo mês).')) return;
            atualizarStatusLembrete(btn.dataset.lembreteCancelar, 'Cancelado', btn);
        });
    });
    mainContent.querySelectorAll('[data-lembrete-apagar]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Apagar este lembrete? Essa ação não pode ser desfeita.')) return;
            setSaving(true, btn, '');
            const r = await callAPI('deleteLembreteAdmin', { id: btn.dataset.lembreteApagar, user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
            if (r && r.status === 'success') {
                state.lembretesAdmin = (state.lembretesAdmin || []).filter((x) => String(x.id) !== String(btn.dataset.lembreteApagar));
                saveCache('lembretesAdmin', state.lembretesAdmin);
                showToast('Lembrete apagado.');
                fillLembretesContent(mainContent, state.lembretesAdmin);
            } else {
                showToast((r && r.message) || 'Não foi possível apagar.', true);
                setSaving(false, btn);
            }
        });
    });
}

async function atualizarStatusLembrete(id, status, btn) {
    setSaving(true, btn, '');
    const r = await callAPI('updateLembreteAdmin', { id, status, user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
    if (r && r.status === 'success') {
        const idx = (state.lembretesAdmin || []).findIndex((x) => String(x.id) === String(id));
        if (idx >= 0) state.lembretesAdmin[idx] = r.lembrete;
        if (r.proximo) state.lembretesAdmin.push(r.proximo);
        saveCache('lembretesAdmin', state.lembretesAdmin);
        showToast(status === 'Concluido'
            ? (r.proximo ? 'Lembrete concluído — próximo mês já agendado.' : 'Lembrete concluído.')
            : 'Lembrete cancelado.');
        const mainContent = document.getElementById('main-content');
        if (mainContent) fillLembretesContent(mainContent, state.lembretesAdmin);
    } else {
        showToast((r && r.message) || 'Não foi possível salvar.', true);
        setSaving(false, btn);
    }
}

async function openCreateLembreteModal() {
    const formDataResult = await ensureFormData();
    const vendedoresAll = (formDataResult.data && formDataResult.data.vendedores) || [];
    const notifyOptions = resolveNotifyOptions(vendedoresAll, state.currentUser);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 1);
    overlay.innerHTML = `
        <div class="modal-card newag-modal">
            <div class="newag-modal-header">
                <span class="newag-modal-header-icon" aria-hidden="true">📌</span>
                <h3>Novo lembrete</h3>
                <button type="button" class="newag-modal-close" id="lembrete-close" aria-label="Fechar">✕</button>
            </div>
            <div class="newag-modal-body">
                <div class="form-group full-width">
                    <label for="lembrete-texto">Lembrete *</label>
                    <textarea id="lembrete-texto" rows="2" placeholder="Ex.: Comprar etiquetas, Enviar nota fiscal da Unimed"></textarea>
                </div>
                <div class="form-group full-width">
                    <label for="lembrete-data">Data *</label>
                    <input type="date" id="lembrete-data" value="${defaultDate.toISOString().slice(0, 10)}">
                </div>
                <div class="form-group full-width">
                    <label class="newag-repetir-row">
                        <input type="checkbox" id="lembrete-mensal" style="width:auto;min-height:0">
                        🔁 Repetir todo mês
                    </label>
                    <p class="helper-text" style="text-align:left;margin:0.2rem 0 0">Ao concluir, o próximo mês já é criado sozinho — cancelar em vez de concluir encerra a série.</p>
                </div>
                ${multiCheckFilterFieldHtml('Destinatário(s) *', 'lembrete-destinatarios')}
            </div>
            <div class="newag-modal-footer">
                <button type="button" class="secondary-button" id="lembrete-cancel">Cancelar</button>
                <button type="button" class="primary-button" id="lembrete-save">Salvar lembrete</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    wireMultiCheckFilter({
        triggerId: 'lembrete-destinatarios-trigger', inputId: 'lembrete-destinatarios', menuId: 'lembrete-destinatarios-menu',
        options: notifyOptions, emptyLabel: 'Escolha...'
    });

    const close = () => overlay.remove();
    overlay.querySelector('#lembrete-close').addEventListener('click', close);
    overlay.querySelector('#lembrete-cancel').addEventListener('click', close);

    overlay.querySelector('#lembrete-save').addEventListener('click', async () => {
        const btn = overlay.querySelector('#lembrete-save');
        const texto = overlay.querySelector('#lembrete-texto').value.trim();
        const dataVal = overlay.querySelector('#lembrete-data').value;
        const destinatariosVal = (overlay.querySelector('#lembrete-destinatarios').value || '').split(',').filter(Boolean);
        if (!texto) { showToast('Escreva o lembrete.', true); return; }
        if (!dataVal) { showToast('Informe a data.', true); return; }
        if (!destinatariosVal.length) { showToast('Escolha quem deve receber.', true); return; }
        const recorrencia = overlay.querySelector('#lembrete-mensal').checked ? 'mensal' : '';

        setSaving(true, btn, 'Salvando...');
        const r = await callAPI('createLembreteAdmin', {
            texto, dataAlvo: dataVal, destinatarios: destinatariosVal, recorrencia, user: state.currentUser
        }).catch((e) => ({ status: 'error', message: e.message }));
        if (r && r.status === 'success') {
            state.lembretesAdmin = [r.lembrete, ...(state.lembretesAdmin || [])];
            saveCache('lembretesAdmin', state.lembretesAdmin);
            showToast('Lembrete criado.');
            close();
            const mainContent = document.getElementById('main-content');
            if (mainContent) fillLembretesContent(mainContent, state.lembretesAdmin);
        } else {
            showToast((r && r.message) || 'Não foi possível salvar.', true);
            setSaving(false, btn);
        }
    });
}
