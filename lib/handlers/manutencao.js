import {
    getSheetObjects, getHeaders, getSheetWithHeaders, appendRow, updateRow, deleteRow,
    sheetExists, createSheet, clearAndWriteColumn, withCache, clearCacheByPrefix
} from '../sheets.js';
import { verifyUser, ensureAdmin, formatDate, resolveCreateId, ensureTextLength, isConfigOn } from '../common.js';
import { ensureCanDelete, readEmailConfig } from './config.js';

const SHEET_NAME = 'Manutencoes';
const HEADERS = [
    'Id', 'Data', 'Tecnico', 'Gerencia', 'Cliente', 'Cidade',
    'TipoRelatorio', 'TipoVisita', 'TipoEquipamento',
    'ItensTabela', 'PecasDiluidor', 'Observacao',
    'AssinaturaTecnico', 'AssinaturaCliente', 'PendenteAprovacao', 'SyncTimestamp',
    // Colunas específicas do relatório "Atendimento ao Cliente — Lavanderia":
    'Vendedor', 'EquipamentoNome',
    'TipoMaquina', 'HoraChegada', 'HoraSaida', 'Refeicao', 'KmInicial', 'KmFinal',
    'ChecklistDosador1', 'ChecklistDosador2', 'ChecklistMaquina1', 'ChecklistMaquina2',
    'ChecklistEstocagem1', 'ChecklistEstocagem2', 'VazoesBombas',
    'ProblemasMaquina', 'ProblemasEstocagem'
];

async function ensureManutencoesSheet() {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) {
        await createSheet(SHEET_NAME);
        await appendRow(SHEET_NAME, HEADERS);
    }
}

// Listas editáveis (Admin → Listas) usadas nos formulários de Manutenção —
// nascem semeadas com os mesmos valores que antes eram fixos no código;
// depois disso o Admin edita/adiciona/remove item sem precisar de deploy
// (mesmo sistema de "Listas de Apoio" que Cidades/Equipamentos já usam).
export const MANUTENCAO_LISTS = {
    mntTipoEquipamento: { sheet: 'MntTipoEquipamento', header: 'Item', seed: ['Promax', 'Tron', 'NTI'], label: 'Tipo de Equipamento (Calibração)' },
    mntTipoVisitaCalibracao: { sheet: 'MntTipoVisitaCalibracao', header: 'Item', seed: ['Preventiva', 'Corretiva', 'Aferição'], label: 'Tipo de Visita (Calibração)' },
    mntPecasDiluidor: { sheet: 'MntPecasDiluidor', header: 'Item', seed: ['Válvula Pé', 'Mangueira Solução', 'Mangueira Pescador', 'TIP Diluição'], label: 'Peças do Diluidor' },
    mntTipoMaquinaLavanderia: { sheet: 'MntTipoMaquinaLavanderia', header: 'Item', seed: ['Automática', 'Convencional', 'Semi Automática'], label: 'Tipo de Máquina (Lavanderia)' },
    mntTipoVisitaLavanderia: { sheet: 'MntTipoVisitaLavanderia', header: 'Item', seed: ['Preventiva', 'Corretiva'], label: 'Tipo de Visita (Lavanderia)' },
    mntDosadorGrupo1: { sheet: 'MntDosadorGrupo1', header: 'Item', seed: ['Tensão de entrada', 'Regulador de pressão', 'Manômetro', 'Válv. Solenóide', 'Corrente motor', 'Vazões', 'Tubo silastic', 'Roletes'], label: 'Checklist Dosador — Grupo 1' },
    mntDosadorGrupo2: { sheet: 'MntDosadorGrupo2', header: 'Item', seed: ['Tampa da Carcaça', 'Cabos elétricos', 'Tubos guia', 'Mangueiras', 'Conexões', 'Motobomba', 'Padronização Instalações', 'Limpeza geral'], label: 'Checklist Dosador — Grupo 2' },
    mntMaquinaGrupo1: { sheet: 'MntMaquinaGrupo1', header: 'Item', seed: ['Pressostato de nível', 'Nível de água', 'Atuador pneumático', 'Pulmão de nível', 'Lubrifil', 'Sensor de mercúrio', 'Sensor de temperatura'], label: 'Checklist Máquina — Grupo 1' },
    mntMaquinaGrupo2: { sheet: 'MntMaquinaGrupo2', header: 'Item', seed: ['Rotação de Cesto', 'Dreno', 'Válv. Solenóide água', 'Válv. Solenóide ar', 'Vapor', 'Ponto de injeção', 'Painel de comando'], label: 'Checklist Máquina — Grupo 2' },
    mntEstocagemGrupo1: { sheet: 'MntEstocagemGrupo1', header: 'Item', seed: ['Bombonas', 'Reservatório', 'Tubulação', 'Manifold PP', 'Contenção'], label: 'Checklist Estocagem — Grupo 1' },
    mntEstocagemGrupo2: { sheet: 'MntEstocagemGrupo2', header: 'Item', seed: ['Limpa/Seca', 'Mangueiras', 'Funcionamento', 'Bomba recalque', 'Chuveiro lava olhos'], label: 'Checklist Estocagem — Grupo 2' }
};

