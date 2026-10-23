import { getSheetObjects, getHeaders, appendRow, updateRow, deleteRow, sheetExists, createSheet, withCache, clearCacheByPrefix } from '../sheets.js';
import { verifyUser, ensureAdmin, formatDate, formatDateFromInput, parseDate, resolveCreateId, ensureTextLength } from '../common.js';
import { logAudit } from '../audit.js';

// "Lembretes administrativos" — pedido explícito: Bruno queria usar o robô
// de WhatsApp como agenda/lembrete pra cobrar o time administrativo (ex.:
// "comprar tal coisa todo mês", "mandar nota fiscal") sem misturar isso com
// Agendamentos (que é especificamente retorno de visita a cliente e entra
// nos relatórios/contagens de vendedor). Sheet própria, só admin cria, mas
// quem está em "Destinatarios" vê e pode concluir/cancelar o que é dele.
const SHEET_NAME = 'LembretesAdministrativos';
const HEADERS = ['Id', 'Texto', 'Destinatarios', 'CriadoPorEmail', 'CriadoPorNome', 'CriadoEm', 'DataAlvo', 'Recorrencia', 'Status', 'AtualizadoEm'];

let _ensured = false;
async function ensureSheet() {
    if (_ensured) return;
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) {
        await createSheet(SHEET_NAME);
        await appendRow(SHEET_NAME, HEADERS);
    }
    _ensured = true;
}

function rowToObject(row) {
    return {
        id: String(row.Id || ''),
        texto: row.Texto || '',
        destinatarios: String(row.Destinatarios || '').split(',').map((s) => s.trim()).filter(Boolean),
        criadoPorEmail: row.CriadoPorEmail || '',
        criadoPorNome: row.CriadoPorNome || '',
        criadoEm: row.CriadoEm || '',
        dataAlvo: row.DataAlvo || '',
        recorrencia: row.Recorrencia || '',
        status: row.Status || 'Pendente',
        atualizadoEm: row.AtualizadoEm || ''
    };
}

// Admin vê tudo; os outros só veem os lembretes onde aparecem como
// destinatário (pra poder concluir/cancelar o que é deles) — nunca a lista
// inteira do time.
export async function readLembretesAdminRows(user) {
    await ensureSheet();
    const rows = await withCache('lembretes_admin_sheet_raw', 60, () => getSheetObjects(SHEET_NAME));
    const parsed = rows.map(rowToObject);
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin') return parsed;
    const userName = String(user.name || '').trim().toLowerCase();
    return parsed.filter((r) => r.destinatarios.some((d) => d.trim().toLowerCase() === userName));
}

export async function handleGetLembretesAdmin(payload) {
    const user = await verifyUser(payload.user);
    const lembretes = await readLembretesAdminRows(user);
    return { status: 'success', lembretes };
}

