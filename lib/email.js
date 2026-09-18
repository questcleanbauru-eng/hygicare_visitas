// Envio de e-mail via um Web App do Google Apps Script (ver
// scripts/mail-relay.gs) que chama MailApp.sendEmail — evita criar conta
// em mais um serviço de terceiro; manda pela mesma conta Google já usada
// no projeto. MAIL_RELAY_URL/MAIL_RELAY_SECRET precisam ser configuradas
// no Vercel; sem elas, sendEmail só loga e não faz nada — mesmo padrão de
// guarda usado pras chaves VAPID do push (lib/handlers/push.js), pra uma
// env var faltando não derrubar nenhum fluxo principal.
const MAIL_RELAY_URL = process.env.MAIL_RELAY_URL;
const MAIL_RELAY_SECRET = process.env.MAIL_RELAY_SECRET;

export async function sendEmail({ to, subject, html }) {
    if (!MAIL_RELAY_URL || !MAIL_RELAY_SECRET) {
        console.warn('MAIL_RELAY_URL/MAIL_RELAY_SECRET não configuradas — e-mail não enviado:', subject);
        return { enviado: false, motivo: 'sem_config' };
    }
    try {
        const res = await fetch(MAIL_RELAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: MAIL_RELAY_SECRET, to, subject, html })
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !body.ok) {
            console.error('mail-relay:', res.status, body);
            return { enviado: false, motivo: 'erro_relay' };
        }
        return { enviado: true };
    } catch (e) {
        console.error('Falha ao chamar o mail-relay:', e.message);
        return { enviado: false, motivo: 'erro_rede' };
    }
}
