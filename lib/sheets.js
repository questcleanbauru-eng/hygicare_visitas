import { JWT } from 'google-auth-library';

const SPREADSHEET_ID = '1rW2cl0V-HWNnYWHsRTgtEv9dvR2PEIL0X92eBGAIrzQ';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// O client cacheia o access token internamente (renova perto de expirar),
// então mantê-lo em escopo de módulo dá cache "de graça" entre invocações
// quentes da function — sem precisar reautenticar a cada request.
let _authClient = null;
function getAuthClient() {
    if (_authClient) return _authClient;
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY não configurada.');
    const key = JSON.parse(raw);
    _authClient = new JWT({
        email: key.client_email,
        key: key.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return _authClient;
}

async function sheetsFetch(path, options = {}) {
    const client = getAuthClient();
    const { token } = await client.getAccessToken();
    const res = await fetch(`${SHEETS_API}/${SPREADSHEET_ID}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Log cru só no servidor (Vercel captura via console.error) — o texto
        // que chega no cliente não deve expor detalhes internos da API do
        // Sheets (ex.: nomes de aba, estrutura de erro do Google).
        console.error(`Sheets API ${res.status}:`, body.slice(0, 500));
        throw new Error(res.status === 429
            ? 'Limite de requisições da planilha atingido. Tente novamente em instantes.'
            : 'Erro ao acessar a planilha. Tente novamente.');
    }
    return res.json();
}

function encodeRange(range) {
    return encodeURIComponent(range);
}

function colToLetter(n) {
    let s = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

// ── Leitura ──────────────────────────────────────────────────────────────

export async function getSheetValues(sheetName) {
    const data = await sheetsFetch(`/values/${encodeRange(sheetName)}`);
    return data.values || [];
}

export async function getHeaders(sheetName) {
    const data = await sheetsFetch(`/values/${encodeRange(sheetName + '!1:1')}`);
    return (data.values && data.values[0]) || [];
}

function valuesToObjects(values) {
    if (!values || values.length <= 1) return [];
    const headers = values[0];
    return values.slice(1).map((row) => {
        const obj = {};
        headers.forEach((header, i) => { obj[header] = row[i] !== undefined ? row[i] : ''; });
        return obj;
    });
}

export async function getSheetObjects(sheetName) {
    const values = await getSheetValues(sheetName);
    return valuesToObjects(values);
}

// Junta getHeaders + getSheetObjects numa unica chamada (values/{sheet} ja
// inclui a linha de cabecalho) — usado onde os dois eram lidos separadamente.
export async function getSheetWithHeaders(sheetName) {
    const values = await getSheetValues(sheetName);
    return { headers: values[0] || [], rows: valuesToObjects(values) };
}

// Lê varias abas numa unica chamada à API (values:batchGet) — evita estourar
// a quota de "read requests per minute" quando uma acao precisa combinar
// dados de varias abas (ex.: form data, admin).
export async function batchGetSheetObjects(sheetNames) {
    const query = sheetNames.map((name) => `ranges=${encodeRange(name)}`).join('&');
    const data = await sheetsFetch(`/values:batchGet?${query}`);
    const ranges = data.valueRanges || [];
    const result = {};
    sheetNames.forEach((name, i) => { result[name] = valuesToObjects((ranges[i] || {}).values); });
    return result;
}

export async function getSingleColumnValues(sheetName, header) {
    const rows = await getSheetObjects(sheetName);
    return rows.map((row) => row[header]).filter(Boolean);
}

export async function getSingleColumnValuesSafe(sheetName, header) {
    try { return await getSingleColumnValues(sheetName, header); } catch (e) { return []; }
}

// ── Escrita ──────────────────────────────────────────────────────────────

// valueInputOption=USER_ENTERED faz o Sheets interpretar célula começando com
// =/+/-/@ como fórmula — sem isso, um Cliente/Observação com esse prefixo
// (digitado por qualquer vendedor) rodaria como fórmula pra quem abrir a
// planilha direto. Prefixo ' é a forma nativa do Sheets de forçar texto
// literal (o apóstrofo em si não fica salvo, só marca "não avaliar").
function sanitizeRowValues(rowValues) {
    return rowValues.map((v) => (typeof v === 'string' && /^[=+\-@]/.test(v)) ? `'${v}` : v);
}

export async function appendRow(sheetName, rowValues) {
    await sheetsFetch(
        `/values/${encodeRange(sheetName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: [sanitizeRowValues(rowValues)] }) }
    );
}

// Mesma coisa que appendRow, mas manda VÁRIAS linhas num único POST — usado
// pela importação do Radar de Clientes, onde escrever uma linha por vez
// (uma chamada de API cada) estouraria a quota de escrita do Sheets (60
// requisições/100s) num arquivo com centenas/milhares de linhas.
export async function appendRows(sheetName, rowsOfValues) {
    if (!rowsOfValues.length) return;
    await sheetsFetch(
        `/values/${encodeRange(sheetName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: rowsOfValues.map(sanitizeRowValues) }) }
    );
}

// rowNumber é 1-based e já inclui o deslocamento do cabeçalho
// (ex.: primeira linha de dados = rowNumber 2), igual ao `rowIndex + 2` do api.gs.
export async function updateRow(sheetName, rowNumber, rowValues) {
    const lastCol = colToLetter(rowValues.length);
    const range = `${sheetName}!A${rowNumber}:${lastCol}${rowNumber}`;
    await sheetsFetch(
        `/values/${encodeRange(range)}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values: [sanitizeRowValues(rowValues)] }) }
    );
}

// Atualiza VÁRIAS linhas já existentes num único POST (values:batchUpdate —
// distinto do :batchUpdate de estrutura usado por createSheet/deleteRow).
// `updates` é [{ rowNumber, rowValues }, ...]. Mesma motivação de
// appendRows: a importação do Radar pode precisar atualizar centenas de
// linhas existentes (CNPJ já cadastrado, campo informativo mudou) sem
// gastar uma requisição de escrita por linha.
export async function batchUpdateRows(sheetName, updates) {
    if (!updates.length) return;
    const data = updates.map(({ rowNumber, rowValues }) => {
        const lastCol = colToLetter(rowValues.length);
        return {
            range: `${sheetName}!A${rowNumber}:${lastCol}${rowNumber}`,
            values: [sanitizeRowValues(rowValues)]
        };
    });
    await sheetsFetch(
        '/values:batchUpdate',
        { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) }
    );
}

export async function updateCell(sheetName, rowNumber, colNumber, value) {
    const range = `${sheetName}!${colToLetter(colNumber)}${rowNumber}`;
    await sheetsFetch(
        `/values/${encodeRange(range)}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values: [[value]] }) }
    );
}

