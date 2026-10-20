import { appendRow, sheetExists, createSheet } from './sheets.js';
import { formatDate, formatTime } from './common.js';
import { sendPushToVendedor } from './handlers/push.js';
import { resolveAdminsAtivos } from './handlers/lembreteClientes.js';

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

// Rótulo humano + rota de destino por entidade, pro aviso abaixo
// (notificarAdminsMovimentacao) — "apagou" sempre manda pra lista (o
// registro já não existe mais pra abrir um detalhe).
const ENTITY_INFO = {
    visita: { label: 'uma visita', list: 'visits', detail: 'visit-detail' },
    proposta: { label: 'uma proposta', list: 'proposals', detail: 'proposal-detail' },
    funil: { label: 'uma oportunidade no Funil', list: 'funil', detail: 'funil-detail' },
    contrato: { label: 'um contrato', list: 'contratos', detail: 'contrato-detail' },
    manutencao: { label: 'um relatório de Manutenção', list: 'manutencao', detail: 'manutencao-detail' },
    'relatorio-tecnico': { label: 'um relatório SPSP', list: 'manutencao', detail: 'relatorio-tecnico-detail' },
    campanha: { label: 'uma campanha', list: 'campanhas', detail: 'campanhas' }
};

// Avisa todo admin ativo (exceto quem fez a própria ação, se também for
// admin) a cada movimentação registrada em logAudit — pedido explícito:
// visibilidade de tudo que qualquer usuário faz no sistema (visita,
// proposta, funil e demais entidades abaixo), assim que é salvo no banco.
// Best-effort e isolado do try/catch do log em si — mesmo que o log de
// auditoria falhe, o aviso ainda tenta sair.
async function notificarAdminsMovimentacao(user, action, entity, entityId, details) {
    try {
        const userEmail = String(user?.email || '').trim().toLowerCase();
        if (!userEmail) return; // ações sem usuário de verdade (ex.: cron) não geram aviso
        const admins = await resolveAdminsAtivos();
        if (!admins.length) return;
        const info = ENTITY_INFO[entity];
        const primeiroNome = String(user?.name || 'Alguém').split(' ')[0];
        const isDelete = action === 'apagou';
        const page = info ? (isDelete || !entityId ? info.list : info.detail) : 'dashboard';
        const params = info && !isDelete && entityId ? { id: String(entityId) } : undefined;
        for (const a of admins) {
            if (!a.EmailLogin || String(a.EmailLogin).trim().toLowerCase() === userEmail) continue;
            await sendPushToVendedor(a.EmailLogin, {
                title: `🔔 ${primeiroNome} ${action} ${(info && info.label) || entity}`,
                body: details || '',
                page, params, tag: `auditoria-${Date.now()}`, tipo: 'aviso'
            });
        }
    } catch (e) { /* nunca derruba o log em si */ }
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
    await notificarAdminsMovimentacao(user, action, entity, entityId, details);
}
