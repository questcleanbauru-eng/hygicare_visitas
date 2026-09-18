import { getSheetObjects, withCache } from '../sheets.js';
import { verifyUser, formatDate, parseDate } from '../common.js';
import { readAgendamentoRows } from './agendamentos.js';
import { readCampanhaRows } from './campanhas.js';
import { readManutencaoRows } from './manutencao.js';
import { readRows as readRelatorioTecnicoRows } from './relatorioTecnico.js';
import { sendPushToVendedor } from './push.js';
import { sendEmail } from '../email.js';

// Objeto "usuário" sintético só pra reaproveitar os mesmos leitores de linha
// que o resto do app já usa (readAgendamentoRows/readCampanhaRows/
// readManutencaoRows/readRelatorioTecnicoRows) — perfil admin faz cada um
// deles devolver tudo sem filtro, que é exatamente o que o resumo precisa
// (visão do dia inteiro, não de um vendedor só).
const RESUMO_USER = { profile: 'admin', name: '', email: '', gerencia: '' };

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
}

// A função serverless roda em UTC, não no horário de Brasília — sem isso,
// "hoje"/"ontem" ficavam deslocados (ex.: checar depois das 21h em Brasília
// já é o dia seguinte em UTC), fazendo o resumo olhar pro dia errado ou
// ficar vazio por engano. new Date(x).toLocaleString formatado no fuso e
// reparseado devolve um Date cujos getters locais já refletem o horário
// de Brasília.
function nowInSaoPaulo() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

// Resumo sempre cobre o dia anterior ao informado (ou a ontem, se nenhuma
// data for passada) — "o que aconteceu" é sempre sobre um dia já fechado.
export async function computeResumoDiario(referenceDate = null) {
    const today = startOfDay(referenceDate || nowInSaoPaulo());
    const target = new Date(today);
    target.setDate(target.getDate() - 1);
    const targetLabel = formatDate(target);
    const proximosLimite = new Date(today);
    proximosLimite.setDate(proximosLimite.getDate() + 7);

    // ── Visitas registradas no dia-alvo ──────────────────────────────────
    const rawVisits = await withCache('visitas_sheet_raw', 60, () => getSheetObjects('Visitas'));
    const visitasOntem = rawVisits.filter((v) => {
        const d = parseDate(v['Data da Visita']);
        return d && isSameDay(d, target);
    });
    const porVendedorMap = {};
    visitasOntem.forEach((v) => {
        const nome = String(v['Vendedor/Gerente'] || '').trim() || 'Sem vendedor';
        porVendedorMap[nome] = (porVendedorMap[nome] || 0) + 1;
    });
    const porVendedor = Object.entries(porVendedorMap)
        .map(([nome, total]) => ({ nome, total }))
        .sort((a, b) => b.total - a.total);

    // ── Agendamentos: vencidos (pendentes com data já passada) e próximos
    //    7 dias (pendentes com data entre hoje e o limite) ─────────────────
    const agendamentos = await readAgendamentoRows(RESUMO_USER);
    const pendentesAg = agendamentos.filter((a) => a.status === 'Pendente');
    const vencidos = pendentesAg.filter((a) => {
        const d = parseDate(a.dataAgendada);
        return d && d < today;
    }).sort((a, b) => (parseDate(a.dataAgendada)?.getTime() || 0) - (parseDate(b.dataAgendada)?.getTime() || 0));
    const proximos = pendentesAg.filter((a) => {
        const d = parseDate(a.dataAgendada);
        return d && d >= today && d <= proximosLimite;
    }).sort((a, b) => (parseDate(a.dataAgendada)?.getTime() || 0) - (parseDate(b.dataAgendada)?.getTime() || 0));

    // ── Relatórios criados no dia-alvo (Manutenção: Aferição/Geral + SPSP) ─
    const manutencoes = await readManutencaoRows(RESUMO_USER);
    const manutencoesOntem = manutencoes.filter((m) => {
        const d = parseDate(m.data);
        return d && isSameDay(d, target);
    });
    const aferição = manutencoesOntem.filter((m) => m.tipoRelatorio !== 'geral').length;
    const geral = manutencoesOntem.filter((m) => m.tipoRelatorio === 'geral').length;

    const relatoriosTecnicos = await readRelatorioTecnicoRows(RESUMO_USER);
    const spsp = relatoriosTecnicos.filter((r) => {
        const d = parseDate(r.data);
        return d && isSameDay(d, target);
    }).length;

    // ── Campanhas: itens respondidos no dia-alvo + total ainda pendente ──
    const campanhas = await readCampanhaRows(RESUMO_USER);
    let respondidasOntem = 0;
    let pendentesTotal = 0;
    let maisAntiga = null;
    campanhas.forEach((c) => {
        c.itens.forEach((it) => {
            if (it.respondidoEm) {
                const d = parseDate(it.respondidoEm);
                if (d && isSameDay(d, target)) respondidasOntem++;
            } else if (c.status !== 'concluida') {
                pendentesTotal++;
            }
        });
        if (c.status !== 'concluida' && c.itens.some((it) => !it.respondidoEm)) {
            const criada = parseDate(c.criadaEm);
            if (criada && (!maisAntiga || criada < maisAntiga.data)) {
                maisAntiga = { titulo: c.titulo, data: criada };
            }
        }
    });

    return {
        dataResumo: targetLabel,
        visitas: { total: visitasOntem.length, porVendedor },
        agendamentos: {
            vencidosTotal: vencidos.length,
            vencidos: vencidos.slice(0, 8).map((a) => ({ cliente: a.cliente, dataAgendada: a.dataAgendada })),
            proximosTotal: proximos.length
        },
        relatorios: { total: manutencoesOntem.length + spsp, aferição, geral, spsp },
        campanhas: {
            respondidasOntem,
            pendentesTotal,
            maisAntigaTitulo: maisAntiga ? maisAntiga.titulo : '',
            maisAntigaDias: maisAntiga ? Math.round((today.getTime() - maisAntiga.data.getTime()) / 86400000) : 0
        }
    };
}