export async function clearAndWriteColumn(sheetName, headerLabel, values) {
    await sheetsFetch(`/values/${encodeRange(sheetName)}:clear`, { method: 'POST', body: '{}' });
    const rows = [[headerLabel], ...values.filter(Boolean).map((v) => [v])];
    await sheetsFetch(
        `/values/${encodeRange(sheetName + '!A1')}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values: rows }) }
    );
}

export async function appendKeyValue(sheetName, row) {
    await appendRow(sheetName, row);
}

// ── Metadados (existência/criação de aba) ────────────────────────────────

export async function sheetExists(sheetName) {
    const meta = await sheetsFetch('?fields=sheets.properties.title');
    return (meta.sheets || []).some((s) => s.properties.title === sheetName);
}

export async function createSheet(sheetName) {
    await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] })
    });
}

export async function getSheetGid(sheetName) {
    const meta = await sheetsFetch('?fields=sheets.properties');
    const sheet = (meta.sheets || []).find((s) => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Aba "${sheetName}" não encontrada.`);
    return sheet.properties.sheetId;
}

// rowNumber é 1-based e ja inclui o deslocamento do cabecalho (igual updateRow).
// A API do Sheets so permite apagar linha via batchUpdate (values.* nao tem
// "delete row"), usando indices 0-based [startIndex, endIndex).
export async function deleteRow(sheetName, rowNumber) {
    const sheetId = await getSheetGid(sheetName);
    await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({
            requests: [{
                deleteDimension: {
                    range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }
                }
            }]
        })
    });
}

// ── Cache em memória (best-effort, por invocação quente da function) ─────

const _cache = new Map();

export async function withCache(key, ttlSec, fn) {
    const hit = _cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await fn();
    _cache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    return value;
}

export function clearCacheKeys(keys) {
    keys.forEach((k) => _cache.delete(k));
}

// Limpa TODAS as entradas cujo prefixo bate — usado depois de um write pra
// invalidar cache de outros usuários (ex.: gerente/admin com dashboard já
// cacheado) além do próprio autor, já que clearCacheKeys só alcança as
// chaves exatas passadas (tipicamente só as do próprio e-mail do writer).
export function clearCacheByPrefix(prefixes) {
    const list = Array.isArray(prefixes) ? prefixes : [prefixes];
    for (const key of _cache.keys()) {
        if (list.some((p) => key.indexOf(p) === 0)) _cache.delete(key);
    }
}

export { SPREADSHEET_ID };
