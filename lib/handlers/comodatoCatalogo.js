import {
    getSheetObjects, getHeaders, appendRow, updateRow, deleteRow, sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { verifyUser, ensureAdmin, formatDate, ensureTextLength } from '../common.js';
import { logAudit } from '../audit.js';
import { uploadToDrive, deleteDriveFile, FOTOS_MANUTENCAO_FOLDER_ID } from '../drive.js';

// Catálogo de equipamentos do Comodato — pedido do Bruno: a tela que o Kadu
// vê pra registrar comodato era um <select> de texto puro (só o nome);
// agora cada equipamento pode ter foto + descrição, "estilo cardápio".
// Reaproveita a pasta do Drive já usada pelas fotos de Manutenção
// (FOTOS_MANUTENCAO_FOLDER_ID) de propósito — mesmo raciocínio já aplicado
// em handleGerarContratoComodato (reusa CONTRATOS_FOLDER_ID): não vale criar
// uma pasta nova (e pedir pro Bruno configurar uma env var nova) só por
// causa disso.
const SHEET = 'ComodatoCatalogo';
const HEADERS = ['Id', 'Nome', 'Descricao', 'FotoId', 'AtualizadoPor', 'AtualizadoEm'];

async function ensureSheet() {
    if (!(await sheetExists(SHEET))) {
        await createSheet(SHEET);
        await appendRow(SHEET, HEADERS);
    }
}

function driveThumbUrl(id) {
    return id ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w500` : '';
}

function rowToObject(row) {
    return {
        id: String(row.Id || ''),
        nome: row.Nome || '',
        descricao: row.Descricao || '',
        fotoId: row.FotoId || '',
        fotoUrl: driveThumbUrl(row.FotoId || ''),
        atualizadoEm: row.AtualizadoEm || ''
    };
}

async function readCatalogoRows() {
    await ensureSheet();
    const rows = await withCache('comodato_catalogo_all', 60, () => getSheetObjects(SHEET));
    return rows.map(rowToObject).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// Qualquer usuário autenticado pode ler (precisa aparecer no formulário do
// Kadu, que não é admin) — só escrever/apagar é restrito ao admin.
export async function handleGetComodatoCatalogo(payload) {
    await verifyUser(payload.user);
    const itens = await readCatalogoRows();
    return { status: 'success', itens };
}

// Upsert por Id (edição) ou cria novo quando vem sem Id — mesmo padrão de
// ManutencaoModelos (ver handleSaveManutencaoModelo).
export async function handleSaveComodatoCatalogoItem(payload) {
    const user = await ensureAdmin(payload.user);
    const nome = String(payload.nome || '').trim();
    if (!nome) throw new Error('Informe o nome do equipamento.');
    const descricao = String(payload.descricao || '').trim();
    ensureTextLength(descricao, 'Descrição');

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const id = String(payload.id || '').trim();
    const now = formatDate(new Date());
    const rowIndex = id ? rows.findIndex((r) => String(r.Id || '') === id) : -1;

    const fields = {
        Id: id || String(Date.now()),
        Nome: nome,
        Descricao: descricao,
        FotoId: rowIndex > -1 ? (rows[rowIndex].FotoId || '') : '',
        AtualizadoPor: user.name,
        AtualizadoEm: now
    };
    const rowData = headers.map((h) => (fields[h] !== undefined ? fields[h] : ''));
    if (rowIndex > -1) await updateRow(SHEET, rowIndex + 2, rowData);
    else await appendRow(SHEET, rowData);

    clearCacheByPrefix(['comodato_catalogo_']);
    await logAudit(user, rowIndex > -1 ? 'editou' : 'criou', 'comodato-catalogo', fields.Id, nome);
    return { status: 'success', item: rowToObject(fields) };
}

export async function handleUploadComodatoCatalogoFoto(payload) {
    const user = await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();
    if (!id) throw new Error('Salve o equipamento antes de enviar a foto.');
    const dataUrl = payload.imagem || payload.dataUrl || '';
    if (!dataUrl) throw new Error('Nenhuma imagem recebida.');

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Equipamento não encontrado.');
    const current = rows[rowIndex];

    const nome = String(current.Nome || 'equipamento').replace(/[\\/:*?"<>|]/g, '-');
    const up = await uploadToDrive({
        folderId: FOTOS_MANUTENCAO_FOLDER_ID,
        name: `Catálogo Comodato - ${nome}.jpg`,
        dataUrl,
        kind: 'image'
    });

    const fotoAntiga = current.FotoId || '';
    current.FotoId = up.id;
    current.AtualizadoPor = user.name;
    current.AtualizadoEm = formatDate(new Date());
    await updateRow(SHEET, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['comodato_catalogo_']);
    if (fotoAntiga) await deleteDriveFile(fotoAntiga);

    return { status: 'success', fotoId: up.id, fotoUrl: driveThumbUrl(up.id) };
}

export async function handleDeleteComodatoCatalogoItem(payload) {
    const user = await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();
    if (!id) throw new Error('Informe o equipamento.');

    await ensureSheet();
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Equipamento não encontrado.');
    const fotoId = rows[rowIndex].FotoId || '';
    const nome = rows[rowIndex].Nome || '';

    await deleteRow(SHEET, rowIndex + 2);
    clearCacheByPrefix(['comodato_catalogo_']);
    if (fotoId) await deleteDriveFile(fotoId);
    await logAudit(user, 'apagou', 'comodato-catalogo', id, nome);
    return { status: 'success' };
}
