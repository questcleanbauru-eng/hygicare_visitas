import {
    getSheetObjects, getHeaders, appendRow, updateRow, sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { verifyUser, ensureAdmin, formatDate, formatTime, resolveCreateId, ensureTextLength } from '../common.js';
import { logAudit } from '../audit.js';
import { handleCreateVisit } from './visits.js';
import { uploadToDrive, CONTRATOS_FOLDER_ID } from '../drive.js';
import { buildComodatoDocx, EMPRESAS_COMODATO } from '../docxComodato.js';

// Comodato de Equipamento: toda semana o Kadu recebe um link (ver
// lembretesAdmin.js, lembrete de Origem 'comodato-semanal') e registra
// quais clientes ficaram com equipamento emprestado essa semana — um ou
// mais equipamentos por cliente, escolhidos de um catálogo já cadastrado
// (reaproveita a lista "Equipamentos" de Admin > Configurações, a mesma
// usada no Funil — ver handleGetFormData). Cada cliente registrado também
// vira uma Visita de verdade (tipo "Comodato de Equipamento"), e o admin
// depois pode gerar o contrato/recibo em PDF/Word a partir daqui.
const SHEET = 'Comodatos';
const HEADERS = [
    'Id', 'LoteId', 'Cliente', 'Cidade', 'AreaAtuacao', 'Equipamento', 'Quantidade',
    'DataInstalacao', 'Observacao', 'Vendedor', 'Status', 'DataRetirada', 'VisitaId',
    'ConferenciaStatus', 'ConferenciaEm',
    'ContratoUrl', 'ContratoEmpresa', 'ContratoModelo', 'ContratoAssinatura', 'ContratoGeradoEm',
    'CriadoEm', 'AtualizadoEm'
];

async function ensureSheet() {
    if (!(await sheetExists(SHEET))) {
        await createSheet(SHEET);
        await appendRow(SHEET, HEADERS);
        return;
    }
    await withCache('comodatos_headers_ensured', 600, async () => {
        const headers = await getHeaders(SHEET);
        const missing = HEADERS.filter((h) => !headers.includes(h));
        if (missing.length) await updateRow(SHEET, 1, [...headers, ...missing]);
        return true;
    });
}

function isAdminOrGerente(user) {
    const p = String(user.profile || '').trim().toLowerCase();
    return p === 'admin' || p === 'gerente';
}

function rowToObject(row) {
    return {
        id: String(row.Id || ''),
        loteId: String(row.LoteId || ''),
        cliente: row.Cliente || '',
        cidade: row.Cidade || '',
        areaAtuacao: row.AreaAtuacao || '',
        equipamento: row.Equipamento || '',
        quantidade: Number(row.Quantidade) || 1,
        dataInstalacao: row.DataInstalacao || '',
        observacao: row.Observacao || '',
        vendedor: row.Vendedor || '',
        status: row.Status || 'Ativo',
        dataRetirada: row.DataRetirada || '',
        visitaId: row.VisitaId || '',
        conferenciaStatus: row.ConferenciaStatus || '',
        conferenciaEm: row.ConferenciaEm || '',
        contratoUrl: row.ContratoUrl || '',
        contratoEmpresa: row.ContratoEmpresa || '',
        contratoModelo: row.ContratoModelo || '',
        contratoAssinatura: row.ContratoAssinatura || '',
        contratoGeradoEm: row.ContratoGeradoEm || '',
        criadoEm: row.CriadoEm || '',
        atualizadoEm: row.AtualizadoEm || ''
    };
}

async function readComodatoRows() {
    await ensureSheet();
    const rows = await withCache('comodatos_all', 60, () => getSheetObjects(SHEET));
    return rows.map(rowToObject);
}

// ── Listar (painel admin) ───────────────────────────────────────────────
export async function handleGetComodatos(payload) {
    const user = await verifyUser(payload.user);
    if (!isAdminOrGerente(user)) throw new Error('Acesso restrito.');
    const comodatos = await readComodatoRows();
    return { status: 'success', comodatos };
}

function validarEquipamentos(equipamentos) {
    const list = Array.isArray(equipamentos) ? equipamentos : [];
    const limpos = list
        .map((e) => ({ nome: String((e && e.nome) || '').trim(), quantidade: Math.max(1, Number(e && e.quantidade) || 1) }))
        .filter((e) => e.nome);
    return limpos;
}

// ── Kadu registra o comodato da semana (um ou mais clientes, um ou mais
// equipamentos por cliente) ─────────────────────────────────────────────
export async function handleCreateComodatoLote(payload) {
    const user = await verifyUser(payload.user);
    const blocos = Array.isArray(payload.clientes) ? payload.clientes : [];
    if (!blocos.length) throw new Error('Informe pelo menos um cliente.');

    const normalizados = blocos.map((b) => ({
        cliente: String((b && b.cliente) || '').trim(),
        cidade: String((b && b.cidade) || '').trim(),
        areaAtuacao: String((b && b.areaAtuacao) || '').trim(),
        dataInstalacao: (b && b.dataInstalacao) || '',
        observacao: String((b && b.observacao) || '').trim(),
        equipamentos: validarEquipamentos(b && b.equipamentos)
    }));
    for (const b of normalizados) {
        if (!b.cliente) throw new Error('Informe o cliente em cada bloco.');
        if (!b.dataInstalacao) throw new Error(`Informe a data da instalação para ${b.cliente}.`);
        if (!b.equipamentos.length) throw new Error(`Informe ao menos um equipamento para ${b.cliente}.`);
        ensureTextLength(b.observacao, 'Observação');
    }

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const baseId = resolveCreateId(payload);
    const loteId = String(baseId);
    if (payload._queueRetry) {
        const existing = await getSheetObjects(SHEET);
        if (existing.some((r) => String(r.LoteId || '') === loteId)) {
            return { status: 'success', loteId };
        }
    }

    const now = formatDate(new Date());
    const visitas = [];
    let seq = 0;
    for (const bloco of normalizados) {
        const resumoItens = bloco.equipamentos.map((e) => `${e.quantidade}x ${e.nome}`).join(', ');
        const observacaoVisita = `Comodato de equipamento registrado: ${resumoItens}.${bloco.observacao ? ' ' + bloco.observacao : ''}`;
        let visitaId = '';
        try {
            const createRes = await handleCreateVisit({
                user: payload.user,
                dataVisita: bloco.dataInstalacao,
                horario: formatTime(new Date()),
                cliente: bloco.cliente,
                cidade: bloco.cidade,
                areaAtuacao: bloco.areaAtuacao,
                tipoVisita: 'Comodato de Equipamento',
                observacao: observacaoVisita
            });
            const createdVisit = createRes && (createRes.visit || (createRes.visits && createRes.visits[0]));
            visitaId = createdVisit ? String(createdVisit.ID || createdVisit.id || '') : '';
        } catch (e) {
            // Não bloqueia o registro do comodato por causa da visita (ex.:
            // cidade/área de atuação vieram vazias porque o cliente não está
            // no cadastro) — o comodato em si é o que importa salvar.
        }
        if (visitaId) visitas.push({ cliente: bloco.cliente, visitaId });

        for (const equip of bloco.equipamentos) {
            const fields = {
                Id: `${baseId}_${seq}`, LoteId: loteId, Cliente: bloco.cliente, Cidade: bloco.cidade, AreaAtuacao: bloco.areaAtuacao,
                Equipamento: equip.nome, Quantidade: equip.quantidade, DataInstalacao: bloco.dataInstalacao,
                Observacao: bloco.observacao, Vendedor: user.name, Status: 'Ativo', DataRetirada: '', VisitaId: visitaId,
                ConferenciaStatus: '', ConferenciaEm: '',
                ContratoUrl: '', ContratoEmpresa: '', ContratoModelo: '', ContratoAssinatura: '', ContratoGeradoEm: '',
                CriadoEm: now, AtualizadoEm: now
            };
            await appendRow(SHEET, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
            seq++;
        }
    }

    clearCacheByPrefix(['comodatos_']);
    await logAudit(user, 'registrou', 'comodato', loteId, normalizados.map((b) => b.cliente).join(', '));

    return { status: 'success', loteId, clientes: normalizados.length, visitas };
}

// ── Admin marca um grupo (cliente + equipamentos de um lote) como retirado
export async function handleMarcarComodatoRetirado(payload) {
    const user = await ensureAdmin(payload.user);
    const ids = Array.from(new Set((payload.ids || []).map((x) => String(x || '').trim()).filter(Boolean)));
    if (!ids.length) throw new Error('Nenhum item selecionado.');

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const hoje = formatDate(new Date());
    let marcados = 0;
    for (let i = 0; i < rows.length; i++) {
        if (!ids.includes(String(rows[i].Id || ''))) continue;
        const r = rows[i];
        r.Status = 'Retirado';
        r.DataRetirada = hoje;
        r.AtualizadoEm = hoje;
        await updateRow(SHEET, i + 2, headers.map((h) => (r[h] !== undefined ? r[h] : '')));
        marcados++;
    }
    if (!marcados) throw new Error('Nenhum dos itens foi encontrado.');
    clearCacheByPrefix(['comodatos_']);
    await logAudit(user, 'marcou retirado', 'comodato', ids.join(','), `${marcados} item(ns)`);
    return { status: 'success', marcados };
}

// ── Kadu confirma, na conferência periódica, quais itens ainda estão com
// o cliente — só sinaliza (ConferenciaStatus), quem efetiva a retirada no
// painel continua sendo o admin (handleMarcarComodatoRetirado acima).
export async function handleRegistrarConferenciaComodato(payload) {
    const user = await verifyUser(payload.user);
    const respostas = Array.isArray(payload.respostas) ? payload.respostas : [];
    if (!respostas.length) throw new Error('Nenhuma resposta enviada.');
    const porId = new Map(respostas.map((r) => [String(r.id || ''), String(r.status || '').trim()]));

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const now = formatDate(new Date());
    let atualizados = 0;
    for (let i = 0; i < rows.length; i++) {
        const id = String(rows[i].Id || '');
        if (!porId.has(id)) continue;
        const status = porId.get(id);
        if (!['confirmado', 'nao_encontrado'].includes(status)) continue;
        const r = rows[i];
        r.ConferenciaStatus = status;
        r.ConferenciaEm = now;
        await updateRow(SHEET, i + 2, headers.map((h) => (r[h] !== undefined ? r[h] : '')));
        atualizados++;
    }
    clearCacheByPrefix(['comodatos_']);
    await logAudit(user, 'respondeu conferência', 'comodato', '', `${atualizados} item(ns)`);
    return { status: 'success', atualizados };
}

// ── Gera o contrato/recibo (Word) e sobe pro Drive, na pasta já usada por
// Contratos (CONTRATOS_FOLDER_ID) — sem pasta nova pra configurar.
export async function handleGerarContratoComodato(payload) {
    const user = await ensureAdmin(payload.user);
    const loteId = String(payload.loteId || '').trim();
    const cliente = String(payload.cliente || '').trim();
    if (!loteId || !cliente) throw new Error('Informe o lote e o cliente.');
    const empresaKey = EMPRESAS_COMODATO[payload.empresa] ? payload.empresa : 'hygicare';
    const modelo = payload.modelo === 'simples' ? 'simples' : 'elaborado';
    const assinatura = payload.assinatura === 'app' ? 'app' : 'externa';

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const indices = [];
    rows.forEach((r, i) => { if (String(r.LoteId || '') === loteId && String(r.Cliente || '') === cliente) indices.push(i); });
    if (!indices.length) throw new Error('Comodato não encontrado.');

    const itens = indices.map((i) => ({ equipamento: rows[i].Equipamento || '', quantidade: Number(rows[i].Quantidade) || 1, observacao: '' }));
    const observacao = rows[indices[0]].Observacao || '';
    const overrides = (payload.clienteOverrides && typeof payload.clienteOverrides === 'object') ? payload.clienteOverrides : {};
    const clienteInfo = {
        nome: cliente,
        cnpj: String(overrides.cnpj || '').trim(),
        endereco: String(overrides.endereco || '').trim(),
        bairro: String(overrides.bairro || '').trim(),
        cidade: String(overrides.cidade || rows[indices[0]].Cidade || '').trim(),
        estado: String(overrides.estado || '').trim(),
        cep: String(overrides.cep || '').trim()
    };

    const buffer = await buildComodatoDocx({ empresaKey, modelo, cliente: clienteInfo, itens, dataContrato: new Date(), observacao });
    const nomeArquivo = `Comodato - ${cliente} - ${formatDate(new Date()).replace(/\//g, '-')}.docx`;
    const upload = await uploadToDrive({
        folderId: CONTRATOS_FOLDER_ID,
        name: nomeArquivo,
        base64: buffer.toString('base64'),
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        kind: 'documento'
    });

    const now = formatDate(new Date());
    for (const i of indices) {
        const r = rows[i];
        r.ContratoUrl = upload.viewUrl;
        r.ContratoEmpresa = empresaKey;
        r.ContratoModelo = modelo;
        r.ContratoAssinatura = assinatura;
        r.ContratoGeradoEm = now;
        r.AtualizadoEm = now;
        await updateRow(SHEET, i + 2, headers.map((h) => (r[h] !== undefined ? r[h] : '')));
    }
    clearCacheByPrefix(['comodatos_']);
    await logAudit(user, 'gerou contrato', 'comodato', loteId, cliente);

    return { status: 'success', url: upload.viewUrl };
}
