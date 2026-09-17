import { state, navigateTo } from '../app.js';
import { callAPI, ensureFormData, getDashboardData } from '../api.js';
import { escapeHtml, isAdminOrGerenteUser, getInitials } from '../utils/format.js';
import { showToast, setSaving, skeletonList, addScrollTop, initializeSearchableInput } from '../utils/dom.js';
import { renderBreadcrumb, updateNotificacoesBadge } from '../utils/ui.js';

// Tela central de avisos: o histórico de notificações (campanha criada,
// aviso manual do admin — ver lib/handlers/push.js) + as "pendências"
// vivas de quem está logado (atrasos de Proposta/Funil, Clientes
// Principais sem relatório no mês) +, só pra admin/gerente, a MESMA
// pendência mas quebrada por vendedor/gerente (ver
// handleGetPendenciasPorVendedor em dashboard.js), com chips clicáveis
// que notificam só aquele item específico (ou "Notificar tudo" pra
// mandar todas as pendências daquela pessoa de uma vez).

// Cada tipo de pendência de vendedor: como ler a contagem do registro
// vindo do backend, o texto do chip, a cor semântica e pra onde "Ver →"
// leva. Uma fonte só usada tanto pros chips da lista por vendedor quanto
// (parcialmente) pro resumo pessoal "Suas pendências" no topo.
const PEND_KINDS = [
    { key: 'overdueProposals', isArray: false, color: 'amber', icon: '📄', page: 'proposals',
        label: (n) => `${n} proposta${n > 1 ? 's' : ''} atrasada${n > 1 ? 's' : ''}` },
    { key: 'overdueFunil', isArray: false, color: 'orange', icon: '📊', page: 'funil',
        label: (n) => `${n} oportunidade${n > 1 ? 's' : ''} no Funil sem atualização` },
    { key: 'campanhasPendentes', isArray: true, color: 'blue', icon: '🔗', page: 'campanhas',
        label: (n) => `${n} campanha${n > 1 ? 's' : ''} aguardando resposta` },
    { key: 'clientesPrincipaisPendentes', isArray: true, color: 'red', icon: '⭐', page: 'dashboard',
        label: (n) => `${n} cliente${n > 1 ? 's' : ''} principal${n > 1 ? 'is' : ''} sem relatório este mês` }
];

function kindCount(v, kind) {
    const raw = v[kind.key];
    return kind.isArray ? (raw || []).length : (raw || 0);
}

