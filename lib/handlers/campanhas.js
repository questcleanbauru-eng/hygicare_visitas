import {
    getSheetObjects, getSheetWithHeaders, getHeaders, appendRow, updateRow, deleteRow,
    sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { verifyUser, formatDate, resolveCreateId } from '../common.js';
import { logAudit } from '../audit.js';
import { handleUpdateProposal, normalizeProposalRow } from './proposals.js';
import { handleUpdateFunil, normalizeFunilRow } from './funil.js';

// Campanha de atualização: o admin/gerente monta uma lista de Propostas OU
// de Funil, gera um link e manda pro vendedor. O vendedor abre (login normal
// do app), vê cada cliente com o status/comentário atual e um campo pra
// descrever a situação — cada "salvar" grava direto na Proposta/Funil de
// verdade (reaproveitando handleUpdateProposal/handleUpdateFunil, que já
// validam o dono) e marca o item como respondido.

const SHEET = 'Campanhas';
const HEADERS = ['Id', 'Titulo', 'Tipo', 'CriadaPor', 'CriadaPorEmail', 'CriadaEm', 'VendedorDestino', 'PrazoAte', 'Status', 'Itens'];

async function ensureSheet() {
    if (!(await sheetExists(SHEET))) {
        await createSheet(SHEET);
        await appendRow(SHEET, HEADERS);
        return;
    }
    await withCache('campanhas_headers_ensured', 600, async () => {
        const headers = await getHeaders(SHEET);
        const missing = HEADERS.filter((h) => !headers.includes(h));
        if (missing.length) await updateRow(SHEET, 1, [...headers, ...missing]);
        return true;
    });
}

function parseItens(value) {
    try { const v = JSON.parse(value || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
}

function rowToCampanha(row) {
    const itens = parseItens(row.Itens);
    return {
        id: String(row.Id || ''),
        titulo: row.Titulo || '',
        tipo: (row.Tipo || 'proposta'),
        criadaPor: row.CriadaPor || '',
        criadaEm: row.CriadaEm || '',
        vendedorDestino: row.VendedorDestino || '',
        prazoAte: row.PrazoAte || '',
        status: row.Status || 'aberta',
        itens,
        total: itens.length,
        respondidos: itens.filter((i) => i.respondidoEm).length
    };
}

function isAdminOrGerente(user) {
    const p = String(user.profile || '').trim().toLowerCase();
    return p === 'admin' || p === 'gerente';
}

// ── Criar ───────────────────────────────────────────────────────────────
export async function handleCriarCampanha(payload) {
    const user = await verifyUser(payload.user);
    if (!isAdminOrGerente(user)) throw new Error('Só admin ou gerente pode criar campanhas.');

    const tipo = String(payload.tipo || '').trim().toLowerCase();
    if (tipo !== 'proposta' && tipo !== 'funil') throw new Error('Tipo inválido (proposta ou funil).');
    const ids = Array.from(new Set((payload.itemIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
    if (!ids.length) throw new Error('Selecione ao menos um cliente.');
    const vendedor = String(payload.vendedorDestino || '').trim();
    if (!vendedor) throw new Error('Escolha o vendedor que vai preencher.');

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const id = String(resolveCreateId(payload));
    const now = new Date();
    const fields = {
        Id: id,
        Titulo: String(payload.titulo || '').trim() || `Atualização ${formatDate(now)}`,
        Tipo: tipo,
        CriadaPor: user.name,
        CriadaPorEmail: user.email,
        CriadaEm: formatDate(now),
        VendedorDestino: vendedor,
        PrazoAte: payload.prazoAte ? String(payload.prazoAte) : '',
        Status: 'aberta',
        Itens: JSON.stringify(ids.map((itemId) => ({ id: itemId, respondidoEm: '', respondidoPor: '' })))
    };
    await appendRow(SHEET, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'criou', 'campanha', id, fields.Titulo);
    return { status: 'success', campanha: rowToCampanha(fields), id };
}

// ── Ler uma campanha (pro vendedor preencher) ───────────────────────────
export async function handleGetCampanha(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();
    await ensureSheet();
    const rows = await getSheetObjects(SHEET);
    const row = rows.find((r) => String(r.Id || '') === id);
    if (!row) throw new Error('Campanha não encontrada.');
    const campanha = rowToCampanha(row);

    const nome = String(user.name || '').trim().toLowerCase();
    const podeVer = isAdminOrGerente(user) || nome === String(campanha.vendedorDestino || '').trim().toLowerCase();
    if (!podeVer) throw new Error('Esta campanha foi enviada para outro vendedor.');

    // Junta os dados atuais de cada item.
    const sheetName = campanha.tipo === 'funil' ? 'Funil' : 'Propostas';
    const dataRows = await getSheetObjects(sheetName);
    const byId = new Map(dataRows.map((r) => [String(r.Id || r.ID || ''), r]));

    const itens = campanha.itens.map((it) => {
        const raw = byId.get(String(it.id));
        if (!raw) return { id: it.id, respondidoEm: it.respondidoEm, respondidoPor: it.respondidoPor, ausente: true };
        if (campanha.tipo === 'funil') {
            const f = normalizeFunilRow(raw);
            return {
                id: it.id, tipo: 'funil', respondidoEm: it.respondidoEm, respondidoPor: it.respondidoPor,
                cliente: f.cliente, cidade: f.cidade, foco: f.foco, atuacao: f.atuacao, aplicacao: f.aplicacao,
                valor: f.vlMensal, vendedor: f.vendedor, status: f.status, atualizacao: f.atualizacao || f.data,
                comentarios: f.comentarios, motivoPerda: f.motivoPerda
            };
        }
        const p = normalizeProposalRow(raw);
        return {
            id: it.id, tipo: 'proposta', respondidoEm: it.respondidoEm, respondidoPor: it.respondidoPor,
            cliente: p.Cliente, cidade: p.Cidade, foco: p.Foco, produtos: p.Produtos,
            vendedor: p.Vendedor, status: p.Status, atualizacao: p['Atualização'],
            comentarios: p['Atualizar/OBS']
        };
    });

    return { status: 'success', campanha: { ...campanha, itens: undefined }, itens };
}

// ── Responder um item ──────────────────────────────────────────────────
export async function handleResponderCampanhaItem(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.campanhaId || '').trim();
    const itemId = String(payload.itemId || '').trim();

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Campanha não encontrada.');
    const current = rows[rowIndex];
    const campanha = rowToCampanha(current);

    const nome = String(user.name || '').trim().toLowerCase();
    const podeResponder = isAdminOrGerente(user) || nome === String(campanha.vendedorDestino || '').trim().toLowerCase();
    if (!podeResponder) throw new Error('Esta campanha foi enviada para outro vendedor.');

    const itens = campanha.itens;
    const it = itens.find((x) => String(x.id) === itemId);
    if (!it) throw new Error('Item não faz parte desta campanha.');

    // Grava na Proposta/Funil real — reaproveita o handler existente, que já
    // valida se o vendedor é dono da linha.
    if (campanha.tipo === 'funil') {
        await handleUpdateFunil({
            id: itemId, status: payload.status, comentarios: payload.comentario,
            motivoPerda: payload.motivoPerda, user: payload.user
        });
    } else {
        await handleUpdateProposal({
            id: itemId, status: payload.status, obs: payload.comentario, user: payload.user
        });
    }

    it.respondidoEm = formatDate(new Date());
    it.respondidoPor = user.name;
    const todosOk = itens.every((x) => x.respondidoEm);
    const itensKey = Object.keys(current).find((k) => k.toLowerCase() === 'itens') || 'Itens';
    const statusKey = Object.keys(current).find((k) => k.toLowerCase() === 'status') || 'Status';
    current[itensKey] = JSON.stringify(itens);
    if (todosOk) current[statusKey] = 'concluida';

    await updateRow(SHEET, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'respondeu', 'campanha', id, itemId);

    return { status: 'success', respondidos: itens.filter((x) => x.respondidoEm).length, total: itens.length, concluida: todosOk };
}

// ── Lista pro admin acompanhar ─────────────────────────────────────────
export async function handleGetCampanhas(payload) {
    const user = await verifyUser(payload.user);
    if (!isAdminOrGerente(user)) throw new Error('Acesso restrito.');
    await ensureSheet();
    let rows = await withCache('campanhas_all', 60, () => getSheetObjects(SHEET));
    // Gerente vê só as que ele criou; admin vê todas.
    if (String(user.profile || '').trim().toLowerCase() === 'gerente') {
        const e = String(user.email || '').trim().toLowerCase();
        rows = rows.filter((r) => String(r.CriadaPorEmail || '').trim().toLowerCase() === e);
    }
    const campanhas = rows.map(rowToCampanha).sort((a, b) => Number(b.id) - Number(a.id));
    return { status: 'success', campanhas };
}

export async function handleDeleteCampanha(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') throw new Error('Só admin pode apagar campanhas.');
    const id = String(payload.id || '').trim();
    await ensureSheet();
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Campanha não encontrada.');
    await deleteRow(SHEET, rowIndex + 2);
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'apagou', 'campanha', id, rows[rowIndex].Titulo || '');
    return { status: 'success', message: 'Campanha apagada.' };
}
