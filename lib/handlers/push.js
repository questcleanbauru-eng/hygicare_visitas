import webpush from 'web-push';
import {
    getSheetObjects, getHeaders, appendRow, updateRow, deleteRow,
    sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { verifyUser, formatDate } from '../common.js';

// Notificação push de verdade (chega mesmo com o app fechado), via Web
// Push — diferente do que já existia em ui.js (checkOverdueNotification
// etc.), que só disparava com o app aberto/visível. Cada dispositivo que
// autoriza fica com uma "inscrição" (endpoint + chaves) guardada aqui;
// pra notificar alguém, o backend assina o payload com a chave VAPID
// privada e manda pro endpoint do navegador dela.

const SHEET = 'PushSubscriptions';
const HEADERS = ['Id', 'EmailLogin', 'Endpoint', 'P256dh', 'Auth', 'UserAgent', 'CriadaEm'];

// Registro "de verdade" de cada notificação (pra tela de Notificações) —
// separado da inscrição de push acima: existe mesmo se o push falhar ou
// não estiver configurado ainda, e é o que fica marcado como lida/não lida.
const NOTIF_SHEET = 'Notificacoes';
const NOTIF_HEADERS = ['Id', 'EmailLogin', 'Titulo', 'Corpo', 'Page', 'ParamsJson', 'Tipo', 'CriadaEm', 'LidaEm'];

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contato@hygicare.com.br';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

async function ensureSheet() {
    if (!(await sheetExists(SHEET))) {
        await createSheet(SHEET);
        await appendRow(SHEET, HEADERS);
    }
}

async function ensureNotifSheet() {
    if (!(await sheetExists(NOTIF_SHEET))) {
        await createSheet(NOTIF_SHEET);
        await appendRow(NOTIF_SHEET, NOTIF_HEADERS);
    }
}

function resolveEmail(nomeOuEmail, vendedorRows) {
    const alvo = String(nomeOuEmail || '').trim().toLowerCase();
    if (!alvo) return '';
    const vendedor = vendedorRows.find((v) =>
        String(v.NomeVendedor || '').trim().toLowerCase() === alvo ||
        String(v.EmailLogin || '').trim().toLowerCase() === alvo);
    return vendedor ? String(vendedor.EmailLogin || '').trim().toLowerCase() : alvo;
}

export async function handleSubscribePush(payload) {
    const user = await verifyUser(payload.user);
    const sub = payload.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        throw new Error('Inscrição de notificação inválida.');
    }
    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const email = String(user.email).trim().toLowerCase();
    // Mesmo endpoint pode voltar a se inscrever (permissão revogada e
    // reativada, navegador atualizado etc.) — atualiza a linha existente em
    // vez de duplicar.
    const rowIndex = rows.findIndex((r) => String(r.Endpoint || '') === sub.endpoint);
    const fields = {
        Id: rowIndex > -1 ? rows[rowIndex].Id : String(Date.now()),
        EmailLogin: email,
        Endpoint: sub.endpoint,
        P256dh: sub.keys.p256dh,
        Auth: sub.keys.auth,
        UserAgent: String(payload.userAgent || '').slice(0, 200),
        CriadaEm: formatDate(new Date())
    };
    if (rowIndex > -1) await updateRow(SHEET, rowIndex + 2, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    else await appendRow(SHEET, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    clearCacheByPrefix(['push_']);
    return { status: 'success' };
}

export async function handleUnsubscribePush(payload) {
    const user = await verifyUser(payload.user);
    await ensureSheet();
    const rows = await getSheetObjects(SHEET);
    const email = String(user.email).trim().toLowerCase();
    const endpoint = String(payload.endpoint || '');
    const rowIndex = rows.findIndex((r) => String(r.Endpoint || '') === endpoint && String(r.EmailLogin || '').trim().toLowerCase() === email);
    if (rowIndex > -1) await deleteRow(SHEET, rowIndex + 2);
    clearCacheByPrefix(['push_']);
    return { status: 'success' };
}

// Manda pra cada inscrição de um EmailLogin já resolvido e devolve quantas
// deram certo. Não decide se 0 é "normal" (sem inscrição) — quem chama
// decide o que fazer.
async function sendToResolvedEmail(email, { title, body, page, params, tag }) {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return 0;
    await ensureSheet();
    const subRows = await getSheetObjects(SHEET);
    const subs = subRows.filter((r) => String(r.EmailLogin || '').trim().toLowerCase() === email);
    if (!subs.length) return 0;

    const payloadStr = JSON.stringify({ title, body, tag, data: { page: page || 'dashboard', params: params || undefined } });
    let enviados = 0;
    await Promise.all(subs.map(async (s) => {
        try {
            await webpush.sendNotification({ endpoint: s.Endpoint, keys: { p256dh: s.P256dh, auth: s.Auth } }, payloadStr);
            enviados++;
        } catch (err) {
            // 404/410 = inscrição morta (desinstalou o app, trocou de
            // aparelho/navegador etc.) — limpa pra não tentar de novo.
            if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                const fresh = await getSheetObjects(SHEET);
                const idx = fresh.findIndex((r) => r.Endpoint === s.Endpoint);
                if (idx > -1) await deleteRow(SHEET, idx + 2).catch(() => {});
            }
        }
    }));
    return enviados;
}

// Ponto único de entrada pra notificar alguém: grava o registro "de
// verdade" (aparece na tela de Notificações, some do push nada muda
// isso) e, à parte, tenta entregar o push de verdade no aparelho. Usado
// tanto pelo aviso automático (campanha criada) quanto pelo manual
// (Admin → Usuários → 🔔).
export async function createNotification(nomeOuEmail, { title, body, page, params, tag, tipo }) {
    await Promise.all([ensureSheet(), ensureNotifSheet()]);
    const vendedorRows = await withCache('push_vendedores', 60, () => getSheetObjects('Vendedores'));
    const email = resolveEmail(nomeOuEmail, vendedorRows);
    if (!email) return { enviados: 0 };

    const headers = await getHeaders(NOTIF_SHEET);
    const fields = {
        Id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        EmailLogin: email, Titulo: title || '', Corpo: body || '',
        Page: page || 'dashboard', ParamsJson: params ? JSON.stringify(params) : '',
        Tipo: tipo || 'aviso', CriadaEm: formatDate(new Date()), LidaEm: ''
    };
    await appendRow(NOTIF_SHEET, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    clearCacheByPrefix(['notif_']);

    const enviados = await sendToResolvedEmail(email, { title, body, page, params, tag }).catch(() => 0);
    return { enviados };
}

// Usado pelos outros handlers (campanhas.js etc.) pra notificar alguém como
// consequência de uma ação (criou campanha etc.) — nunca lança erro,
// notificação é um "extra" que não pode derrubar o fluxo principal.
export async function sendPushToVendedor(nomeOuEmail, options) {
    try { await createNotification(nomeOuEmail, options); } catch (e) { /* nunca derruba o fluxo principal */ }
}

// "Notificar outros usuários" opcional (multi-destinatário) na hora de criar
// um registro — Agenda (Novo agendamento), Funil, Propostas. Mesma lógica em
// todas as telas: quem PODE ser notificado é decidido no front (admin
// notifica qualquer um; gerente só admins + a própria equipe; vendedor comum
// só admins/gerentes da própria gerência — mesmo espírito do "Notificar um
// usuário" de Nova Visita); aqui só resolve o texto por tipo e entrega.
// Separado do handler de criação em si de propósito: "Repetir a cada 30
// dias" (Agenda) cria vários agendamentos num loop — notificar dentro
// daquele handler mandaria um push por checkpoint, em vez de um só.
const REGISTRO_NOTIFY_CFG = {
    agendamento: { titulo: 'criou um agendamento', page: 'calendar' },
    funil: { titulo: 'criou uma oportunidade no Funil', page: 'funil' },
    proposta: { titulo: 'criou uma proposta', page: 'proposals' }
};

export async function handleNotifyRegistroCriado(payload) {
    const user = await verifyUser(payload.user);
    const destinatarios = Array.from(new Set((Array.isArray(payload.destinatarios) ? payload.destinatarios : [])
        .map((d) => String(d || '').trim()).filter(Boolean)));
    if (!destinatarios.length) return { status: 'success', enviados: 0 };

    const cfg = REGISTRO_NOTIFY_CFG[payload.tipo] || REGISTRO_NOTIFY_CFG.agendamento;
    const cliente = String(payload.cliente || '').trim() || 'um cliente';
    const detalhe = String(payload.detalhe || '').trim();

    let enviados = 0;
    for (const dest of destinatarios) {
        await sendPushToVendedor(dest, {
            title: `📌 ${user.name.split(' ')[0]} ${cfg.titulo}`,
            body: `${cliente}${detalhe ? ' — ' + detalhe : ''}`,
            page: cfg.page, tag: `registro-criado-${Date.now()}-${enviados}`, tipo: 'aviso'
        });
        enviados++;
    }
    return { status: 'success', enviados };
}

// Notificação manual, disparada pelo admin/gerente (Admin → Usuários → 🔔,
// ou na própria tela de Notificações) — sempre grava (some na tela da
// pessoa mesmo que o push não chegue), só avisa quando o push em si não
// foi entregue, pra não passar a falsa impressão de que "não fez nada".
export async function handleSendPushNotification(payload) {
    const user = await verifyUser(payload.user);
    const p = String(user.profile || '').trim().toLowerCase();
    if (p !== 'admin' && p !== 'gerente') throw new Error('Só admin ou gerente pode notificar usuários.');

    const toEmail = String(payload.toEmail || '').trim();
    if (!toEmail) throw new Error('Informe o destinatário.');
    const body = String(payload.body || '').trim();
    if (!body) throw new Error('Escreva a mensagem.');
    const title = String(payload.title || '').trim() || ('🔔 Aviso de ' + user.name.split(' ')[0]);

    const { enviados } = await createNotification(toEmail, { title, body, page: 'notificacoes', tipo: 'aviso' });
    return {
        status: 'success', enviados,
        message: enviados
            ? 'Notificação enviada.'
            : 'Aviso salvo — já aparece pra ela na tela de Notificações, mas o push não pôde ser entregue agora (talvez ainda não tenha ativado notificações em nenhum aparelho).'
    };
}

// ── Tela de Notificações (cada um vê só as suas) ────────────────────────
export async function handleGetNotificacoes(payload) {
    const user = await verifyUser(payload.user);
    await ensureNotifSheet();
    const email = String(user.email).trim().toLowerCase();
    // Chamado no Dashboard de TODO MUNDO a cada carregamento (só pra
    // acender o número no menu) — sem cache aqui, virava uma leitura nova
    // da planilha por usuário por visita, o que já contribuiu pra estourar
    // a cota de requisições do Sheets (afetava até quem só abria o Funil,
    // nada a ver com Notificações). createNotification já limpa esse
    // cache ('notif_') na hora que grava um aviso novo, então a demora de
    // até 30s pra um aviso recém-criado aparecer pros outros é rara.
    const rows = await withCache('notif_all', 30, () => getSheetObjects(NOTIF_SHEET));
    const minhas = rows
        .filter((r) => String(r.EmailLogin || '').trim().toLowerCase() === email)
        .sort((a, b) => Number(String(b.Id).split('_')[0] || 0) - Number(String(a.Id).split('_')[0] || 0))
        .slice(0, 100)
        .map((r) => ({
            id: String(r.Id), titulo: r.Titulo || '', corpo: r.Corpo || '',
            page: r.Page || 'dashboard',
            params: (() => { try { return r.ParamsJson ? JSON.parse(r.ParamsJson) : null; } catch (e) { return null; } })(),
            tipo: r.Tipo || 'aviso', criadaEm: r.CriadaEm || '', lida: !!r.LidaEm
        }));
    return { status: 'success', notificacoes: minhas, naoLidas: minhas.filter((n) => !n.lida).length };
}

export async function handleMarcarNotificacaoLida(payload) {
    const user = await verifyUser(payload.user);
    await ensureNotifSheet();
    const headers = await getHeaders(NOTIF_SHEET);
    // Mesma chave de cache que handleGetNotificacoes usa — Notificacoes só
    // recebe linha nova (nunca apaga/reordena), então um snapshot com até
    // 30s não desalinha o índice de nenhuma linha existente.
    const rows = await withCache('notif_all', 30, () => getSheetObjects(NOTIF_SHEET));
    const email = String(user.email).trim().toLowerCase();
    const alvo = payload.all ? null : String(payload.id || '');

    const agora = formatDate(new Date());
    const writes = [];
    rows.forEach((row, idx) => {
        if (String(row.EmailLogin || '').trim().toLowerCase() !== email) return;
        if (row.LidaEm) return;
        if (alvo !== null && String(row.Id) !== alvo) return;
        row.LidaEm = agora;
        writes.push(updateRow(NOTIF_SHEET, idx + 2, headers.map((h) => (row[h] !== undefined ? row[h] : ''))));
    });
    await Promise.all(writes);
    if (writes.length) clearCacheByPrefix(['notif_']);
    return { status: 'success' };
}
