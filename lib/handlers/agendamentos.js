import { getSheetObjects, getHeaders, getSheetWithHeaders, appendRow, updateRow, deleteRow, sheetExists, createSheet, withCache, clearCacheByPrefix } from '../sheets.js';
import { verifyUser, formatDate, formatDateFromInput, userOwnsRow, ensureTextLength } from '../common.js';
import { ensureCanDelete } from './config.js';

const SHEET_NAME = 'Agendamentos';
const HEADERS = ['Id', 'Vendedor', 'Cliente', 'Cidade', 'DataAgendada', 'Observacao', 'Status', 'VisitaOrigemId', 'Data'];

async function ensureAgendamentosSheet() {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) {
        await createSheet(SHEET_NAME);
        await appendRow(SHEET_NAME, HEADERS);
    }
}

function findKey(headers, candidates) {
    const lower = headers.map((h) => String(h).trim().toLowerCase());
    for (const c of candidates) {
        const idx = lower.indexOf(c.toLowerCase().trim());
        if (idx > -1) return headers[idx];
    }
    return null;
}

// Sem coluna Gerência (igual Contratos) — Gerente enxerga tudo, Vendedor só o próprio.
function filterAgendamentosByUser(items, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin' || profile === 'gerente') return items;
    const userName = String(user.name || '').trim().toLowerCase();
    return items.filter((item) => String(item.vendedor || '').trim().toLowerCase() === userName);
}

export async function readAgendamentoRows(user) {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) return [];
    const { headers, rows } = await getSheetWithHeaders(SHEET_NAME);
    if (!headers.length) return [];

    const key = {
        id: findKey(headers, ['Id', 'ID']),
        vend: findKey(headers, ['Vendedor', 'VENDEDOR']),
        cli: findKey(headers, ['Cliente', 'CLIENTE']),
        cid: findKey(headers, ['Cidade', 'CIDADE']),
        dataAg: findKey(headers, ['DataAgendada', 'DATAAGENDADA', 'Data Agendada']),
        obs: findKey(headers, ['Observacao', 'OBSERVACAO', 'Observação']),
        status: findKey(headers, ['Status', 'STATUS']),
        origem: findKey(headers, ['VisitaOrigemId', 'VISITAORIGEMID']),
        data: findKey(headers, ['Data', 'DATA'])
    };

    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    const parsed = rows.map((row) => ({
        id: s(row, key.id),
        vendedor: s(row, key.vend),
        cliente: s(row, key.cli),
        cidade: s(row, key.cid),
        dataAgendada: s(row, key.dataAg),
        observacao: s(row, key.obs),
        status: s(row, key.status) || 'Pendente',
        visitaOrigemId: s(row, key.origem),
        data: s(row, key.data)
    }));

    return filterAgendamentosByUser(parsed, user);
}

function buildAgendamentoRowData(headers, fields) {
    return headers.map((h) => {
        const lh = h.toLowerCase().trim();
        const matchKey = Object.keys(fields).find((k) => k.toLowerCase().trim() === lh);
        return matchKey !== undefined ? fields[matchKey] : '';
    });
}

export async function handleGetAgendamentos(payload) {
    const user = await verifyUser(payload.user);
    const rows = await withCache('ag_' + user.email, 120, () => readAgendamentoRows(user));
    return { status: 'success', agendamentos: rows };
}

export async function handleCreateAgendamento(payload) {
    const user = await verifyUser(payload.user);
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');
    if (!payload.dataAgendada) throw new Error('Data do agendamento é obrigatória.');
    ensureTextLength(payload.observacao, 'Observação');

    await ensureAgendamentosSheet();
    const headers = await getHeaders(SHEET_NAME);
    // ID por timestamp evita colisão entre dois agendamentos criados ao
    // mesmo tempo por usuários diferentes (Sheets API não tem escrita atômica).
    const id = Date.now();

    const fields = {
        'Id': id,
        'Vendedor': user.name,
        'Cliente': payload.cliente,
        'Cidade': payload.cidade || '',
        'DataAgendada': formatDateFromInput(payload.dataAgendada),
        'Observacao': payload.observacao || '',
        'Status': 'Pendente',
        'VisitaOrigemId': payload.visitaOrigemId || '',
        'Data': formatDate(new Date())
    };

    await appendRow(SHEET_NAME, buildAgendamentoRowData(headers, fields));
    clearCacheByPrefix(['ag_', 'd_']);
    return {
        status: 'success',
        agendamento: {
            id: String(id), vendedor: fields.Vendedor, cliente: fields.Cliente, cidade: fields.Cidade,
            dataAgendada: fields.DataAgendada, observacao: fields.Observacao, status: fields.Status,
            visitaOrigemId: fields.VisitaOrigemId, data: fields.Data
        }
    };
}

export async function handleUpdateAgendamento(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Agendamento não encontrado para atualização.');

    const current = rows[rowIndex];
    const findCurrentKey = (candidates) => Object.keys(current).find((k) => candidates.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
    const keyMap = {
        status: findCurrentKey(['status']) || 'Status',
        dataAg: findCurrentKey(['dataagendada']) || 'DataAgendada',
        obs: findCurrentKey(['observacao']) || 'Observacao',
        vend: findCurrentKey(['vendedor']) || 'Vendedor'
    };
    if (!userOwnsRow({ Vendedor: current[keyMap.vend] }, user, 'agendamentos')) {
        throw new Error('Você não tem permissão para editar este agendamento.');
    }
    ensureTextLength(payload.observacao, 'Observação');

    if (payload.status !== undefined) current[keyMap.status] = payload.status;
    if (payload.dataAgendada !== undefined) current[keyMap.dataAg] = formatDateFromInput(payload.dataAgendada);
    if (payload.observacao !== undefined) current[keyMap.obs] = payload.observacao;

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['ag_', 'd_']);
    return { status: 'success', agendamento: (await readAgendamentoRows(user)).find((r) => String(r.id) === id) };
}

export async function handleDeleteAgendamento(payload) {
    const user = await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Agendamento não encontrado para exclusão.');

    await deleteRow(SHEET_NAME, rowIndex + 2);
    clearCacheByPrefix(['ag_', 'd_']);
    return { status: 'success', message: 'Agendamento apagado.' };
}
