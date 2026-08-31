import { state, navigateTo } from '../app.js';
import { escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, normalizeVisit, normalizeProposal, titleCase, parseCurrencyBR } from '../utils/format.js';
import { loadingState, showToast } from '../utils/dom.js';
import { ensureStyles, renderBreadcrumb } from '../utils/ui.js';

function formatMoney(value) {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function countBy(items, keyFn) {
    const counts = {};
    items.forEach((item) => {
        const key = keyFn(item) || '-';
        counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function inRange(date, start, end) {
    if (!start || !end) return true;
    if (!date) return false;
    return date >= start && date <= end;
}

export async function renderReportPage() {
    ensureStyles('report');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Dashboard', page: 'dashboard' }, { label: 'Relatório' }])}
        <div class="page-header">
            <div><h2>Relatório de KPIs</h2><p class="page-subtitle">Resumo de visitas, propostas e funil</p></div>
            <button type="button" class="btn-add no-print" id="report-download-pdf">📄 Baixar PDF</button>
        </div>
        <div id="report-body">${loadingState('📊', 'Carregando relatório...')}</div>
    `;
    document.getElementById('report-download-pdf').addEventListener('click', () => window.print());

    const isAdmGer = isAdminOrGerenteUser();
    const [visitsMod, proposalsMod, funilMod] = await Promise.all([
        import('./visits.js'), import('./proposals.js'), import('./funil.js')
    ]);

    // As 3 buscas do relatório pedem o histórico inteiro (dias:0) — pesadas.
    // Em paralelo, numa função serverless fria, elas competem pelo tempo/cota
    // do Sheets e alguma estoura o limite (erro "não foi possível carregar").
    // Sequencial + 1 retry: cada uma pega o orçamento inteiro e ainda aquece
    // o cache do servidor pra próxima.
    const fetchWithRetry = async (fn, tries = 2) => {
        let last = { status: 'error', message: 'Sem resposta do servidor.' };
        for (let i = 0; i < tries; i++) {
            try { last = await fn(); } catch (e) { last = { status: 'error', message: e && e.message }; }
            if (last && last.status === 'success') return last;
            if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
        }
        return last;
    };
    const visitsRes = await fetchWithRetry(() => visitsMod.getVisits(0));
    const proposalsRes = await fetchWithRetry(() => proposalsMod.getProposals(0));
    const funilRes = await fetchWithRetry(() => funilMod.getFunil(0));

    state.reportPeriod = state.reportPeriod || 'mes-atual';
    state.reportCustomFrom = state.reportCustomFrom || '';
    state.reportCustomTo = state.reportCustomTo || '';

    if (visitsRes.status !== 'success' || proposalsRes.status !== 'success' || funilRes.status !== 'success') {
        // Não renderiza um relatório "zerado" quando a busca falhou de
        // verdade — daria a entender que não houve nenhuma atividade.
        const falhas = [
            visitsRes.status !== 'success' ? 'Visitas' : null,
            proposalsRes.status !== 'success' ? 'Propostas' : null,
            funilRes.status !== 'success' ? 'Funil' : null
        ].filter(Boolean);
        const motivo = String(visitsRes.message || proposalsRes.message || funilRes.message || '').trim();
        const body = document.getElementById('report-body');
        if (body) {
            body.innerHTML = `<div class="empty-state">
                <span class="empty-state-icon">⚠️</span>
                <p>Não foi possível carregar: ${falhas.join(', ')}.${motivo ? `<br><span class="helper-text">${escapeHtml(motivo)}</span>` : ''}</p>
                <button type="button" class="secondary-button" id="report-retry-btn">Tentar novamente</button>
            </div>`;
            document.getElementById('report-retry-btn')?.addEventListener('click', () => navigateTo('report'));
        }
        return;
    }

    const allVisits = visitsRes.visits.map(normalizeVisit);
    const allProposals = proposalsRes.proposals.map(normalizeProposal);
    const allFunil = funilRes.funil || [];

    renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
}

function renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer) {
    const body = document.getElementById('report-body');
    if (!body) return;

    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const gerencia = state.reportGerencia || '';
    const area = state.reportArea || '';

    // Opções vêm do conjunto INTEIRO (sem filtro de período), pra não ficar
    // reordenando/sumindo do dropdown conforme o usuário troca o período.
    const gerenciasDisponiveis = Array.from(new Set([
        ...allVisits.map((v) => v.gerencia), ...allProposals.map((p) => p.gerencia), ...allFunil.map((f) => f.gerencia)
    ].map((g) => titleCase(g)).filter(Boolean))).sort();
    // "Área de Atuação" só existe em Visitas (areaAtuacao) e Funil (atuacao)
    // — Propostas nunca teve esse campo, então o filtro não afeta a seção
    // de Propostas do relatório.
    const areasDisponiveis = Array.from(new Set([
        ...allVisits.map((v) => v.areaAtuacao), ...allFunil.map((f) => f.atuacao)
    ].map((a) => titleCase(a)).filter(Boolean))).sort();

    const period = state.reportPeriod;
    let start = null, end = null;
    if (period === 'personalizado') {
        start = state.reportCustomFrom ? new Date(state.reportCustomFrom + 'T00:00:00') : null;
        end = state.reportCustomTo ? new Date(state.reportCustomTo + 'T23:59:59') : null;
    } else {
        const range = getDateRangeForPeriod(period);
        start = range.start; end = range.end;
    }

    const visits = allVisits.filter((v) => inRange(parseDisplayDate(v.dataVisita), start, end)
        && (!gerencia || titleCase(v.gerencia) === gerencia) && (!area || titleCase(v.areaAtuacao) === area));
    const proposals = allProposals.filter((p) => inRange(parseDisplayDate(p.data), start, end)
        && (!gerencia || titleCase(p.gerencia) === gerencia));
    const funil = allFunil.filter((f) => inRange(parseDisplayDate(f.data), start, end)
        && (!gerencia || titleCase(f.gerencia) === gerencia) && (!area || titleCase(f.atuacao) === area));

    const visitsByType = countBy(visits, (v) => v.tipoVisita);
    const visitsByVendor = countBy(visits, (v) => titleCase(v.vendedorGerente));
    const visitsByCidade = countBy(visits, (v) => titleCase(v.cidade));

    const topClientesVisitas = countBy(visits, (v) => titleCase(v.cliente)).slice(0, 5);
    const topTiposComCliente = visitsByType.slice(0, 5).map(([tipo]) => {
        const clientesDoTipo = countBy(visits.filter((v) => (v.tipoVisita || '-') === tipo), (v) => titleCase(v.cliente));
        // clienteCount é quantas visitas DESSE tipo foram pra esse cliente
        // específico — não o total do tipo somando todos os clientes, que
        // dava a entender (errado) que o cliente sozinho tinha aquele total.
        return { tipo, cliente: clientesDoTipo[0] ? clientesDoTipo[0][0] : null, clienteCount: clientesDoTipo[0] ? clientesDoTipo[0][1] : 0 };
    });

    const proposalsByStatus = countBy(proposals, (p) => p.status);
    const proposalsByCidade = countBy(proposals, (p) => titleCase(p.cidade));
    const proposalsGanhas = proposals.filter((p) => (p.status || '').toLowerCase() === 'ganhamos').length;
    const conversao = proposals.length ? Math.round((proposalsGanhas / proposals.length) * 100) : 0;
    const proposalsAtrasadas = proposals.filter((p) => p.atrasada).length;

    const funilByStatus = countBy(funil, (f) => f.status);
    const funilByCidade = countBy(funil, (f) => titleCase(f.cidade));
    const funilAtivo = funil.filter((f) => String(f.ativo || '').toLowerCase() === 'sim');
    const funilValorTotal = funilAtivo.reduce((sum, f) => sum + parseCurrencyBR(f.vlMensal), 0);
    const funilAtrasado = funil.filter((f) => {
        const dias = parseDisplayDate(f.atualizacao || f.data);
        return String(f.ativo || '').toLowerCase() === 'sim' && dias && (new Date() - dias) / 86400000 > 30;
    }).length;

    const periodLabel = {
        'semana-atual': 'Semana atual',
        'mes-atual': 'Mês atual',
        'ultimos-3m': 'Últimos 3 meses',
        'personalizado': 'Período personalizado'
    }[period] || 'Mês atual';

    body.innerHTML = `
        <div class="report-print-header">
            <h2>Relatório de KPIs — ${escapeHtml(periodLabel)}</h2>
            <p>Gerado por ${escapeHtml(state.currentUser?.name || '')} em ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
        <div class="card report-period-card no-print">
            <div class="report-period-buttons">
                <button type="button" class="mini-button ${period === 'semana-atual' ? 'active' : ''}" data-period="semana-atual">Semana atual</button>
                <button type="button" class="mini-button ${period === 'mes-atual' ? 'active' : ''}" data-period="mes-atual">Mês atual</button>
                <button type="button" class="mini-button ${period === 'ultimos-3m' ? 'active' : ''}" data-period="ultimos-3m">Últimos 3 meses</button>
                <button type="button" class="mini-button ${period === 'personalizado' ? 'active' : ''}" data-period="personalizado">Personalizado</button>
            </div>
            ${period === 'personalizado' ? `
            <div class="report-custom-range">
                <div class="form-group"><label for="report-date-from">De</label><input type="date" id="report-date-from" value="${escapeHtml(state.reportCustomFrom)}"></div>
                <div class="form-group"><label for="report-date-to">Até</label><input type="date" id="report-date-to" value="${escapeHtml(state.reportCustomTo)}"></div>
            </div>` : ''}
            ${isAdmin ? `
            <div class="report-custom-range">
                <div class="form-group">
                    <label for="report-gerencia">Gerência</label>
                    <select id="report-gerencia">
                        <option value="">Todas</option>
                        ${gerenciasDisponiveis.map((g) => `<option value="${escapeHtml(g)}" ${gerencia === g ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label for="report-area">Área de Atuação</label>
                    <select id="report-area">
                        <option value="">Todas</option>
                        ${areasDisponiveis.map((a) => `<option value="${escapeHtml(a)}" ${area === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
                    </select>
                </div>
            </div>` : ''}
        </div>

        <div class="report-section">
            <h3>📋 Visitas</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${visits.length}</strong><span>Total no período</span></div>
            </div>
            ${visitsByType.length ? `<p class="report-subtitle">Por tipo</p><div class="report-bar-list">${visitsByType.map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
            ${isAdmGer && visitsByVendor.length ? `<p class="report-subtitle">Por vendedor</p><div class="report-bar-list">${visitsByVendor.map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
            ${visitsByCidade.length ? `<p class="report-subtitle">Por cidade</p><div class="report-bar-list">${visitsByCidade.map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
            ${topClientesVisitas.length ? `<p class="report-subtitle">Top 5 clientes com mais visitas</p><div class="report-top-list">${topClientesVisitas.map(([cliente, total], i) => reportTopRow(i, cliente, total)).join('')}</div>` : ''}
            ${topTiposComCliente.length ? `<p class="report-subtitle">Top 5 tipos de visita — cliente mais frequente</p><div class="report-top-list">${topTiposComCliente.map((t, i) => reportTopRow(i, titleCase(t.tipo) + (t.cliente ? ` — ${t.cliente}` : ''), t.clienteCount)).join('')}</div>` : ''}
        </div>

        <div class="report-section">
            <h3>📄 Propostas</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${proposals.length}</strong><span>Total no período</span></div>
                <div class="report-kpi"><strong>${conversao}%</strong><span>Taxa de conversão</span></div>
                <div class="report-kpi report-kpi-alert"><strong>${proposalsAtrasadas}</strong><span>Atrasadas</span></div>
            </div>
            ${proposalsByStatus.length ? `<p class="report-subtitle">Por status</p><div class="report-bar-list">${proposalsByStatus.map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
            ${proposalsByCidade.length ? `<p class="report-subtitle">Por cidade</p><div class="report-bar-list">${proposalsByCidade.map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
        </div>

        <div class="report-section">
            <h3>📊 Funil</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${funilAtivo.length}</strong><span>Ativas no período</span></div>
                <div class="report-kpi"><strong>${formatMoney(funilValorTotal)}</strong><span>Valor em pipeline</span></div>
                <div class="report-kpi report-kpi-alert"><strong>${funilAtrasado}</strong><span>Sem atualização &gt;30d</span></div>
            </div>
            ${funilByStatus.length ? `<p class="report-subtitle">Por status</p><div class="report-bar-list">${funilByStatus.map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
            ${funilByCidade.length ? `<p class="report-subtitle">Por cidade</p><div class="report-bar-list">${funilByCidade.map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
        </div>
    `;

    body.querySelectorAll('[data-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.reportPeriod = btn.dataset.period;
            renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
        });
    });
    document.getElementById('report-date-from')?.addEventListener('change', (e) => {
        state.reportCustomFrom = e.target.value;
        renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
    });
    document.getElementById('report-date-to')?.addEventListener('change', (e) => {
        state.reportCustomTo = e.target.value;
        renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
    });
    document.getElementById('report-gerencia')?.addEventListener('change', (e) => {
        state.reportGerencia = e.target.value;
        renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
    });
    document.getElementById('report-area')?.addEventListener('change', (e) => {
        state.reportArea = e.target.value;
        renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
    });
}

function reportTopRow(index, label, value) {
    return `
        <div class="report-top-row">
            <span class="report-top-rank">${index + 1}</span>
            <span class="report-top-label">${escapeHtml(label)}</span>
            <span class="report-top-value">${value}</span>
        </div>
    `;
}

function reportBar(label, value, total) {
    const pct = total ? Math.round((value / total) * 100) : 0;
    return `
        <div class="report-bar-row">
            <span class="report-bar-label">${escapeHtml(titleCase(label))}</span>
            <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%"></div></div>
            <span class="report-bar-value">${value}</span>
        </div>
    `;
}