// Chamado tanto de handleGetAdminData (admin.js) quanto de handleGetFormData
// (formdata.js) — o cache de 1h garante que só a PRIMEIRA chamada (de
// qualquer um dos dois) realmente cria as abas que ainda não existem;
// depois disso vira um no-op até o cache expirar.
export async function ensureManutencaoListSheets() {
    await withCache('mnt_listas_ensured', 3600, async () => {
        for (const key of Object.keys(MANUTENCAO_LISTS)) {
            const { sheet, header, seed } = MANUTENCAO_LISTS[key];
            const exists = await sheetExists(sheet);
            if (!exists) {
                await createSheet(sheet);
                await clearAndWriteColumn(sheet, header, seed);
            }
        }
        return true;
    });
}

// [coluna na planilha, nome do campo no objeto usado pelo app] — todos
// texto simples (ou JSON numa célula só, ex.: checklists/vazões), só
// existem no relatório "Atendimento ao Cliente — Lavanderia". Declarados
// uma vez só e reaproveitados num loop em leitura/criação/atualização, em
// vez de repetir a mesma lista de 23 campos 3 vezes.
const LAVANDERIA_FIELDS = [
    ['Vendedor', 'vendedor'], ['EquipamentoNome', 'equipamentoNome'], ['TipoMaquina', 'tipoMaquina'],
    ['HoraChegada', 'horaChegada'], ['HoraSaida', 'horaSaida'], ['Refeicao', 'refeicao'],
    ['KmInicial', 'kmInicial'], ['KmFinal', 'kmFinal'],
    ['ChecklistDosador1', 'checklistDosador1'], ['ChecklistDosador2', 'checklistDosador2'],
    ['ChecklistMaquina1', 'checklistMaquina1'], ['ChecklistMaquina2', 'checklistMaquina2'],
    ['ChecklistEstocagem1', 'checklistEstocagem1'], ['ChecklistEstocagem2', 'checklistEstocagem2'],
    ['VazoesBombas', 'vazoesBombas'], ['ProblemasMaquina', 'problemasMaquina'], ['ProblemasEstocagem', 'problemasEstocagem']
];

function findKey(headers, candidates) {
    const lower = headers.map((h) => String(h).trim().toLowerCase());
    for (const c of candidates) {
        const idx = lower.indexOf(c.toLowerCase().trim());
        if (idx > -1) return headers[idx];
    }
    return null;
}

// Mesma regra de Visitas/Propostas/Funil: Gerente vê a própria gerência,
// Vendedor (Técnico) só o que ele mesmo criou.
function filterManutencaoByUser(items, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin') return items;
    if (profile === 'gerente') {
        const userGer = String(user.gerencia || '').trim().toLowerCase();
        return items.filter((item) => String(item.gerencia || '').trim().toLowerCase() === userGer);
    }
    const userName = String(user.name || '').trim().toLowerCase();
    return items.filter((item) => String(item.tecnico || '').trim().toLowerCase() === userName);
}

