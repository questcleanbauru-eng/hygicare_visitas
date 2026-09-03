// PIN de acesso rápido.
//
// O PIN é validado NO SERVIDOR (hash na aba Vendedores, com bloqueio após
// tentativas erradas). Aqui no aparelho a gente só lembra QUAL e-mail usa
// PIN, pra tela de login já abrir no teclado de PIN em vez de e-mail+senha.
// Nada de senha nem PIN fica guardado no navegador.

const PIN_EMAIL_KEY = 'apv_pin_email_v1';
const LEGACY_KEY = 'apv_pin_v1'; // versão antiga (cifrava as credenciais no aparelho)

// Limpa o formato antigo — agora quem valida é o servidor.
try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* ignore */ }

export function isPinSupported() {
    return !!(typeof window !== 'undefined' && window.localStorage);
}

export function getPinEmail() {
    try { return localStorage.getItem(PIN_EMAIL_KEY) || ''; }
    catch (e) { return ''; }
}

export function hasPinEmail() {
    return !!getPinEmail();
}

export function setPinEmail(email) {
    try { localStorage.setItem(PIN_EMAIL_KEY, String(email || '').trim().toLowerCase()); }
    catch (e) { /* ignore */ }
}

export function clearPinEmail() {
    try { localStorage.removeItem(PIN_EMAIL_KEY); }
    catch (e) { /* ignore */ }
}
