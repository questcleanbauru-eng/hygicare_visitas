import crypto from 'node:crypto';

const PASSWORD_ITERATIONS = 210000;
const PASSWORD_PREFIX = 'pbkdf2';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function base64Url(value) { return Buffer.from(value).toString('base64url'); }

function sessionSecret() {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) throw new Error('SESSION_SECRET nao configurada corretamente no servidor.');
    return secret;
}

function timingSafeEqualText(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function hashPassword(password) {
    const value = String(password || '');
    if (!value) throw new Error('Senha obrigatoria.');
    const salt = crypto.randomBytes(16).toString('base64url');
    const digest = crypto.pbkdf2Sync(value, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('base64url');
    return `${PASSWORD_PREFIX}$sha256$${PASSWORD_ITERATIONS}$${salt}$${digest}`;
}

export function verifyPassword(password, storedValue) {
    const stored = String(storedValue || '');
    if (!stored.startsWith(PASSWORD_PREFIX + '$')) return { valid: timingSafeEqualText(String(password || ''), stored), needsUpgrade: true };
    const [prefix, algorithm, iterationsText, salt, expected] = stored.split('$');
    const iterations = Number(iterationsText);
    if (prefix !== PASSWORD_PREFIX || algorithm !== 'sha256' || !Number.isSafeInteger(iterations) || !salt || !expected) return { valid: false, needsUpgrade: false };
    const actual = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, algorithm).toString('base64url');
    return { valid: timingSafeEqualText(actual, expected), needsUpgrade: false };
}

export function createSession(user) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({ sub: String(user.email).toLowerCase(), iat: now, exp: now + SESSION_TTL_SECONDS }));
    const signature = crypto.createHmac('sha256', sessionSecret()).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
}

export function readSession(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('Sessao invalida. Entre novamente.');
    const [header, payload, signature] = parts;
    const expected = crypto.createHmac('sha256', sessionSecret()).update(`${header}.${payload}`).digest('base64url');
    if (!timingSafeEqualText(signature, expected)) throw new Error('Sessao invalida. Entre novamente.');
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { throw new Error('Sessao invalida. Entre novamente.'); }
    if (!claims.sub || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('Sessao expirada. Entre novamente.');
    return { email: String(claims.sub).trim().toLowerCase() };
}