export async function readManutencaoRows(user) {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) return [];
    // Compartilhado (não por-usuário) — mesmo motivo de Funil/Contratos: a
    // leitura da planilha em si fica igual pra todo mundo, só o filtro por
    // dono (abaixo) muda por usuário, e isso é processamento em memória, sem
    // custo de requisição.
    const { headers, rows } = await withCache('manutencao_sheet_raw', 60, () => getSheetWithHeaders(SHEET_NAME));
    if (!headers.length) return [];

    const key = {
        id: findKey(headers, ['Id', 'ID']),
        data: findKey(headers, ['Data', 'DATA']),
        tec: findKey(headers, ['Tecnico', 'TECNICO', 'Técnico']),
        ger: findKey(headers, ['Gerencia', 'GERENCIA', 'Gerência']),
        cli: findKey(headers, ['Cliente', 'CLIENTE']),
        cid: findKey(headers, ['Cidade', 'CIDADE']),
        tipoRel: findKey(headers, ['TipoRelatorio', 'TIPORELATORIO']),
        tipoVis: findKey(headers, ['TipoVisita', 'TIPOVISITA']),
        tipoEquip: findKey(headers, ['TipoEquipamento', 'TIPOEQUIPAMENTO']),
        itens: findKey(headers, ['ItensTabela', 'ITENSTABELA']),
        pecas: findKey(headers, ['PecasDiluidor', 'PECASDILUIDOR']),
        obs: findKey(headers, ['Observacao', 'OBSERVACAO', 'Observação']),
        assinTec: findKey(headers, ['AssinaturaTecnico', 'ASSINATURATECNICO']),
        assinCli: findKey(headers, ['AssinaturaCliente', 'ASSINATURACLIENTE']),
        pendente: findKey(headers, ['PendenteAprovacao', 'PENDENTEAPROVACAO']),
        sync: findKey(headers, ['SyncTimestamp', 'SYNCTIMESTAMP'])
    };
    LAVANDERIA_FIELDS.forEach(([header]) => { key[header] = findKey(headers, [header, header.toUpperCase()]); });

    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    const parsed = rows.map((row) => ({
        id: s(row, key.id),
        data: s(row, key.data),
        tecnico: s(row, key.tec),
        gerencia: s(row, key.ger),
        cliente: s(row, key.cli),
        cidade: s(row, key.cid),
        tipoRelatorio: s(row, key.tipoRel),
        tipoVisita: s(row, key.tipoVis),
        tipoEquipamento: s(row, key.tipoEquip),
        itensTabela: s(row, key.itens),
        pecasDiluidor: s(row, key.pecas),
        observacao: s(row, key.obs),
        assinaturaTecnico: s(row, key.assinTec),
        assinaturaCliente: s(row, key.assinCli),
        pendenteAprovacao: s(row, key.pendente),
        syncTimestamp: Number(v(row, key.sync)) || 0,
        ...Object.fromEntries(LAVANDERIA_FIELDS.map(([header, outKey]) => [outKey, s(row, key[header])]))
    }));

    return filterManutencaoByUser(parsed, user);
}

function buildManutencaoRowData(headers, fields) {
    return headers.map((h) => {
        const lh = h.toLowerCase().trim();
        const matchKey = Object.keys(fields).find((k) => k.toLowerCase().trim() === lh);
        return matchKey !== undefined ? fields[matchKey] : '';
    });
}

export async function handleGetManutencoes(payload) {
    const user = await verifyUser(payload.user);
    const rows = await withCache('mnt_' + user.email, 180, () => readManutencaoRows(user));
    return { status: 'success', manutencoes: rows };
}

export async function handleGetManutencaoById(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();
    const rows = await withCache('mnt_' + user.email, 180, () => readManutencaoRows(user));
    const found = rows.find((r) => String(r.id) === id);
    if (!found) throw new Error('Relatório de manutenção não encontrado.');
    return { status: 'success', manutencao: found };
}

