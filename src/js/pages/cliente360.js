import { state, navigateTo } from '../app.js';
import { callAPI } from '../api.js';
import {
    escapeHtml, normalizeVisit, normalizeProposal, normalizeContrato, normalizeManutencao,
    compareVisitsByDateDesc, visitTypeIcon, proposalStatusIcon, funilStatusIcon,
    calculateDaysFromDisplayDate
} from '../utils/format.js';
import { renderBreadcrumb, ensureStyles } from '../utils/ui.js';
import { skeletonDetail } from '../utils/dom.js';

// Cliente 360°: agrega visitas/propostas/funil/contratos/manutenções de um
// mesmo cliente numa tela só. Não existe um Id de cliente confiável em
// todas as abas (só o nome do Cliente é comum a todas), então o "link"
// entre entidades é por nome (case-insensitive) — mesmo critério que a
// busca global já usa.
//
// Busca sempre fresca (dias:0 pra Visitas/Propostas/Funil, sem tocar no
// `state` global das outras páginas) em vez de reaproveitar o que já
// estiver carregado — o objetivo daqui é "histórico completo do cliente",
// não a janela recente que as listas normais mostram por padrão.
async function fetchAll(clienteNome) {
    const user = state.currentUser;
    const [visitsR, proposalsR, funilR, contratosR, manutencoesR] = await Promise.allSettled([
        callAPI('getVisits', { user, dias: 0 }),
        callAPI('getProposals', { user, dias: 0 }),
        callAPI('getFunil', { user, dias: 0 }),
        callAPI('getContratos', { user }),
        callAPI('getManutencoes', { user })
    ]);

    const matchName = (n) => String(n || '').trim().toLowerCase() === clienteNome.trim().toLowerCase();
    const ok = (r) => r.status === 'fulfilled' && r.value && r.value.status === 'success';

    const visits = ok(visitsR) ? (visitsR.value.visits || []).map(normalizeVisit).filter((v) => matchName(v.cliente))
        .sort(compareVisitsByDateDesc) : [];
    const proposals = ok(proposalsR) ? (proposalsR.value.proposals || []).map(normalizeProposal).filter((p) => matchName(p.cliente)) : [];
    const funil = ok(funilR) ? (funilR.value.funil || []).filter((f) => matchName(f.cliente)) : [];
    const contratos = ok(contratosR) ? (contratosR.value.contratos || []).map(normalizeContrato).filter((c) => matchName(c.cliente)) : [];
    const manutencoes = ok(manutencoesR) ? (manutencoesR.value.manutencoes || []).map(normalizeManutencao).filter((m) => matchName(m.cliente)) : [];

    return { visits, proposals, funil, contratos, manutencoes };
}

function inatividadeBadge(visits) {
    if (!visits.length) return '<span class="c360-badge c360-badge-neutral">Nenhuma visita registrada</span>';
    const dias = calculateDaysFromDisplayDate(visits[0].dataVisita);
    if (dias === null) return '';
    if (dias > 60) return `<span class="c360-badge c360-badge-danger">⚠️ Sem visita há ${dias} dias</span>`;
    if (dias > 30) return `<span class="c360-badge c360-badge-warning">Sem visita há ${dias} dias</span>`;
    return `<span class="c360-badge c360-badge-ok">Última visita há ${dias} dia${dias === 1 ? '' : 's'}</span>`;
}

