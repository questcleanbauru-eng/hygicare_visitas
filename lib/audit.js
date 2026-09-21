import { appendRow, sheetExists, createSheet } from './sheets.js';
import { formatDate, formatTime } from './common.js';

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
//
// Não tem leitura correspondente no app (Admin > Auditoria só linka pra
// planilha de verdade) — a aba só cresce, e listar isso no app viraria
// uma tela cada vez mais pesada sem necessidade nenhuma.
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
