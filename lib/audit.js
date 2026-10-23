import { appendRow, sheetExists, createSheet } from './sheets.js';
import { formatDate, formatTime } from './common.js';
import { sendPushToVendedor } from './handlers/push.js';
import { resolveAdminsAtivos, resolveGerentesPorGerencia } from './handlers/lembreteClientes.js';

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
// (notificarMovimentacao) — "apagou" sempre manda pra lista (o registro já
// não existe mais pra abrir um detalhe).
const ENTITY_INFO = {
    visita: { label: 'uma visita', list: 'visits', detail: 'visit-detail' },
    proposta: { label: 'uma proposta', list: 'proposals', detail: 'proposal-detail' },
    funil: { label: 'uma oportunidade no Funil', list: 'funil', detail: 'funil-detail' },
    contrato: { label: 'um contrato', list: 'contratos', detail: 'contrato-detail' },
    manutencao: { label: 'um relatório de Manutenção', list: 'manutencao', detail: 'manutencao-detail' },
    'relatorio-tecnico': { label: 'um relatório SPSP', list: 'manutencao', detail: 'relatorio-tecnico-detail' },
    campanha: { label: 'uma campanha', list: 'campanhas', detail: 'campanhas' },
    'lembrete-admin': { label: 'um lembrete administrativo', list: 'lembretes', detail: 'lembretes' }
};

// Avisa todo admin ativo + o(s) gerente(s) da gerência de quem fez a ação
// (exceto a própria pessoa, se ela estiver nessa lista) a cada movimentação
// registrada em logAudit — pedido explícito: visibilidade de tudo que
// qualquer usuário faz no sistema (visita, proposta, funil e demais
// entidades abaixo), assim que é salvo no banco, pros admins E pro gerente
// direto do vendedor que fez a ação. Best-effort e isolado do try/catch do
// log em si — mesmo que o log de auditoria falhe, o aviso ainda tenta sair.
async function notificarMovimentacao(user, action, entity, entityId, details) {
    try {
        const userEmail = String(user?.email || '').trim().toLowerCase();
        if (!userEmail) return; // ações sem usuário de verdade (ex.: cron) não geram aviso
        const [admins, gerentes] = await Promise.all([
            resolveAdminsAtivos(),
            resolveGerentesPorGerencia(user?.gerencia)
        ]);
        // Dedupe por e-mail — a mesma pessoa não poderia estar em admins E
        // gerentes ao mesmo tempo, mas um gerente poderia por acaso aparecer
        // 2x se a planilha tiver linha duplicada; Map garante 1 envio só.
        const destinatarios = new Map();
        [...admins, ...gerentes].forEach((r) => {
            const email = String(r.EmailLogin || '').trim().toLowerCase();
            if (email) destinatarios.set(email, true);
        });
        destinatarios.delete(userEmail); // nunca avisa quem fez a própria ação
        if (!destinatarios.size) return;
        const info = ENTITY_INFO[entity];
        const primeiroNome = String(user?.name || 'Alguém').split(' ')[0];
        const isDelete = action === 'apagou';
        const page = info ? (isDelete || !entityId ? info.list : info.detail) : 'dashboard';
        const params = info && !isDelete && entityId ? { id: String(entityId) } : undefined;
        // Em paralelo, não um por um — cada sendPushToVendedor é um round-trip
        // de webpush; sequencial somava a latência de todo mundo em cima da
        // operação sendo registrada (criar/editar visita etc.), empurrando
        // requisições já no limite pra passar dos 30s e abortar no cliente.
        await Promise.all(Array.from(destinatarios.keys()).map((email) => sendPushToVendedor(email, {
            title: `🔔 ${primeiroNome} ${action} ${(info && info.label) || entity}`,
            body: details || '',
            page, params, tag: `auditoria-${Date.now()}`, tipo: 'aviso'
        })));
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
    await notificarMovimentacao(user, action, entity, entityId, details);
}
