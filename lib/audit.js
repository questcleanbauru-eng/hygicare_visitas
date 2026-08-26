import { appendRow, getSheetValues, sheetExists, createSheet, withCache } from './sheets.js';
import { formatDate, formatTime, ensureAdmin } from './common.js';

const SHEET_NAME = 'Auditoria';
const HEADERS = ['Id', 'Data', 'Hora', 'UsuarioEmail', 'UsuarioNome', 'Acao', 'Entidade', 'EntidadeId', 'Detalhes'];

let _ensured = false;
async function ensureAuditSheet() {
    if (_ensured) return;
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) {
        await createSheet(SHEET_NAME);
        await appendRow(SHEET_NAME, HEADERS);
    }
    _ensured = true;
}

// Best-effort de propósito: um log que falha nunca pode derrubar a operação
// de negócio (criar/editar/apagar visita, proposta etc.) que está sendo
// registrada — por isso o erro só vai pro console do servidor.
export async function logAudit(user, action, entity, entityId, details) {
    try {
        await ensureAuditSheet();
        const now = new Date();
        await appendRow(SHEET_NAME, [
            Date.now(),
            formatDate(now),
            formatTime(now),
            user?.email || '',
            user?.name || '',
            action,
            entity,
            String(entityId ?? ''),
            details || ''
        ]);
    } catch (e) {
        console.error('logAudit failed:', e);
    }
}

export async function handleGetAuditoria(payload) {
    await ensureAdmin(payload.user);
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) return { status: 'success', entries: [] };

    const values = await withCache('auditoria_raw', 30, () => getSheetValues(SHEET_NAME));
    const rows = values.slice(1);
    const entries = rows.map((r) => ({
        id: r[0] || '', data: r[1] || '', hora: r[2] || '', usuarioEmail: r[3] || '',
        usuarioNome: r[4] || '', acao: r[5] || '', entidade: r[6] || '', entidadeId: r[7] || '', detalhes: r[8] || ''
    })).reverse().slice(0, 300);

    return { status: 'success', entries };
}