// Pra ver o resumo dentro do app (card do Início) — admin só, mesmo escopo
// do e-mail. Cache curto: a tela pode ser aberta várias vezes no mesmo
// dia sem reler as 5 abas toda hora.
export async function handleGetResumoDiario(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') {
        throw new Error('Resumo diário disponível só para administradores por enquanto.');
    }
    const resumo = await withCache('resumo_diario', 300, () => computeResumoDiario());
    return { status: 'success', resumo };
}

// ── E-mail (ver lib/email.js + api/cron-resumo.js) ──────────────────────
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function emailSection(titulo, linhasHtml) {
    return `
    <tr><td style="padding:18px 24px 4px">
        <p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.04em;color:#64748b;text-transform:uppercase">${titulo}</p>
        ${linhasHtml}
    </td></tr>`;
}

export function buildResumoEmailHtml(resumo) {
    const r = resumo;

    const visitasHtml = r.visitas.total
        ? `<p style="margin:0;font-size:14px;color:#0f172a">${r.visitas.porVendedor.map((v) => `${esc(v.nome)} — ${v.total}`).join(' &nbsp;·&nbsp; ')}</p>`
        : `<p style="margin:0;font-size:14px;color:#64748b">Nenhuma visita registrada.</p>`;

    const agendamentosLinhas = [];
    if (r.agendamentos.vencidosTotal) {
        const nomes = r.agendamentos.vencidos.map((a) => esc(a.cliente || '-')).join(', ');
        const resto = r.agendamentos.vencidosTotal > r.agendamentos.vencidos.length
            ? ` e mais ${r.agendamentos.vencidosTotal - r.agendamentos.vencidos.length}` : '';
        agendamentosLinhas.push(`<p style="margin:0 0 4px;font-size:14px;color:#b91c1c">⚠ ${r.agendamentos.vencidosTotal} vencido(s): ${nomes}${resto}</p>`);
    }
    if (r.agendamentos.proximosTotal) {
        agendamentosLinhas.push(`<p style="margin:0;font-size:14px;color:#0f172a">📅 ${r.agendamentos.proximosTotal} nos próximos 7 dias</p>`);
    }
    if (!agendamentosLinhas.length) agendamentosLinhas.push(`<p style="margin:0;font-size:14px;color:#64748b">Nenhum agendamento vencido ou próximo.</p>`);

    const relatoriosHtml = r.relatorios.total
        ? `<p style="margin:0;font-size:14px;color:#0f172a">Aferição: ${r.relatorios.aferição} &nbsp;·&nbsp; SPSP: ${r.relatorios.spsp} &nbsp;·&nbsp; Geral: ${r.relatorios.geral}</p>`
        : `<p style="margin:0;font-size:14px;color:#64748b">Nenhum relatório criado.</p>`;

    const campanhasLinhas = [];
    if (r.campanhas.respondidasOntem) campanhasLinhas.push(`<p style="margin:0 0 4px;font-size:14px;color:#15803d">✓ ${r.campanhas.respondidasOntem} respondida(s) ontem</p>`);
    if (r.campanhas.pendentesTotal) {
        campanhasLinhas.push(`<p style="margin:0;font-size:14px;color:#0f172a">⏳ ${r.campanhas.pendentesTotal} ainda aberta(s)${r.campanhas.maisAntigaTitulo ? ` — a mais antiga: "${esc(r.campanhas.maisAntigaTitulo)}" (aberta há ${r.campanhas.maisAntigaDias} dia(s))` : ''}</p>`);
    }
    if (!campanhasLinhas.length) campanhasLinhas.push(`<p style="margin:0;font-size:14px;color:#64748b">Nenhuma campanha pendente ou respondida.</p>`);

    const appUrl = process.env.APP_URL || 'https://hygicare-visitas.vercel.app';

    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
        <tr><td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;max-width:560px">
                <tr><td style="background:#1e3a8a;padding:20px 24px">
                    <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.08em;color:#c7d2fe;text-transform:uppercase">Hygicare</p>
                    <p style="margin:2px 0 0;font-size:19px;font-weight:700;color:#ffffff">Resumo de ${esc(r.dataResumo)}</p>
                </td></tr>
                ${emailSection('📋 Visitas (' + r.visitas.total + ')', visitasHtml)}
                ${emailSection('📌 Agendamentos', agendamentosLinhas.join(''))}
                ${emailSection('🔧 Relatórios criados (' + r.relatorios.total + ')', relatoriosHtml)}
                ${emailSection('🔗 Campanhas', campanhasLinhas.join(''))}
                <tr><td style="padding:20px 24px 24px">
                    <a href="${esc(appUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:10px 20px;border-radius:999px">Abrir o app →</a>
                </td></tr>
            </table>
        </td></tr>
    </table>`;
}

// Botão "Testar agora" (Admin → Configurações → Resumo diário) — dispara o
// mesmo cálculo/e-mail/notificação do cron, mas só pro admin que clicou
// (ignora os toggles por perfil e não manda pra mais ninguém), e mesmo num
// dia sem nenhuma atividade (senão o botão "testar" pareceria não fazer
// nada em dias parados).
export async function handleTestResumoDiario(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') {
        throw new Error('Só administradores podem testar o resumo diário.');
    }
    const resumo = await computeResumoDiario();
    const html = buildResumoEmailHtml(resumo);
    const emailResult = await sendEmail({ to: user.email, subject: `📋 [Teste] Resumo de ${resumo.dataResumo}`, html });
    await sendPushToVendedor(user.email, {
        title: '📧 [Teste] Resumo de ontem',
        body: `Resumo de ${resumo.dataResumo} — confira sua caixa de entrada.`,
        page: 'dashboard', tag: 'resumo-diario-teste', tipo: 'aviso'
    });
    return {
        status: 'success',
        emailEnviado: emailResult.enviado,
        message: emailResult.enviado
            ? 'E-mail de teste enviado — confira sua caixa de entrada (e o spam).'
            : 'Notificação enviada, mas o e-mail não pôde ser mandado (RESEND_API_KEY não configurada ou erro no envio — veja os logs do Vercel).'
    };
}
