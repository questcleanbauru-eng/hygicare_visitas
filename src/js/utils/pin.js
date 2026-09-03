// PIN de acesso rápido (por aparelho).
//
// Guarda { email, senha } cifrados no localStorage com uma chave derivada do
// PIN (PBKDF2-SHA256 → AES-GCM 256). Sem o PIN correto o blob não entrega
// nada — e depois de MAX_ATTEMPTS erros ele é apagado e o app volta pro
// login completo (e-mail + senha).
//
// Não troca nada com o servidor: o "entrar com PIN" decifra as credenciais e
// chama o mesmo action 'login' de sempre. Se a senha tiver mudado no
// servidor, o login falha e o PIN é descartado.

const PIN_KEY = 'apv_pin_v1';
const MAX_ATTEMPTS = 5;
const KDF_ITERATIONS = 210000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function fromB64(str) {
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

function readBlob() {
    try { return JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); }
    catch (e) { return null; }
}
function writeBlob(blob) {
    try { localStorage.setItem(PIN_KEY, JSON.stringify(blob)); } catch (e) {}
}

async function deriveKey(pin, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

export function isPinSupported() {
    return !!(window.crypto && window.crypto.subtle && window.isSecureContext && window.localStorage);
}

export function hasPinSetup() {
    const b = readBlob();
    return !!(b && b.email && b.ct && b.salt && b.iv);
}

export function pinEmail() {
    const b = readBlob();
    return (b && b.email) || '';
}

export function clearPin() {
    try { localStorage.removeItem(PIN_KEY); } catch (e) {}
}

// Cria/substitui o PIN a partir de credenciais já validadas no login.
export async function setupPin(pin, email, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt);
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        enc.encode(JSON.stringify({ email, password }))
    );
    writeBlob({
        email,
        salt: toB64(salt),
        iv: toB64(iv),
        ct: toB64(ct),
        attempts: 0
    });
}

// Devolve { email, password } se o PIN bater. Senão lança um Error com:
//   .code === 'wrong'  + .remaining  (ainda dá pra tentar)
//   .code === 'locked'              (estourou o limite; blob apagado)
//   .code === 'no-pin'             (não há PIN salvo)
export async function unlockWithPin(pin) {
    const blob = readBlob();
    if (!blob || !blob.ct) {
        const e = new Error('Nenhum PIN configurado.'); e.code = 'no-pin'; throw e;
    }
    try {
        const key = await deriveKey(pin, fromB64(blob.salt));
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromB64(blob.iv) },
            key,
            fromB64(blob.ct)
        );
        blob.attempts = 0;
        writeBlob(blob);
        return JSON.parse(dec.decode(plain));
    } catch (err) {
        if (err && err.code === 'no-pin') throw err;
        blob.attempts = (blob.attempts || 0) + 1;
        if (blob.attempts >= MAX_ATTEMPTS) {
            clearPin();
            const e = new Error('Muitas tentativas.'); e.code = 'locked'; throw e;
        }
        writeBlob(blob);
        const e = new Error('PIN incorreto.');
        e.code = 'wrong';
        e.remaining = MAX_ATTEMPTS - blob.attempts;
        throw e;
    }
}
