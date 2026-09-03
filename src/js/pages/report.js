import { state, navigateTo } from '../app.js';
import { escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, normalizeVisit, normalizeProposal, titleCase, parseCurrencyBR, calculateDaysFromDisplayDate } from '../utils/format.js';
import { loadingState, showToast, downloadCSV, initializeSearchableInput } from '../utils/dom.js';
import { ensureStyles, renderBreadcrumb } from '../utils/ui.js';

function formatMoney(value) {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Imprime a página inteira (scope vazio) ou só uma seção — o CSS
// @media print esconde as demais quando body[data-print-scope] está setado.
function printReport(scope) {
    if (scope) { document.body.dataset.printScope = scope; }
    const cleanup = () => {
        delete document.body.dataset.printScope;
        window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(cleanup, 3000); // fallback: nem todo navegador dispara afterprint
    window.print();
}

// Gera um PDF só com o conteúdo passado (tabelas detalhadas por vendedor),
// sem renderizar isso tudo na tela. Monta um container fora de tela, marca
// body[data-print-scope="detalhe"] (o CSS esconde o resto) e imprime.
function printDetalhe(title, subtitle, innerHtml) {
    document.getElementById('report-detail-print')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'report-detail-print';
    wrap.innerHTML = `<div class="rdp-head"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>${innerHtml}`;
    document.body.appendChild(wrap);
    document.body.dataset.printScope = 'detalhe';
    const cleanup = () => {
        wrap.remove();
        delete document.body.dataset.printScope;
        window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(cleanup, 3000);
    window.print();
}

// Probabilidade de fechamento por estágio do funil — usada no forecast
// ponderado (Vl Mensal × probabilidade).
const FUNIL_PROB = { IDENTIFICAR: 0.10, RETOMAR: 0.15, PROPOSTA: 0.30, NEGOCIAR: 0.60, CONCLUIDO: 1, PERDIDO: 0 };

function propStatusKind(status) {
    const s = String(status || '').trim().toLowerCase();
    if (['ganhamos', 'ganho', 'concluido', 'concluído'].includes(s)) return 'ganha';
    if (['perdido', 'perdida'].includes(s)) return 'perdida';
    return 'aberta';
}

// Soma um número por chave (vendedor, status, etc.) e devolve linhas
// ordenadas por valor desc.
function sumBy(items, keyFn, valFn) {
    const acc = {};
    items.forEach((it) => {
        const k = keyFn(it) || '-';
        acc[k] = (acc[k] || 0) + (valFn(it) || 0);
    });
    return Object.entries(acc).sort((a, b) => b[1] - a[1]);
}

// Pega as N maiores entradas de um countBy e agrupa o resto numa linha
// "Outras (X)" — pra listas por cidade/tipo não ficarem gigantes.
function topN(entries, n = 8, restLabel = 'Outras') {
    if (entries.length <= n + 1) return entries;
    const top = entries.slice(0, n);
    const rest = entries.slice(n);
    const restSum = rest.reduce((s, e) => s + e[1], 0);
    return [...top, [`${restLabel} (${rest.length})`, restSum]];
}

function reportTable(headers, rows) {
    return `<div class="report-table-wrap"><table class="report-table">
        <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? '' : ' class="num"'}>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

// Idade a partir de uma data dd/mm/aaaa → "0 ano(s), 6 mês(es) e 29 dia(s)".
function formatAge(dateStr) {
    const d = parseDisplayDate(dateStr);
    if (!d) return '-';
    const now = new Date();
    let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    let days = now.getDate() - d.getDate();
    if (days < 0) {
        months -= 1;
        days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    }
    if (months < 0) return '-';
    return `${Math.floor(months / 12)} ano(s), ${months % 12} mês(es) e ${days} dia(s)`;
}

// Igual ao reportTable, mas alinha tudo à esquerda (tabela de detalhe com
// muitas colunas de texto — DATA/CLIENTE/FOCO/… — onde alinhar à direita
// fica ilegível).
function reportTableFlat(headers, rows) {
    return `<div class="report-table-wrap"><table class="report-table report-table-flat">
        <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

// Tabela detalhada agrupada por vendedor: um cabeçalho + tabela por grupo.
function groupedVendorTables(items, vendedorOf, dateOf, headers, rowOf) {
    const groups = {};
    items.forEach((it) => {
        const k = titleCase(vendedorOf(it)) || 'Sem vendedor';
        (groups[k] = groups[k] || []).push(it);
    });
    return Object.keys(groups).sort((a, b) => a.localeCompare(b, 'pt-BR')).map((vend) => {
        const list = groups[vend].slice().sort((a, b) => (parseDisplayDate(dateOf(a)) || 0) - (parseDisplayDate(dateOf(b)) || 0));
        return `<div class="report-group">
            <h4 class="report-group-head">${escapeHtml(vend)} <span>${list.length}</span></h4>
            ${reportTableFlat(headers, list.map(rowOf))}
        </div>`;
    }).join('');
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
    document.getElementById('report-download-pdf').addEventListener('click', () => printReport(''));

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
    if (!Array.isArray(state.reportPropStatus)) { state.reportPropStatus = []; }
    if (!Array.isArray(state.reportFunilStatus)) { state.reportFunilStatus = []; }
    state.reportCollapsedSections = state.reportCollapsedSections || [];

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
    const propStatus = Array.isArray(state.reportPropStatus) ? state.reportPropStatus : [];
    const funilStatus = Array.isArray(state.reportFunilStatus) ? state.reportFunilStatus : [];

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
    const propStatusDisponiveis = Array.from(new Set(allProposals.map((p) => p.status).filter(Boolean))).sort();
    const funilStatusDisponiveis = Array.from(new Set(allFunil.map((f) => f.status).filter(Boolean))).sort();

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
        && (!gerencia || titleCase(p.gerencia) === gerencia) && (!propStatus.length || propStatus.includes(p.status)));
    const funil = allFunil.filter((f) => inRange(parseDisplayDate(f.data), start, end)
        && (!gerencia || titleCase(f.gerencia) === gerencia) && (!area || titleCase(f.atuacao) === area)
        && (!funilStatus.length || funilStatus.includes(f.status)));

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

    // ── Agregados por vendedor / extras (Propostas) ──────────────────────
    const propForecastN = (p) => propStatusKind(p.status) === 'aberta' ? 1 : 0;
    const propVendors = Array.from(new Set(proposals.map((p) => titleCase(p.vendedor) || '-')));
    const propByVendor = propVendors.map((vend) => {
        const list = proposals.filter((p) => (titleCase(p.vendedor) || '-') === vend);
        const abertas = list.filter((p) => propStatusKind(p.status) === 'aberta').length;
        const ganhas = list.filter((p) => propStatusKind(p.status) === 'ganha').length;
        const perdidas = list.filter((p) => propStatusKind(p.status) === 'perdida').length;
        const atrasadas = list.filter((p) => p.atrasada).length;
        const fechadas = ganhas + perdidas;
        const conv = fechadas ? Math.round((ganhas / fechadas) * 100) : 0;
        return { vend, total: list.length, abertas, atrasadas, ganhas, perdidas, conv };
    }).sort((a, b) => b.abertas - a.abertas);
    const propByFoco = countBy(proposals, (p) => titleCase(p.foco));
    const propAging = proposals.filter((p) => p.atrasada)
        .sort((a, b) => (b.diasAtraso || 0) - (a.diasAtraso || 0)).slice(0, 15);
    const propVencendo = proposals.filter((p) => {
        if (propStatusKind(p.status) !== 'aberta') return false;
        const dl = parseDisplayDate(p.dataLimite);
        if (!dl) return false;
        const dias = (dl - new Date()) / 86400000;
        return dias >= -3 && dias <= 15;
    }).sort((a, b) => (parseDisplayDate(a.dataLimite) || 0) - (parseDisplayDate(b.dataLimite) || 0));

    // ── Agregados por vendedor / extras (Funil) ──────────────────────────
    const funForecast = (f) => parseCurrencyBR(f.vlMensal) * (FUNIL_PROB[String(f.status || '').toUpperCase()] ?? 0.1);
    const funVendors = Array.from(new Set(funil.map((f) => titleCase(f.vendedor) || '-')));
    const funByVendor = funVendors.map((vend) => {
        const list = funil.filter((f) => (titleCase(f.vendedor) || '-') === vend);
        const ativas = list.filter((f) => String(f.ativo || '').toLowerCase() === 'sim');
        const st = (name) => ativas.filter((f) => String(f.status || '').toUpperCase() === name).length;
        const vlAtivo = ativas.reduce((s, f) => s + parseCurrencyBR(f.vlMensal), 0);
        const fc = list.reduce((s, f) => s + (String(f.ativo || '').toLowerCase() === 'sim' ? funForecast(f) : 0), 0);
        return {
            vend, ativas: ativas.length,
            identificar: st('IDENTIFICAR'), proposta: st('PROPOSTA'), negociar: st('NEGOCIAR'), retomar: st('RETOMAR'),
            concluidas: list.filter((f) => String(f.status || '').toUpperCase() === 'CONCLUIDO').length,
            perdidas: list.filter((f) => String(f.status || '').toUpperCase() === 'PERDIDO').length,
            vlAtivo, forecast: fc
        };
    }).sort((a, b) => b.vlAtivo - a.vlAtivo);
    const funForecastTotal = funilAtivo.reduce((s, f) => s + funForecast(f), 0);
    const funMotivoPerda = countBy(funil.filter((f) => String(f.status || '').toUpperCase() === 'PERDIDO'), (f) => f.motivoPerda || 'Não informado');
    const funPorAtuacao = countBy(funil, (f) => titleCase(f.atuacao));
    const funPorAplicacao = countBy(funil, (f) => titleCase(f.aplicacao));
    const funFechamento = funilAtivo.filter((f) => {
        const c = parseDisplayDate(f.conclusao);
        if (!c) return false;
        const dias = (c - new Date()) / 86400000;
        return dias >= -3 && dias <= 45;
    }).sort((a, b) => (parseDisplayDate(a.conclusao) || 0) - (parseDisplayDate(b.conclusao) || 0));

    const periodLabel = {
        'semana-atual': 'Semana atual',
        'mes-atual': 'Mês atual',
        'ultimos-3m': 'Últimos 3 meses',
        'personalizado': 'Período personalizado'
    }[period] || 'Mês atual';

    // Seções recolhíveis (setinha no cabeçalho) — o estado fica em memória
    // enquanto a tela existe.
    const collapsedSet = new Set(state.reportCollapsedSections || []);
    const secOpen = (key) => !collapsedSet.has(key);
    const secToggle = (key) => `<button type="button" class="report-section-toggle no-print" aria-label="Recolher/expandir seção" aria-expanded="${secOpen(key) ? 'true' : 'false'}">▾</button>`;

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
            ${propStatusDisponiveis.length ? `
            <div class="form-group report-status-filter">
                <label for="report-prop-status">Status da proposta <span class="report-status-hint">(marque um ou mais)</span></label>
                <div class="searchable-select">
                    <input type="text" id="report-prop-status" placeholder="Todos" autocomplete="off">
                    <div class="searchable-select-menu" id="report-prop-status-menu"></div>
                </div>
                <div class="selected-types" id="report-prop-status-selected" style="margin-top:0.3rem"></div>
            </div>` : ''}
            ${funilStatusDisponiveis.length ? `
            <div class="form-group report-status-filter">
                <label for="report-funil-status">Status do funil <span class="report-status-hint">(marque um ou mais)</span></label>
                <div class="searchable-select">
                    <input type="text" id="report-funil-status" placeholder="Todos" autocomplete="off">
                    <div class="searchable-select-menu" id="report-funil-status-menu"></div>
                </div>
                <div class="selected-types" id="report-funil-status-selected" style="margin-top:0.3rem"></div>
            </div>` : ''}
        </div>

        <div class="report-jump-nav no-print">
            <span>Ir para:</span>
            <button type="button" class="mini-button" data-jump="visitas">📋 Visitas</button>
            <button type="button" class="mini-button" data-jump="propostas">📄 Propostas</button>
            <button type="button" class="mini-button" data-jump="funil">📊 Funil</button>
        </div>

        <div class="report-section report-section-visitas${secOpen('visitas') ? '' : ' is-collapsed'}" data-section-key="visitas">
            <div class="report-section-head">
                <h3>📋 Visitas</h3>
                <div class="report-section-actions no-print">${secToggle('visitas')}</div>
            </div>
            <div class="report-section-body">
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${visits.length}</strong><span>Total no período</span></div>
            </div>
            ${visitsByType.length ? `<p class="report-subtitle">Por tipo (principais)</p><div class="report-bar-list">${topN(visitsByType, 10).map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
            ${isAdmGer && visitsByVendor.length ? `<p class="report-subtitle">Por vendedor</p><div class="report-bar-list">${topN(visitsByVendor, 15).map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
            ${visitsByCidade.length ? `<p class="report-subtitle">Por cidade (principais)</p><div class="report-bar-list">${topN(visitsByCidade, 8).map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
            ${topClientesVisitas.length ? `<p class="report-subtitle">Top 5 clientes com mais visitas</p><div class="report-top-list">${topClientesVisitas.map(([cliente, total], i) => reportTopRow(i, cliente, total)).join('')}</div>` : ''}
            ${topTiposComCliente.length ? `<p class="report-subtitle">Top 5 tipos de visita — cliente mais frequente</p><div class="report-top-list">${topTiposComCliente.map((t, i) => reportTopRow(i, titleCase(t.tipo) + (t.cliente ? ` — ${t.cliente}` : ''), t.clienteCount)).join('')}</div>` : ''}
            </div>
        </div>

        <div class="report-section report-section-propostas${secOpen('propostas') ? '' : ' is-collapsed'}" data-section-key="propostas">
            <div class="report-section-head">
                <h3>📄 Propostas</h3>
                <div class="report-section-actions no-print">
                    <button type="button" class="mini-button" id="pdf-propostas">📄 Resumo</button>
                    ${isAdmGer ? '<button type="button" class="mini-button" id="pdf-det-propostas">📄 Por vendedor</button>' : ''}
                    <button type="button" class="mini-button" id="csv-propostas">📥 CSV</button>
                    ${secToggle('propostas')}
                </div>
            </div>
            <div class="report-section-body">
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${proposals.length}</strong><span>Total no período</span></div>
                <div class="report-kpi"><strong>${conversao}%</strong><span>Taxa de conversão</span></div>
                <div class="report-kpi report-kpi-alert"><strong>${proposalsAtrasadas}</strong><span>Atrasadas &gt;30d</span></div>
            </div>
            ${isAdmGer && propByVendor.length ? `<p class="report-subtitle">Por vendedor</p>${reportTable(
                ['Vendedor', 'Total', 'Abertas', 'Atrasadas', 'Ganhas', 'Perdidas', 'Conv. %'],
                propByVendor.map((r) => [escapeHtml(r.vend), r.total, r.abertas, r.atrasadas, r.ganhas, r.perdidas, r.conv + '%'])
            )}` : ''}
            ${proposalsByStatus.length ? `<p class="report-subtitle">Por status</p><div class="report-bar-list">${proposalsByStatus.map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
            ${propByFoco.length ? `<p class="report-subtitle">Por linha de produto (foco)</p><div class="report-bar-list">${topN(propByFoco, 10).map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
            ${proposalsByCidade.length ? `<p class="report-subtitle">Por cidade (principais)</p><div class="report-bar-list">${topN(proposalsByCidade, 8).map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
            ${propAging.length ? `<p class="report-subtitle">Propostas paradas (sem atualização &gt;30d)</p>${reportTable(
                ['Cliente', 'Vendedor', 'Status', 'Dias parado', 'Data limite'],
                propAging.map((p) => [escapeHtml(titleCase(p.cliente)), escapeHtml(titleCase(p.vendedor)), escapeHtml(p.status || '-'), p.diasAtraso || 0, escapeHtml(p.dataLimite || '-')])
            )}` : ''}
            ${propVencendo.length ? `<p class="report-subtitle">Vencendo (data limite nos próximos 15 dias)</p>${reportTable(
                ['Cliente', 'Vendedor', 'Status', 'Data limite'],
                propVencendo.map((p) => [escapeHtml(titleCase(p.cliente)), escapeHtml(titleCase(p.vendedor)), escapeHtml(p.status || '-'), escapeHtml(p.dataLimite || '-')])
            )}` : ''}
            </div>
        </div>

        <div class="report-section report-section-funil${secOpen('funil') ? '' : ' is-collapsed'}" data-section-key="funil">
            <div class="report-section-head">
                <h3>📊 Funil</h3>
                <div class="report-section-actions no-print">
                    <button type="button" class="mini-button" id="pdf-funil">📄 Resumo</button>
                    ${isAdmGer ? '<button type="button" class="mini-button" id="pdf-det-funil">📄 Por vendedor</button>' : ''}
                    <button type="button" class="mini-button" id="csv-funil">📥 CSV</button>
                    ${secToggle('funil')}
                </div>
            </div>
            <div class="report-section-body">
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${funilAtivo.length}</strong><span>Ativas no período</span></div>
                <div class="report-kpi"><strong>${formatMoney(funilValorTotal)}</strong><span>Vl Mensal em pipeline</span></div>
                <div class="report-kpi"><strong>${formatMoney(funForecastTotal)}</strong><span>Forecast ponderado</span></div>
                <div class="report-kpi report-kpi-alert"><strong>${funilAtrasado}</strong><span>Sem atualização &gt;30d</span></div>
            </div>
            ${isAdmGer && funByVendor.length ? `<p class="report-subtitle">Por vendedor</p>${reportTable(
                ['Vendedor', 'Ativas', 'Identif.', 'Proposta', 'Negociar', 'Retomar', 'Concl.', 'Perd.', 'Vl Mensal', 'Forecast'],
                funByVendor.map((r) => [escapeHtml(r.vend), r.ativas, r.identificar, r.proposta, r.negociar, r.retomar, r.concluidas, r.perdidas, formatMoney(r.vlAtivo), formatMoney(r.forecast)])
            )}` : ''}
            ${funilByStatus.length ? `<p class="report-subtitle">Por status</p><div class="report-bar-list">${funilByStatus.map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
            ${funMotivoPerda.length ? `<p class="report-subtitle">Motivo da perda</p><div class="report-bar-list">${funMotivoPerda.map(([k, v]) => reportBar(k, v, funMotivoPerda.reduce((s, x) => s + x[1], 0))).join('')}</div>` : ''}
            ${funPorAtuacao.length ? `<p class="report-subtitle">Por atuação</p><div class="report-bar-list">${topN(funPorAtuacao, 10).map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
            ${funPorAplicacao.length ? `<p class="report-subtitle">Por aplicação</p><div class="report-bar-list">${topN(funPorAplicacao, 10).map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
            ${funilByCidade.length ? `<p class="report-subtitle">Por cidade (principais)</p><div class="report-bar-list">${topN(funilByCidade, 8).map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
            ${funFechamento.length ? `<p class="report-subtitle">Previsão de fechamento (conclusão nos próximos 45 dias)</p>${reportTable(
                ['Cliente', 'Vendedor', 'Status', 'Vl Mensal', 'Conclusão'],
                funFechamento.map((f) => [escapeHtml(titleCase(f.cliente)), escapeHtml(titleCase(f.vendedor)), escapeHtml(f.status || '-'), formatMoney(parseCurrencyBR(f.vlMensal)), escapeHtml(f.conclusao || '-')])
            )}` : ''}
            </div>
        </div>
    `;

    body.querySelectorAll('[data-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.reportPeriod = btn.dataset.period;
            renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
        });
    });

    const _stamp = new Date().toISOString().slice(0, 10);
    document.getElementById('pdf-propostas')?.addEventListener('click', () => printReport('propostas'));
    document.getElementById('pdf-funil')?.addEventListener('click', () => printReport('funil'));

    body.querySelectorAll('[data-jump]').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelector(`.report-section-${btn.dataset.jump}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    document.getElementById('pdf-det-propostas')?.addEventListener('click', () => {
        if (!proposals.length) { showToast('Nenhuma proposta no período.', true); return; }
        printDetalhe('Propostas — detalhado por vendedor', `${escapeHtml(periodLabel)}${gerencia ? ' · ' + gerencia : ''} — ${proposals.length} proposta(s)`, groupedVendorTables(
            proposals, (p) => p.vendedor, (p) => p.data,
            ['Data', 'Cliente', 'Foco', 'Produtos', 'Cidade', 'Status', 'Atualização', 'Tempo proposta'],
            (p) => [
                escapeHtml(p.data || '-'), escapeHtml(titleCase(p.cliente) || '-'), escapeHtml(p.foco || '-'),
                escapeHtml(p.produtos || '-'), escapeHtml(titleCase(p.cidade) || '-'), escapeHtml(p.status || '-'),
                escapeHtml(p.atualizacao || '-'), escapeHtml(formatAge(p.data))
            ]
        ));
    });
    document.getElementById('pdf-det-funil')?.addEventListener('click', () => {
        if (!funil.length) { showToast('Nenhuma oportunidade no período.', true); return; }
        printDetalhe('Funil — detalhado por vendedor', `${escapeHtml(periodLabel)}${gerencia ? ' · ' + gerencia : ''} — ${funil.length} oportunidade(s)`, groupedVendorTables(
            funil, (f) => f.vendedor, (f) => f.data,
            ['Data', 'Cliente', 'Foco', 'Atuação', 'Cidade', 'Status', 'Vl Mensal', 'Atualização', 'Tempo no funil'],
            (f) => [
                escapeHtml(f.data || '-'), escapeHtml(titleCase(f.cliente) || '-'), escapeHtml(f.foco || '-'),
                escapeHtml(titleCase(f.atuacao) || '-'), escapeHtml(titleCase(f.cidade) || '-'), escapeHtml(f.status || '-'),
                formatMoney(parseCurrencyBR(f.vlMensal)), escapeHtml(f.atualizacao || '-'), escapeHtml(formatAge(f.data))
            ]
        ));
    });
    document.getElementById('csv-propostas')?.addEventListener('click', () => {
        const rows = proposals
            .slice()
            .sort((a, b) => (parseDisplayDate(b.data) || 0) - (parseDisplayDate(a.data) || 0))
            .map((p) => ({
                data: p.data || '', vendedor: titleCase(p.vendedor), gerencia: titleCase(p.gerencia),
                cliente: titleCase(p.cliente), cidade: titleCase(p.cidade), foco: p.foco || '', produtos: p.produtos || '',
                status: p.status || '', situacao: propStatusKind(p.status),
                atualizacao: p.atualizacao || '', diasSemAtualizacao: calculateDaysFromDisplayDate(p.atualizacao || p.data || ''),
                atrasada: p.atrasada ? 'Sim' : 'Não', dataLimite: p.dataLimite || '', email: p.email || ''
            }));
        if (!rows.length) { showToast('Nenhuma proposta no período.', true); return; }
        downloadCSV(rows, `propostas-${_stamp}.csv`, [
            { key: 'data', label: 'Data' }, { key: 'vendedor', label: 'Vendedor' }, { key: 'gerencia', label: 'Gerência' },
            { key: 'cliente', label: 'Cliente' }, { key: 'cidade', label: 'Cidade' }, { key: 'foco', label: 'Foco' },
            { key: 'produtos', label: 'Produtos' }, { key: 'status', label: 'Status' }, { key: 'situacao', label: 'Situação' },
            { key: 'atualizacao', label: 'Última atualização' }, { key: 'diasSemAtualizacao', label: 'Dias sem atualização' },
            { key: 'atrasada', label: 'Atrasada' }, { key: 'dataLimite', label: 'Data limite' }, { key: 'email', label: 'E-mail' }
        ]);
    });
    document.getElementById('csv-funil')?.addEventListener('click', () => {
        const rows = funil
            .slice()
            .sort((a, b) => (parseDisplayDate(b.data) || 0) - (parseDisplayDate(a.data) || 0))
            .map((f) => ({
                data: f.data || '', vendedor: titleCase(f.vendedor), gerencia: titleCase(f.gerencia),
                cliente: titleCase(f.cliente), cidade: titleCase(f.cidade), status: f.status || '',
                ativo: f.ativo || '', foco: f.foco || '', atuacao: f.atuacao || '', aplicacao: f.aplicacao || '',
                equipamentos: f.equipamentos || '', vlMensal: parseCurrencyBR(f.vlMensal),
                forecast: Math.round(funForecast(f) * 100) / 100,
                atualizacao: f.atualizacao || '', diasSemAtualizacao: calculateDaysFromDisplayDate(f.atualizacao || f.data || ''),
                conclusao: f.conclusao || '', motivoPerda: f.motivoPerda || ''
            }));
        if (!rows.length) { showToast('Nenhuma oportunidade no período.', true); return; }
        downloadCSV(rows, `funil-${_stamp}.csv`, [
            { key: 'data', label: 'Data' }, { key: 'vendedor', label: 'Vendedor' }, { key: 'gerencia', label: 'Gerência' },
            { key: 'cliente', label: 'Cliente' }, { key: 'cidade', label: 'Cidade' }, { key: 'status', label: 'Status' },
            { key: 'ativo', label: 'Ativo' }, { key: 'foco', label: 'Foco' }, { key: 'atuacao', label: 'Atuação' },
            { key: 'aplicacao', label: 'Aplicação' }, { key: 'equipamentos', label: 'Equipamentos' },
            { key: 'vlMensal', label: 'Vl Mensal (R$)' }, { key: 'forecast', label: 'Forecast ponderado (R$)' },
            { key: 'atualizacao', label: 'Última atualização' }, { key: 'diasSemAtualizacao', label: 'Dias sem atualização' },
            { key: 'conclusao', label: 'Conclusão prevista' }, { key: 'motivoPerda', label: 'Motivo da perda' }
        ]);
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
    const initReportStatusFilter = (id, items, stateKey) => {
        if (!document.getElementById(id)) return;
        const arr = Array.isArray(state[stateKey]) ? state[stateKey] : [];
        initializeSearchableInput({
            input: document.getElementById(id),
            menu: document.getElementById(id + '-menu'),
            items,
            multiSelect: true,
            maxSelections: 99,
            selectedItems: arr,
            selectedContainer: document.getElementById(id + '-selected'),
            selectionLabel: 'status',
            onSelectionChange: () => {
                state[stateKey] = arr.slice();
                renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
            }
        });
    };
    initReportStatusFilter('report-prop-status', propStatusDisponiveis, 'reportPropStatus');
    initReportStatusFilter('report-funil-status', funilStatusDisponiveis, 'reportFunilStatus');

    body.querySelectorAll('.report-section-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
            const sec = btn.closest('.report-section');
            const collapsed = sec.classList.toggle('is-collapsed');
            btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            const key = sec.dataset.sectionKey;
            if (key) {
                const set = new Set(state.reportCollapsedSections || []);
                collapsed ? set.add(key) : set.delete(key);
                state.reportCollapsedSections = Array.from(set);
            }
        });
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