export async function handleCreateManutencao(payload) {
    const user = await verifyUser(payload.user);
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');
    if (!payload.tipoRelatorio) throw new Error('Tipo de relatório é obrigatório.');
    ensureTextLength(payload.observacao, 'Observação');

    await ensureManutencoesSheet();
    const headers = await getHeaders(SHEET_NAME);
    // ID por timestamp evita colisão entre dois relatórios criados ao mesmo
    // tempo por usuários diferentes (Sheets API não tem escrita atômica).
    const id = resolveCreateId(payload);
    if (payload._queueRetry) {
        const dup = (await readManutencaoRows(user)).find((r) => String(r.id) === String(id));
        if (dup) return { status: 'success', manutencao: dup };
    }

    const fields = {
        'Id': id,
        'Data': formatDate(new Date()),
        'Tecnico': payload.tecnico || user.name,
        'Gerencia': user.gerencia || '',
        'Cliente': payload.cliente,
        'Cidade': payload.cidade || '',
        'TipoRelatorio': payload.tipoRelatorio,
        'TipoVisita': payload.tipoVisita || '',
        'TipoEquipamento': payload.tipoEquipamento || '',
        'ItensTabela': payload.itensTabela || '[]',
        'PecasDiluidor': payload.pecasDiluidor || '[]',
        'Observacao': payload.observacao || '',
        'AssinaturaTecnico': payload.assinaturaTecnico || '',
        'AssinaturaCliente': payload.assinaturaCliente || '',
        'PendenteAprovacao': '',
        'SyncTimestamp': Date.now(),
        ...Object.fromEntries(LAVANDERIA_FIELDS.map(([header, outKey]) => [header, payload[outKey] || '']))
    };

    await appendRow(SHEET_NAME, buildManutencaoRowData(headers, fields));
    clearCacheByPrefix(['mnt_', 'manutencao_sheet_raw']);
    return {
        status: 'success',
        manutencao: {
            id: String(id), data: fields.Data, tecnico: fields.Tecnico, gerencia: fields.Gerencia,
            cliente: fields.Cliente, cidade: fields.Cidade, tipoRelatorio: fields.TipoRelatorio,
            tipoVisita: fields.TipoVisita, tipoEquipamento: fields.TipoEquipamento,
            itensTabela: fields.ItensTabela, pecasDiluidor: fields.PecasDiluidor, observacao: fields.Observacao,
            assinaturaTecnico: fields.AssinaturaTecnico, assinaturaCliente: fields.AssinaturaCliente,
            pendenteAprovacao: fields.PendenteAprovacao, syncTimestamp: fields.SyncTimestamp,
            ...Object.fromEntries(LAVANDERIA_FIELDS.map(([header, outKey]) => [outKey, fields[header]]))
        }
    };
}

