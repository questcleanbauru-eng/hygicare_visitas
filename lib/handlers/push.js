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

// Usado pelos outros handlers (campanhas.js etc.) pra notificar alguém.
// `nomeOuEmail` normalmente é só o nome (ex.: VendedorDestino da campanha,
// que é digitado/escolhido como nome, não email) — resolve pro EmailLogin
// antes de buscar as inscrições. Nunca lança erro: notificação é um
// "extra", não pode derrubar o fluxo principal (criar campanha etc.) se
// falhar.
export async function sendPushToVendedor(nomeOuEmail, { title, body, page, params, tag }) {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
    try {
        await ensureSheet();
        const [vendedorRows, subRows] = await Promise.all([
            withCache('push_vendedores', 60, () => getSheetObjects('Vendedores')),
            getSheetObjects(SHEET)
        ]);
        const alvo = String(nomeOuEmail || '').trim().toLowerCase();
        if (!alvo) return;
        const vendedor = vendedorRows.find((v) =>
            String(v.NomeVendedor || '').trim().toLowerCase() === alvo ||
            String(v.EmailLogin || '').trim().toLowerCase() === alvo);
        const email = vendedor ? String(vendedor.EmailLogin || '').trim().toLowerCase() : alvo;
        const subs = subRows.filter((r) => String(r.EmailLogin || '').trim().toLowerCase() === email);
        if (!subs.length) return;

        const payloadStr = JSON.stringify({ title, body, tag, data: { page: page || 'dashboard', params: params || undefined } });
        await Promise.all(subs.map(async (s) => {
            try {
                await webpush.sendNotification({ endpoint: s.Endpoint, keys: { p256dh: s.P256dh, auth: s.Auth } }, payloadStr);
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
    } catch (e) { /* notificação nunca derruba o fluxo principal */ }
}
