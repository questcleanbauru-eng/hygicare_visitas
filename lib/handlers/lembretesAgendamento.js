import { readAgendamentoRows } from './agendamentos.js';
import { getSheetObjects, withCache } from '../sheets.js';
import { verifyUser, parseDate, formatDate } from '../common.js';
import { nowInSaoPaulo } from './resumo.js';
import { sendPushToVendedor } from './push.js';
import { sendEmail } from '../email.js';

// Objeto "usuário" sintético só pra reaproveitar readAgendamentoRows sem
// filtro (perfil admin enxerga tudo) — o cron precisa ver os agendamentos
// de TODOS os vendedores, não só de um.
const SYSTEM_USER = { profile: 'admin', name: '', email: '', gerencia: '' };

const DIAS_ANTECEDENCIA = 7;

function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
}

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Agendamentos "Pendente" cuja DataAgendada cai EXATAMENTE daqui a
// DIAS_ANTECEDENCIA dias — não "nos próximos N dias": o cron roda 1x/dia,
// então casar a data exata garante um único disparo por agendamento (no
// dia seguinte ele já não bate mais nesse filtro).
export async function computeLembretesAgendamento(referenceDate = null) {
    const hoje = startOfDay(referenceDate || nowInSaoPaulo());
    const alvo = new Date(hoje);
    alvo.setDate(alvo.getDate() + DIAS_ANTECEDENCIA);
    const dataAlvoLabel = formatDate(alvo);

    const agendamentos = await readAgendamentoRows(SYSTEM_USER);
    const naData = agendamentos.filter((a) => {
        if (String(a.status || '').trim().toLowerCase() !== 'pendente') return false;
        const d = parseDate(a.dataAgendada);
        return d && isSameDay(d, alvo);
    });

    const porVendedorMap = new Map();
    naData.forEach((a) => {
        const nome = String(a.vendedor || '').trim();
        if (!nome) return;
        if (!porVendedorMap.has(nome)) porVendedorMap.set(nome, []);
        porVendedorMap.get(nome).push(a);
    });

    let emailByNome = new Map();
    if (porVendedorMap.size) {
        const vendedorRows = await withCache('vendedores_all_lembretes', 60, () => getSheetObjects('Vendedores'));
        emailByNome = new Map(vendedorRows.map((v) => [String(v.NomeVendedor || '').trim().toLowerCase(), v.EmailLogin]));
    }

    const porVendedor = Array.from(porVendedorMap.entries()).map(([nome, lista]) => ({
        vendedor: nome,
        email: emailByNome.get(nome.trim().toLowerCase()) || '',
        agendamentos: lista
    }));

    return { dataAlvo: alvo, dataAlvoLabel, porVendedor };
}

// ── E-mail (ver api/cron-lembretes.js) ───────────────────────────────────
export function buildLembreteEmailHtml(vendedorNome, agendamentos, dataAlvoLabel, { showVendedor = false } = {}) {
    const linhas = agendamentos.map((a) => `
        <p style="margin:0 0 10px;font-size:14px;color:#0f172a">
            <strong>${esc(a.cliente || '-')}</strong>${a.cidade ? ` — ${esc(a.cidade)}` : ''}
            ${showVendedor ? `<br><span style="color:#64748b">Vendedor: ${esc(a.vendedor || '-')}</span>` : ''}
            ${a.observacao ? `<br><span style="color:#64748b">${esc(a.observacao)}</span>` : ''}
        </p>`).join('');

    const appUrl = process.env.APP_URL || 'https://hygicare-visitas.vercel.app';
    const primeiroNome = esc(String(vendedorNome || '').split(' ')[0] || '');

    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
        <tr><td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;max-width:560px">
                <tr><td style="background:#1e3a8a;padding:20px 24px">
                    <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.08em;color:#c7d2fe;text-transform:uppercase">Hygicare</p>
                    <p style="margin:2px 0 0;font-size:19px;font-weight:700;color:#ffffff">📅 Agendamento em 7 dias</p>
                </td></tr>
                <tr><td style="padding:18px 24px 4px">
                    <p style="margin:0 0 12px;font-size:14px;color:#334155">
                        Oi ${primeiroNome}! Você tem ${agendamentos.length > 1 ? `${agendamentos.length} agendamentos marcados` : 'um agendamento marcado'}
                        pra <strong>${esc(dataAlvoLabel)}</strong>:
                    </p>
                    ${linhas}
                </td></tr>
                <tr><td style="padding:8px 24px 24px">
                    <a href="${esc(appUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:10px 20px;border-radius:999px">Abrir o app →</a>
                </td></tr>
            </table>
        </td></tr>
    </table>`;
}

// Botão "Testar agora" (Admin → Configurações) — usa os agendamentos reais
// de daqui a 7 dias (de qualquer vendedor), mas manda o e-mail/notificação
// só pro admin que clicou, pra não notificar todo mundo à toa. Mesmo sem
// nenhum agendamento na data, manda um e-mail avisando isso (senão o botão
// "testar" pareceria não fazer nada).
export async function handleTestLembreteAgendamento(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') {
        throw new Error('Só administradores podem testar o lembrete de agendamento.');
    }
    const { dataAlvoLabel, porVendedor } = await computeLembretesAgendamento();
    const todos = porVendedor.flatMap((v) => v.agendamentos);
    const html = todos.length
        ? buildLembreteEmailHtml(user.name, todos, dataAlvoLabel, { showVendedor: true })
        : `<p style="font-family:Arial,sans-serif;font-size:14px;color:#334155">Nenhum agendamento pendente pra ${esc(dataAlvoLabel)} no momento — nada seria enviado hoje.</p>`;
    const emailResult = await sendEmail({ to: user.email, subject: `📅 [Teste] Lembrete de agendamento — ${dataAlvoLabel}`, html });
    await sendPushToVendedor(user.email, {
        title: '📅 [Teste] Lembrete de agendamento',
        body: todos.length ? `${todos.length} agendamento(s) em ${dataAlvoLabel}.` : `Nenhum agendamento em ${dataAlvoLabel}.`,
        page: 'calendar', tag: 'lembrete-agendamento-teste', tipo: 'aviso'
    });
    return {
        status: 'success',
        emailEnviado: emailResult.enviado,
        encontrados: todos.length,
        message: emailResult.enviado
            ? `E-mail de teste enviado — confira sua caixa de entrada (encontrados: ${todos.length} agendamento(s) em ${dataAlvoLabel}).`
            : 'Notificação enviada, mas o e-mail não pôde ser mandado (MAIL_RELAY_URL/MAIL_RELAY_SECRET não configuradas ou erro no envio — veja os logs do Vercel).'
    };
}
