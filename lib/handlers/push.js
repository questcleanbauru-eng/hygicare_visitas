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

// Resolve nome-ou-email pro EmailLogin, manda pra cada inscrição desse
// usuário e devolve quantas deram certo. Não decide se erro é "normal"
// (usuário sem inscrição) ou não — quem chama decide o que fazer com 0.
async function sendToEmailOrNome(nomeOuEmail, { title, body, page, params, tag }) {
    await ensureSheet();
    const [vendedorRows, subRows] = await Promise.all([
        withCache('push_vendedores', 60, () => getSheetObjects('Vendedores')),
        getSheetObjects(SHEET)
    ]);
    const alvo = String(nomeOuEmail || '').trim().toLowerCase();
    if (!alvo) return 0;
    const vendedor = vendedorRows.find((v) =>
        String(v.NomeVendedor || '').trim().toLowerCase() === alvo ||
        String(v.EmailLogin || '').trim().toLowerCase() === alvo);
    const email = vendedor ? String(vendedor.EmailLogin || '').trim().toLowerCase() : alvo;
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

// Usado pelos outros handlers (campanhas.js etc.) pra notificar alguém como
// consequência de uma ação (criou campanha etc.) — nunca lança erro,
// notificação é um "extra" que não pode derrubar o fluxo principal.
export async function sendPushToVendedor(nomeOuEmail, options) {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
    try { await sendToEmailOrNome(nomeOuEmail, options); } catch (e) { /* nunca derruba o fluxo principal */ }
}

// Notificação manual, disparada pelo admin/gerente (Admin → Usuários →
// 🔔) — diferente da acima, essa PRECISA avisar se não deu certo (ex.:
// usuário nunca ativou notificação em nenhum aparelho), senão o admin
// acha que mandou e a pessoa nunca vê.
export async function handleSendPushNotification(payload) {
    const user = await verifyUser(payload.user);
    const p = String(user.profile || '').trim().toLowerCase();
    if (p !== 'admin' && p !== 'gerente') throw new Error('Só admin ou gerente pode notificar usuários.');
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) throw new Error('Notificação push ainda não configurada no servidor.');

    const toEmail = String(payload.toEmail || '').trim();
    if (!toEmail) throw new Error('Informe o destinatário.');
    const body = String(payload.body || '').trim();
    if (!body) throw new Error('Escreva a mensagem.');
    const title = String(payload.title || '').trim() || ('🔔 Aviso de ' + user.name.split(' ')[0]);

    const enviados = await sendToEmailOrNome(toEmail, { title, body, page: 'dashboard', tag: 'admin-msg-' + Date.now() });
    if (!enviados) throw new Error('Esse usuário ainda não ativou notificações em nenhum aparelho.');
    return { status: 'success', enviados };
}