export async function handleUpdateManutencao(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Relatório de manutenção não encontrado para atualização.');

    const current = rows[rowIndex];
    const findCurrentKey = (candidates) => Object.keys(current).find((k) => candidates.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
    const keyMap = {
        tec: findCurrentKey(['tecnico']) || 'Tecnico',
        ger: findCurrentKey(['gerencia']) || 'Gerencia',
        cli: findCurrentKey(['cliente']) || 'Cliente',
        cid: findCurrentKey(['cidade']) || 'Cidade',
        tipoRel: findCurrentKey(['tiporelatorio']) || 'TipoRelatorio',
        tipoVis: findCurrentKey(['tipovisita']) || 'TipoVisita',
        tipoEquip: findCurrentKey(['tipoequipamento']) || 'TipoEquipamento',
        itens: findCurrentKey(['itenstabela']) || 'ItensTabela',
        pecas: findCurrentKey(['pecasdiluidor']) || 'PecasDiluidor',
        obs: findCurrentKey(['observacao']) || 'Observacao',
        assinTec: findCurrentKey(['assinaturatecnico']) || 'AssinaturaTecnico',
        assinCli: findCurrentKey(['assinaturacliente']) || 'AssinaturaCliente',
        pendente: findCurrentKey(['pendenteaprovacao']) || 'PendenteAprovacao',
        sync: findCurrentKey(['synctimestamp']) || 'SyncTimestamp'
    };
    LAVANDERIA_FIELDS.forEach(([header, outKey]) => { keyMap[outKey] = findCurrentKey([header.toLowerCase()]) || header; });

    const profile = String(user.profile || '').trim().toLowerCase();
    const isAdmin = profile === 'admin';
    const userName = String(user.name || '').trim().toLowerCase();
    const ownerName = String(current[keyMap.tec] || '').trim().toLowerCase();
    const ownerGer = String(current[keyMap.ger] || '').trim().toLowerCase();
    const userGer = String(user.gerencia || '').trim().toLowerCase();
    const owns = isAdmin || (profile === 'gerente' && ownerGer === userGer) || ownerName === userName;
    if (!owns) throw new Error('Você não tem permissão para editar este relatório.');

    ensureTextLength(payload.observacao, 'Observação');

    // Relatório assinado (as 2 assinaturas preenchidas) trava pra quem não é
    // admin — a menos que o admin tenha ligado o toggle
    // "permitir_editar_manutencao_assinada" nas Configurações; mesmo assim a
    // edição fica marcada como pendente de aprovação. Admin nunca passa por
    // essa trava, igual todo o resto do app.
    const jaAssinado = !!(current[keyMap.assinTec] && current[keyMap.assinCli]);
    let ficaPendente = false;
    if (jaAssinado && !isAdmin) {
        const config = await withCache('app_config', 600, () => readEmailConfig());
        if (!isConfigOn(config.permitir_editar_manutencao_assinada)) {
            throw new Error('Este relatório já foi assinado e só pode ser editado por um administrador.');
        }
        ficaPendente = true;
    }

    if (payload.cliente !== undefined) current[keyMap.cli] = payload.cliente;
    if (payload.cidade !== undefined) current[keyMap.cid] = payload.cidade;
    if (payload.tipoRelatorio !== undefined) current[keyMap.tipoRel] = payload.tipoRelatorio;
    if (payload.tipoVisita !== undefined) current[keyMap.tipoVis] = payload.tipoVisita;
    if (payload.tipoEquipamento !== undefined) current[keyMap.tipoEquip] = payload.tipoEquipamento;
    if (payload.itensTabela !== undefined) current[keyMap.itens] = payload.itensTabela;
    if (payload.pecasDiluidor !== undefined) current[keyMap.pecas] = payload.pecasDiluidor;
    if (payload.observacao !== undefined) current[keyMap.obs] = payload.observacao;
    if (payload.assinaturaTecnico !== undefined) current[keyMap.assinTec] = payload.assinaturaTecnico;
    if (payload.assinaturaCliente !== undefined) current[keyMap.assinCli] = payload.assinaturaCliente;
    // Só Admin pode reatribuir o dono do relatório — mesmo padrão já usado
    // em Contratos/Visitas/Propostas/Funil.
    if (isAdmin && payload.tecnico !== undefined) current[keyMap.tec] = payload.tecnico;
    LAVANDERIA_FIELDS.forEach(([, outKey]) => { if (payload[outKey] !== undefined) current[keyMap[outKey]] = payload[outKey]; });
    if (ficaPendente) current[keyMap.pendente] = 'Sim';
    current[keyMap.sync] = Date.now();

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['mnt_', 'manutencao_sheet_raw']);
    return { status: 'success', manutencao: (await readManutencaoRows(user)).find((r) => String(r.id) === id) };
}

export async function handleApproveManutencao(payload) {
    await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Relatório de manutenção não encontrado.');

    const current = rows[rowIndex];
    const pendenteKey = Object.keys(current).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === 'pendenteaprovacao') || 'PendenteAprovacao';
    current[pendenteKey] = '';

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['mnt_', 'manutencao_sheet_raw']);
    return { status: 'success', message: 'Relatório aprovado.' };
}

export async function handleDeleteManutencao(payload) {
    await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Relatório de manutenção não encontrado para exclusão.');

    await deleteRow(SHEET_NAME, rowIndex + 2);
    clearCacheByPrefix(['mnt_', 'manutencao_sheet_raw']);
    return { status: 'success', message: 'Relatório apagado.' };
}