export async function renderNotificacoesPage() {
    const main = document.getElementById('main-content');
    main.innerHTML = skeletonList(4);
    const isGestor = isAdminOrGerenteUser();

    // getPendenciasPorVendedor é a chamada mais pesada (lê várias abas) —
    // sequenciada depois das outras duas, em vez de tudo num Promise.all só,
    // pra não empilhar 3 leituras pesadas ao mesmo tempo na planilha (isso
    // já chegou a estourar a cota de requisições do Sheets).
    const [notifResult, dashResult] = await Promise.all([
        callAPI('getNotificacoes', { user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message })),
        getDashboardData().catch(() => null)
    ]);
    const pendResult = isGestor
        ? await callAPI('getPendenciasPorVendedor', { user: state.currentUser }).catch(() => null)
        : null;

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
    const minhasPendencias = [
        d.overdueProposals ? { icon: '📄', count: d.overdueProposals, label: `proposta${d.overdueProposals > 1 ? 's' : ''} atrasada${d.overdueProposals > 1 ? 's' : ''}`, page: 'proposals' } : null,
        d.overdueFunil ? { icon: '📊', count: d.overdueFunil, label: `oportunidade${d.overdueFunil > 1 ? 's' : ''} no Funil sem atualização`, page: 'funil' } : null,
        pendCP ? { icon: '⭐', count: pendCP, label: `cliente${pendCP > 1 ? 's' : ''} principal${pendCP > 1 ? 'is' : ''} sem relatório este mês`, page: 'dashboard' } : null
    ].filter(Boolean);

    const vendedoresPend = (pendResult && pendResult.status === 'success') ? pendResult.vendedores || [] : [];
    const unidades = Array.from(new Set(vendedoresPend.map((v) => v.gerencia).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const totalPendenciasAtivas = isGestor
        ? vendedoresPend.reduce((sum, v) => sum + v.total, 0)
        : minhasPendencias.reduce((sum, p) => sum + p.count, 0);

    // ── Resumo pessoal ("Suas pendências") — cards clicáveis, não texto corrido ──
    const summaryCardHtml = (p) => `
        <button type="button" class="notif-summary-card" data-page="${p.page}">
            <span class="notif-summary-icon" aria-hidden="true">${p.icon}</span>
            <span class="notif-summary-count">${p.count}</span>
            <span class="notif-summary-label">${escapeHtml(p.label)}</span>
            <span class="notif-summary-cta">Ver →</span>
        </button>`;

    // ── Histórico ── (classe própria — .camp-card é usado em outras telas
    // e é só sombra, sem borda; aqui precisa da mesma linguagem visual dos
    // cards/linhas acima, senão desaparece contra o fundo)
    const notifRow = (n) => `
        <div class="notif-history-row${n.lida ? '' : ' notif-history-row-unread'}" data-notif-id="${escapeHtml(n.id)}">
            <div class="notif-history-head">
                <strong>${escapeHtml(n.titulo || 'Notificação')}</strong>
                ${!n.lida ? '<span class="notif-history-badge">Nova</span>' : ''}
            </div>
            ${n.corpo ? `<p class="notif-history-body">${escapeHtml(n.corpo)}</p>` : ''}
            <p class="notif-history-date">${escapeHtml(n.criadaEm || '')}</p>
        </div>`;

    // ── Linha compacta por vendedor/gerente ──
    const vendorRowHtml = (v) => {
        const chips = PEND_KINDS.map((kind) => {
            const n = kindCount(v, kind);
            if (!n) return '';
            return `<button type="button" class="notif-chip notif-chip-${kind.color}" data-notify-vendor="${escapeHtml(v.nome)}" data-notify-kind="${kind.key}" aria-label="Notificar ${escapeHtml(v.nome)} sobre ${escapeHtml(kind.label(n))}">
                <span class="notif-chip-bell" aria-hidden="true">🔔</span>${escapeHtml(kind.label(n))}
            </button>`;
        }).join('');
        return `
        <div class="notif-vendor-row${v.total ? '' : ' notif-vendor-row-ok'}">
            <div class="notif-vendor-header">
                <div class="notif-vendor-id">
                    <span class="notif-vendor-avatar" aria-hidden="true">${escapeHtml(getInitials(v.nome))}</span>
                    <span class="notif-vendor-name">${escapeHtml(v.nome)}</span>
                    ${v.gerencia ? `<span class="notif-vendor-unit">${escapeHtml(v.gerencia)}</span>` : ''}
                </div>
                ${v.total
                    ? `<div class="notif-vendor-actions">
                        <span class="notif-vendor-total" aria-label="${v.total} pendências no total">${v.total}</span>
                        <button type="button" class="text-link" data-notify-all="${escapeHtml(v.nome)}" aria-label="Notificar tudo pra ${escapeHtml(v.nome)}">Notificar tudo</button>
                    </div>`
                    : '<span class="camp-tag-ok">✓ Em dia</span>'}
            </div>
            ${v.total ? `<div class="notif-vendor-chips">${chips}</div>` : ''}
        </div>`;
    };

    const renderVendorList = () => {
        const container = document.getElementById('notif-vendor-list');
        if (!container) return;
        const search = (document.getElementById('notif-search')?.value || '').trim().toLowerCase();
        const unidade = document.getElementById('notif-unit-filter')?.value || '';
        const filtrados = vendedoresPend.filter((v) =>
            (!search || v.nome.toLowerCase().includes(search)) &&
            (!unidade || v.gerencia === unidade));
        container.innerHTML = filtrados.length
            ? filtrados.map(vendorRowHtml).join('')
            : '<p class="helper-text">Nenhum vendedor/gerente encontrado.</p>';
        wireVendorList(container);
    };

    const wireVendorList = (container) => {
        container.querySelectorAll('[data-notify-kind]').forEach((chip) => {
            chip.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const v = vendedoresPend.find((x) => x.nome === chip.dataset.notifyVendor);
                const kind = PEND_KINDS.find((k) => k.key === chip.dataset.notifyKind);
                if (!v || !kind) return;
                const n = kindCount(v, kind);
                const primeiroNome = v.nome.split(' ')[0];
                openComposeNotificationModal({
                    destinatario: v.nome,
                    body: `Oi ${primeiroNome}! Você está com ${kind.label(n)}. Por favor, atualize o quanto antes.`
                });
            });
        });
        container.querySelectorAll('[data-notify-all]').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const v = vendedoresPend.find((x) => x.nome === btn.dataset.notifyAll);
                if (!v) return;
                const partes = PEND_KINDS.map((k) => { const n = kindCount(v, k); return n ? k.label(n) : ''; }).filter(Boolean);
                const primeiroNome = v.nome.split(' ')[0];
                openComposeNotificationModal({
                    destinatario: v.nome,
                    body: `Oi ${primeiroNome}! Você está com pendências: ${partes.join(', ')}. Por favor, atualize o quanto antes.`
                });
            });
        });
    };

    main.innerHTML = `
        ${renderBreadcrumb([{ label: 'Início', page: 'dashboard' }, { label: 'Notificações' }])}
        <div class="page-header">
            <div>
                <h2>Notificações ${totalPendenciasAtivas ? `<span class="notif-header-badge">${totalPendenciasAtivas} pendência${totalPendenciasAtivas > 1 ? 's' : ''} ativa${totalPendenciasAtivas > 1 ? 's' : ''}</span>` : ''}</h2>
            </div>
            <div class="page-header-actions">
                ${notifResult.naoLidas ? '<button type="button" class="text-link" id="notif-marcar-todas">Marcar todas como lidas</button>' : ''}
                ${isGestor ? '<button type="button" class="primary-btn" id="notif-compose">+ Nova notificação</button>' : ''}
            </div>
        </div>

        ${minhasPendencias.length ? `
        <h3 class="dash-section-heading">SUAS PENDÊNCIAS</h3>
        <div class="notif-summary-grid">${minhasPendencias.map(summaryCardHtml).join('')}</div>` : ''}

        ${isGestor ? `
        <h3 class="dash-section-heading" style="margin-top:0.9rem">PENDÊNCIAS POR VENDEDOR/GERENTE</h3>
        ${vendedoresPend.length ? `
        <div class="notif-toolbar">
            <input type="text" id="notif-search" placeholder="Buscar por nome..." aria-label="Buscar vendedor por nome">
            ${unidades.length > 1 ? `<select id="notif-unit-filter" aria-label="Filtrar por unidade">
                <option value="">Todas as unidades</option>
                ${unidades.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('')}
            </select>` : ''}
        </div>
        <div class="notif-vendor-list" id="notif-vendor-list"></div>
        ` : '<p class="helper-text">Nenhum vendedor/gerente pra mostrar.</p>'}
        ` : ''}

        <h3 class="dash-section-heading" style="margin-top:0.9rem">HISTÓRICO <span class="helper-text" style="text-transform:none;font-weight:500">(${notificacoes.length}${notifResult.naoLidas ? ` · ${notifResult.naoLidas} nova${notifResult.naoLidas > 1 ? 's' : ''}` : ''})</span></h3>
        ${notificacoes.length === 0
            ? '<div class="empty-state"><span class="empty-state-icon">🔔</span><p>Nenhuma notificação ainda.</p></div>'
            : `<div class="camp-cards">${notificacoes.map(notifRow).join('')}</div>`}
    `;

    if (isGestor && vendedoresPend.length) {
        renderVendorList();
        document.getElementById('notif-search')?.addEventListener('input', renderVendorList);
        document.getElementById('notif-unit-filter')?.addEventListener('change', renderVendorList);
    }

    main.querySelectorAll('.notif-summary-card').forEach((btn) => {
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

    document.getElementById('notif-compose')?.addEventListener('click', () => openComposeNotificationModal());

    addScrollTop();
}

async function openComposeNotificationModal(prefill) {
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
                    <input type="text" id="cn-destinatario" placeholder="Busque o vendedor/gerente" autocomplete="off" value="${escapeHtml((prefill && prefill.destinatario) || '')}">
                    <div class="searchable-select-menu" id="cn-destinatario-menu"></div>
                </div>
            </div>
            <div class="form-group full-width">
                <label for="cn-title">Título (opcional)</label>
                <input type="text" id="cn-title" placeholder="🔔 Aviso do administrador" maxlength="80">
            </div>
            <div class="form-group full-width">
                <label for="cn-body">Mensagem</label>
                <textarea id="cn-body" rows="4" placeholder="Ex.: Preciso que você atualize o Funil hoje ainda." maxlength="300">${escapeHtml((prefill && prefill.body) || '')}</textarea>
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

    overlay.querySelector(prefill ? '#cn-body' : '#cn-destinatario').focus();

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