export async function handleCreateLembreteAdmin(payload) {
    const user = await ensureAdmin(payload.user);
    const texto = String(payload.texto || '').trim();
    if (!texto) throw new Error('Informe o lembrete.');
    ensureTextLength(texto, 'Lembrete');
    const destinatarios = (Array.isArray(payload.destinatarios) ? payload.destinatarios : [])
        .map((d) => String(d || '').trim()).filter(Boolean);
    if (!destinatarios.length) throw new Error('Escolha pelo menos um destinatário.');
    if (!payload.dataAlvo) throw new Error('Informe a data.');
    const recorrencia = payload.recorrencia === 'mensal' ? 'mensal' : '';

    await ensureSheet();
    const headers = await getHeaders(SHEET_NAME);
    const id = resolveCreateId(payload);
    if (payload._queueRetry) {
        const dup = (await getSheetObjects(SHEET_NAME)).find((r) => String(r.Id || '') === String(id));
        if (dup) return { status: 'success', lembrete: rowToObject(dup) };
    }

    const now = formatDate(new Date());
    const fields = {
        Id: id, Texto: texto, Destinatarios: destinatarios.join(','),
        CriadoPorEmail: user.email, CriadoPorNome: user.name, CriadoEm: now,
        DataAlvo: formatDateFromInput(payload.dataAlvo), Recorrencia: recorrencia,
        Status: 'Pendente', AtualizadoEm: now
    };
    await appendRow(SHEET_NAME, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    clearCacheByPrefix(['lembretes_admin_']);
    await logAudit(user, 'criou', 'lembrete-admin', id, texto);
    return { status: 'success', lembrete: rowToObject(fields) };
}

// Mesmo mês/dia do original, mês seguinte — mantém a cadência previsível
// (ex.: sempre dia 5) em vez de só somar 30 dias corridos, que foge do dia
// aos poucos conforme os meses têm tamanhos diferentes.
async function criarProximaOcorrencia(current, headers) {
    const dataAtual = parseDate(current.DataAlvo);
    if (!dataAtual) return null;
    const proxima = new Date(dataAtual.getFullYear(), dataAtual.getMonth() + 1, dataAtual.getDate());
    const now = formatDate(new Date());
    const fields = {
        Id: Date.now(), Texto: current.Texto, Destinatarios: current.Destinatarios,
        CriadoPorEmail: current.CriadoPorEmail, CriadoPorNome: current.CriadoPorNome, CriadoEm: now,
        DataAlvo: formatDate(proxima), Recorrencia: 'mensal', Status: 'Pendente', AtualizadoEm: now
    };
    await appendRow(SHEET_NAME, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    return fields;
}

export async function handleUpdateLembreteAdmin(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    await ensureSheet();
    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Lembrete não encontrado.');
    const current = rows[rowIndex];

    const isAdmin = String(user.profile || '').trim().toLowerCase() === 'admin';
    const destinatarios = String(current.Destinatarios || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const isDestinatario = destinatarios.includes(String(user.name || '').trim().toLowerCase());
    if (!isAdmin && !isDestinatario) throw new Error('Você não tem permissão para mexer nesse lembrete.');

    const novoStatus = payload.status !== undefined ? String(payload.status).trim() : undefined;
    if (novoStatus !== undefined) {
        if (!['Pendente', 'Concluido', 'Cancelado'].includes(novoStatus)) throw new Error('Status inválido.');
        // Quem só é destinatário (não admin) pode concluir/cancelar, nunca
        // reabrir nem editar o conteúdo do lembrete.
        if (!isAdmin && novoStatus === 'Pendente') throw new Error('Você não tem permissão pra reabrir esse lembrete.');
        current.Status = novoStatus;
    }
    if (isAdmin) {
        if (payload.texto !== undefined) {
            const texto = String(payload.texto).trim();
            if (!texto) throw new Error('Informe o lembrete.');
            ensureTextLength(texto, 'Lembrete');
            current.Texto = texto;
        }
        if (payload.destinatarios !== undefined) {
            const list = (Array.isArray(payload.destinatarios) ? payload.destinatarios : [])
                .map((d) => String(d || '').trim()).filter(Boolean);
            if (!list.length) throw new Error('Escolha pelo menos um destinatário.');
            current.Destinatarios = list.join(',');
        }
        if (payload.dataAlvo !== undefined) current.DataAlvo = formatDateFromInput(payload.dataAlvo);
        if (payload.recorrencia !== undefined) current.Recorrencia = payload.recorrencia === 'mensal' ? 'mensal' : '';
    }
    current.AtualizadoEm = formatDate(new Date());

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['lembretes_admin_']);
    await logAudit(
        user,
        novoStatus === 'Concluido' ? 'concluiu' : novoStatus === 'Cancelado' ? 'cancelou' : 'editou',
        'lembrete-admin', id, current.Texto
    );

    // Recorrência mensal: concluir gera sozinho o próximo (ver comentário em
    // criarProximaOcorrencia) — cancelar NÃO gera, é assim que a série para.
    let proximo = null;
    if (novoStatus === 'Concluido' && String(current.Recorrencia || '').trim().toLowerCase() === 'mensal') {
        proximo = await criarProximaOcorrencia(current, headers);
    }

    return { status: 'success', lembrete: rowToObject(current), proximo: proximo ? rowToObject(proximo) : null };
}

export async function handleDeleteLembreteAdmin(payload) {
    const user = await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();

    await ensureSheet();
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Lembrete não encontrado.');
    const texto = rows[rowIndex].Texto || '';

    await deleteRow(SHEET_NAME, rowIndex + 2);
    clearCacheByPrefix(['lembretes_admin_']);
    await logAudit(user, 'apagou', 'lembrete-admin', id, texto);
    return { status: 'success', message: 'Lembrete apagado.' };
}
