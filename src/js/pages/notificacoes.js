import { state, navigateTo } from '../app.js';
import { callAPI, ensureFormData, getDashboardData } from '../api.js';
import { escapeHtml, isAdminOrGerenteUser } from '../utils/format.js';
import { showToast, setSaving, skeletonList, addScrollTop, initializeSearchableInput } from '../utils/dom.js';
import { renderBreadcrumb, updateNotificacoesBadge } from '../utils/ui.js';

// Tela central de avisos: o histórico de notificações (campanha criada,
// aviso manual do admin — ver lib/handlers/push.js) + as "pendências"
// vivas (atrasos de Proposta/Funil, Clientes Principais sem relatório no
// mês) que já eram calculadas pro Dashboard, só que reaproveitadas aqui
// num lugar central em vez de espalhadas.
export async function renderNotificacoesPage() {
    const main = document.getElementById('main-content');
    main.innerHTML = skeletonList(4);

    const [notifResult, dashResult] = await Promise.all([
        callAPI('getNotificacoes', { user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message })),
        getDashboardData().catch(() => null)
    ]);

    if (!notifResult || notifResult.status !== 'success') {
        main.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔔</span><p>${escapeHtml((notifResult && notifResult.message) || 'Não foi possível carregar as notificações.')}</p>
            <button type="button" class="secondary-button" id="notif-retry">Tentar novamente</button></div>`;
        document.getElementById('notif-retry')?.addEventListener('click', () => navigateTo('notificacoes'));
        return;
    }

    const notificacoes = notifResult.notificacoes || [];
    updateNotificacoesBadge(notifResult.naoLidas || 0);

    const d = (dashResult && dashResult.status === 'success' && dashResult.data) || {};
    const pendCP = (d.clientesPrincipaisPendentes || []).length;
    const pendencias = [
        d.overdueProposals ? { label: `${d.overdueProposals} proposta${d.overdueProposals > 1 ? 's' : ''} atrasada${d.overdueProposals > 1 ? 's' : ''}`, page: 'proposals' } : null,
        d.overdueFunil ? { label: `${d.overdueFunil} oportunidade${d.overdueFunil > 1 ? 's' : ''} no Funil sem atualização`, page: 'funil' } : null,
        pendCP ? { label: `${pendCP} cliente${pendCP > 1 ? 's' : ''} principal${pendCP > 1 ? 'is' : ''} sem relatório de manutenção este mês`, page: 'dashboard' } : null
    ].filter(Boolean);

    const notifRow = (n) => `
        <div class="card camp-card${n.lida ? '' : ' notif-unread'}" data-notif-id="${escapeHtml(n.id)}" style="cursor:pointer">
            <div class="camp-card-head">
                <strong>${escapeHtml(n.titulo || 'Notificação')}</strong>
                ${!n.lida ? '<span class="camp-tag-ok" style="background:var(--info-bg);color:var(--info)">Nova</span>' : ''}
            </div>
            ${n.corpo ? `<p class="helper-text" style="margin:0.2rem 0 0">${escapeHtml(n.corpo)}</p>` : ''}
            <p class="helper-text" style="margin:0.3rem 0 0;font-size:0.72rem">${escapeHtml(n.criadaEm || '')}</p>
        </div>`;

    main.innerHTML = `
        ${renderBreadcrumb([{ label: 'Início', page: 'dashboard' }, { label: 'Notificações' }])}
        <div class="page-header">
            <div><h2>Notificações</h2><p class="page-subtitle">${notificacoes.length} no histórico${notifResult.naoLidas ? ` · ${notifResult.naoLidas} nova${notifResult.naoLidas > 1 ? 's' : ''}` : ''}</p></div>
            <div class="page-header-actions">
                ${isAdminOrGerenteUser() ? '<button type="button" class="mini-button" id="notif-compose">+ Nova notificação</button>' : ''}
                ${notifResult.naoLidas ? '<button type="button" class="mini-button" id="notif-marcar-todas">Marcar todas como lidas</button>' : ''}
            </div>
        </div>

        ${pendencias.length ? `
        <div class="card push-banner" style="align-items:flex-start;flex-direction:column">
            <strong style="font-size:0.85rem">📌 Pendências</strong>
            <div style="display:flex;flex-direction:column;gap:0.3rem;margin-top:0.4rem;width:100%">
                ${pendencias.map((p) => `<button type="button" class="notif-pend-item" data-page="${p.page}">${escapeHtml(p.label)} →</button>`).join('')}
            </div>
        </div>` : ''}

        ${notificacoes.length === 0
            ? '<div class="empty-state"><span class="empty-state-icon">🔔</span><p>Nenhuma notificação ainda.</p></div>'
            : `<div class="camp-cards">${notificacoes.map(notifRow).join('')}</div>`}
    `;

    main.querySelectorAll('.notif-pend-item').forEach((btn) => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.page));
    });

    main.querySelectorAll('[data-notif-id]').forEach((row) => {
        row.addEventListener('click', async () => {
            const n = notificacoes.find((x) => x.id === row.dataset.notifId);
            if (n && !n.lida) {
                callAPI('marcarNotificacaoLida', { id: n.id, user: state.currentUser }).catch(() => {});
            }
            navigateTo((n && n.page) || 'dashboard', (n && n.params) || {});
        });
    });

    document.getElementById('notif-marcar-todas')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        setSaving(true, btn, 'Marcando...');
        await callAPI('marcarNotificacaoLida', { all: true, user: state.currentUser }).catch(() => {});
        navigateTo('notificacoes');
    });

    document.getElementById('notif-compose')?.addEventListener('click', openComposeNotificationModal);

    addScrollTop();
}

async function openComposeNotificationModal() {
    const fd = await ensureFormData().then((r) => r.data).catch(() => null);
    const vendedores = ((fd && fd.vendedores) || []).filter((v) => v.nome).map((v) => v.nome);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left;max-width:420px">
            <h3 style="margin-top:0">🔔 Nova notificação</h3>
            <div class="form-group full-width">
                <label for="cn-destinatario">Destinatário</label>
                <div class="searchable-select">
                    <input type="text" id="cn-destinatario" placeholder="Busque o vendedor/gerente" autocomplete="off">
                    <div class="searchable-select-menu" id="cn-destinatario-menu"></div>
                </div>
            </div>
            <div class="form-group full-width">
                <label for="cn-title">Título (opcional)</label>
                <input type="text" id="cn-title" placeholder="🔔 Aviso do administrador" maxlength="80">
            </div>
            <div class="form-group full-width">
                <label for="cn-body">Mensagem</label>
                <textarea id="cn-body" rows="4" placeholder="Ex.: Preciso que você atualize o Funil hoje ainda." maxlength="300"></textarea>
            </div>
            <div class="form-actions full-width" style="display:flex;gap:0.5rem">
                <button type="button" class="secondary-button" id="cn-cancel">Fechar</button>
                <button type="button" class="primary-button" id="cn-send">Enviar</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#cn-cancel').addEventListener('click', close);

    initializeSearchableInput({
        input: overlay.querySelector('#cn-destinatario'),
        menu: overlay.querySelector('#cn-destinatario-menu'),
        items: vendedores,
        allowFreeText: false
    });

    overlay.querySelector('#cn-send').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const destinatario = overlay.querySelector('#cn-destinatario').value.trim();
        if (!destinatario) { showToast('Escolha o destinatário.', true); return; }
        const body = overlay.querySelector('#cn-body').value.trim();
        if (!body) { showToast('Escreva a mensagem.', true); return; }
        const title = overlay.querySelector('#cn-title').value.trim();
        setSaving(true, btn, 'Enviando...');
        const r = await callAPI('sendPushNotification', { toEmail: destinatario, title, body, user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
        if (r && r.status === 'success') {
            showToast(r.message || 'Notificação enviada.');
            close();
            navigateTo('notificacoes');
        } else {
            showToast((r && r.message) || 'Não foi possível enviar.', true);
            setSaving(false, btn);
        }
    });
}
