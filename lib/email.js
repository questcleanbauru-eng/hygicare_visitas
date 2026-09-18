// Envio de e-mail via Resend (https://resend.com) — API simples (1 POST,
// sem SDK) e plano grátis cobre o volume de um resumo diário tranquilo.
// RESEND_API_KEY precisa ser configurada no Vercel; sem ela, mandarEmail
// só loga e não faz nada — mesmo padrão de guarda usado pras chaves VAPID
// do push (lib/handlers/push.js), pra uma env var faltando não derrubar
// nenhum fluxo principal.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Resend exige domínio verificado pra mandar de um endereço próprio; até
// isso ser configurado, cai no remetente de teste deles (só entrega pro
// dono da conta Resend) — dá pra trocar via env var assim que o domínio
// estiver verificado.
const EMAIL_FROM = process.env.RESUMO_EMAIL_FROM || 'App de Visitas <onboarding@resend.dev>';

export async function sendEmail({ to, subject, html }) {
    if (!RESEND_API_KEY) {
        console.warn('RESEND_API_KEY não configurada — e-mail não enviado:', subject);
        return { enviado: false, motivo: 'sem_api_key' };
    }
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ from: EMAIL_FROM, to, subject, html })
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error(`Resend ${res.status}:`, body.slice(0, 500));
            return { enviado: false, motivo: 'erro_api' };
        }
        return { enviado: true };
    } catch (e) {
        console.error('Falha ao chamar Resend:', e.message);
        return { enviado: false, motivo: 'erro_rede' };
    }
}