export async function renderCliente360Page(options = {}) {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    const clienteNome = String(options.cliente || '').trim();
    if (!clienteNome) {
        mainContent.innerHTML = `<p class="error-message">Cliente não informado.</p>`;
        return;
    }

    mainContent.innerHTML = renderBreadcrumb([{ label: 'Cliente 360°' }]) + skeletonDetail(12);

    const { visits, proposals, funil, contratos, manutencoes } = await fetchAll(clienteNome);
    const cidade = visits[0]?.cidade || proposals[0]?.cidade || funil[0]?.cidade || contratos[0]?.cidade || manutencoes[0]?.cidade || '';

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Cliente 360°' }])}
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="c360-back">Voltar</button>
            <h2>${escapeHtml(clienteNome)}</h2>
        </div>
        <div class="card c360-summary-card">
            <div class="c360-summary-row">
                ${cidade ? `<span>${escapeHtml(cidade)}</span>` : ''}
                ${inatividadeBadge(visits)}
            </div>
            <div class="c360-stats-row">
                <div class="c360-stat"><strong>${visits.length}</strong><span>Visitas</span></div>
                <div class="c360-stat"><strong>${proposals.length}</strong><span>Propostas</span></div>
                <div class="c360-stat"><strong>${funil.length}</strong><span>Funil</span></div>
                <div class="c360-stat"><strong>${contratos.length}</strong><span>Contratos</span></div>
                <div class="c360-stat"><strong>${manutencoes.length}</strong><span>Manutenções</span></div>
            </div>
        </div>

        ${renderSection('Visitas', visits.length, visits.slice(0, 8).map((v) => `
            <button type="button" class="c360-item" data-type="visit-detail" data-id="${escapeHtml(v.id)}">
                <span class="c360-item-icon">${visitTypeIcon(v.tipoVisita)}</span>
                <span class="c360-item-text"><strong>${escapeHtml(v.dataVisita)}</strong><span>${escapeHtml(v.tipoVisita || '')}</span></span>
            </button>
        `).join(''))}

        ${renderSection('Propostas', proposals.length, proposals.slice(0, 8).map((p) => `
            <button type="button" class="c360-item" data-type="proposal-detail" data-id="${escapeHtml(p.id)}">
                <span class="c360-item-icon">${proposalStatusIcon(p.status)}</span>
                <span class="c360-item-text"><strong>${escapeHtml(p.status || '')}</strong><span>${escapeHtml(p.produtos || '')} · ${escapeHtml(p.data || '')}</span></span>
            </button>
        `).join(''))}

        ${renderSection('Funil', funil.length, funil.slice(0, 8).map((f) => `
            <button type="button" class="c360-item" data-type="funil-detail" data-id="${escapeHtml(f.id || '')}">
                <span class="c360-item-icon">${funilStatusIcon(f.status)}</span>
                <span class="c360-item-text"><strong>${escapeHtml(f.status || '')}</strong><span>${escapeHtml(f.data || '')}</span></span>
            </button>
        `).join(''))}

        ${renderSection('Contratos', contratos.length, contratos.slice(0, 8).map((c) => `
            <button type="button" class="c360-item" data-type="contrato-detail" data-id="${escapeHtml(c.id)}">
                <span class="c360-item-icon">📑</span>
                <span class="c360-item-text"><strong>${c.vencido ? 'Vencido' : c.assinado === 'Sim' ? 'Assinado' : 'Ativo'}</strong><span>${escapeHtml(c.fim ? 'até ' + c.fim : '')}</span></span>
            </button>
        `).join(''))}

        ${renderSection('Manutenções', manutencoes.length, manutencoes.slice(0, 8).map((m) => `
            <button type="button" class="c360-item" data-type="manutencao-detail" data-id="${escapeHtml(m.id)}">
                <span class="c360-item-icon">🔧</span>
                <span class="c360-item-text"><strong>${escapeHtml(m.data || '')}</strong><span>${escapeHtml(m.tecnico || '')}</span></span>
            </button>
        `).join(''))}
    `;

    document.getElementById('c360-back')?.addEventListener('click', () => window.history.back());
    mainContent.querySelectorAll('.c360-item').forEach((btn) => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.type, { id: btn.dataset.id }));
    });
}

function renderSection(title, count, itemsHtml) {
    if (count === 0) return '';
    return `
        <div class="card c360-section-card">
            <div class="c360-section-header"><strong>${escapeHtml(title)}</strong><span>${count}</span></div>
            <div class="c360-item-list">${itemsHtml}</div>
        </div>
    `;
}
