import {
    getSheetObjects, getHeaders, getSheetWithHeaders, appendRow, updateRow,
    appendRows, batchUpdateRows, sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { ensureAdmin, formatDate, formatDateFromInput, ensureTextLength } from '../common.js';
import { ensureCanAccessRadar } from './config.js';
import municipiosBr from '../data/municipiosBr.js';

// Tabela estática de ~5.570 municípios brasileiros (dado público, derivado
// do IBGE) — importada como módulo JS de verdade (não lida do disco em
// tempo de execução) pra garantir que o bundler do servidor sempre inclua o
// arquivo no deploy, sem depender de rastreamento automático de `fs`. Vive
// só no servidor, nunca entra no bundle que vai pro celular, e resolve a
// coordenada de uma cidade sem chamar API nenhuma em tempo real (o motivo
// de ter descartado geocodificação via API antes).
function normalizeCityName(name) {
    return String(name || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase().trim().replace(/\s+/g, ' ');
}

export function lookupCityCoords(cidade, uf) {
    const key = normalizeCityName(cidade) + '|' + String(uf || '').trim().toUpperCase();
    const coords = municipiosBr[key];
    return coords ? { lat: coords[0], lng: coords[1] } : null;
}

const CLIENTES_SHEET = 'RadarClientes';
const CLIENTES_HEADERS = [
    'Id', 'Cnpj', 'Nome', 'NomeFantasia', 'Cidade', 'Uf', 'CnaeCodigo', 'CnaeDescricao', 'Segmento',
    'Endereco', 'Numero', 'Complemento', 'Bairro', 'Cep', 'Telefone',
    'SituacaoCadastral', 'DataBusca', 'Status', 'StatusData', 'StatusMotivo',
    'StatusRetornoPrevisto', 'VisitaOrigemId'
];

const CIDADES_SHEET = 'RadarCidadesDisponiveis';
const CIDADES_HEADERS = ['Cidade', 'Uf', 'LiberadaEm', 'Lat', 'Lng'];

const SOLICITACOES_SHEET = 'RadarSolicitacoesCidade';
const SOLICITACOES_HEADERS = ['Id', 'CidadeSolicitada', 'Uf', 'SolicitadoPor', 'DataSolicitacao', 'Urgente', 'Status'];

const VALID_STATUSES = ['buscado', 'ja_atendido', 'recusado', 'prospeccao_agendada'];

async function ensureSheet(name, headers) {
    const exists = await sheetExists(name);
    if (!exists) {
        await createSheet(name);
        await appendRow(name, headers);
    }
}

// Evolução de schema numa aba que já existe (ex.: o CSV do Radar ganhou
// colunas novas depois que a planilha já estava em uso) — só ACRESCENTA
// cabeçalho que ainda não existe, nunca remove/reordena, então as linhas já
// gravadas continuam intactas (ficam sem valor nas colunas novas até o
// próximo reimport atualizar).
async function ensureHeaderColumns(name, requiredHeaders) {
    const headers = await getHeaders(name);
    const missing = requiredHeaders.filter((h) => !headers.includes(h));
    if (missing.length) {
        await updateRow(name, 1, [...headers, ...missing]);
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

// Acha a chave de um objeto-linha (já lido via getSheetObjects) ignorando
// maiúsculas/acentos/espaços — usado tanto pra atualizar status quanto pra
// atualizar campos informativos na importação de CSV.
function findObjectKey(obj, candidates) {
    return Object.keys(obj).find((k) => candidates.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
}

// Sheets devolve célula numérica formatada pelo locale da planilha (aqui,
// vírgula como separador decimal) mesmo quando o valor foi escrito como
// número puro — Number("-22,3246") vira NaN. Aceita tanto vírgula quanto
// ponto, então funciona pra ler o dado antigo (gravado antes desse fix
// existir) e o novo (gravado como texto, ver coordToCellValue).
function parseCoordValue(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

// Prefixo de apóstrofo força o Sheets a tratar a célula como texto puro,
// em vez de número — assim a formatação de locale (vírgula) nunca se
// aplica de novo, e o valor lido de volta é sempre o ponto que eu escrevi.
function coordToCellValue(n) {
    return `'${n}`;
}

// CNPJ só-dígitos como chave de dedup — a planilha real já vem assim, mas
// normalizo mesmo assim caso uma futura exportação venha formatada
// ("12.345.678/0001-90").
export function normalizeCnpj(value) {
    return String(value || '').replace(/\D/g, '');
}

// ── Cidades disponíveis ──────────────────────────────────────────────────

export async function readCidadesRows() {
    const exists = await sheetExists(CIDADES_SHEET);
    if (!exists) return [];
    const { headers, rows } = await getSheetWithHeaders(CIDADES_SHEET);
    if (!headers.length) return [];

    const key = {
        cidade: findKey(headers, ['Cidade']),
        uf: findKey(headers, ['Uf', 'UF']),
        liberada: findKey(headers, ['LiberadaEm']),
        lat: findKey(headers, ['Lat']),
        lng: findKey(headers, ['Lng'])
    };
    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    return rows.map((row) => ({
        cidade: s(row, key.cidade),
        uf: s(row, key.uf),
        liberadaEm: s(row, key.liberada),
        lat: parseCoordValue(v(row, key.lat)),
        lng: parseCoordValue(v(row, key.lng))
    }));
}

export async function handleGetRadarCidadesDisponiveis(payload) {
    await ensureCanAccessRadar(payload.user);
    const rows = await withCache('radar_cidades', 300, () => readCidadesRows());
    return { status: 'success', cidades: rows };
}

// ── Clientes ─────────────────────────────────────────────────────────────

export async function readRadarClienteRows() {
    const exists = await sheetExists(CLIENTES_SHEET);
    if (!exists) return [];
    const { headers, rows } = await getSheetWithHeaders(CLIENTES_SHEET);
    if (!headers.length) return [];

    const key = {
        id: findKey(headers, ['Id']),
        cnpj: findKey(headers, ['Cnpj', 'CNPJ']),
        nome: findKey(headers, ['Nome']),
        nomeFantasia: findKey(headers, ['NomeFantasia']),
        cidade: findKey(headers, ['Cidade']),
        uf: findKey(headers, ['Uf', 'UF']),
        cnaeCodigo: findKey(headers, ['CnaeCodigo']),
        cnaeDescricao: findKey(headers, ['CnaeDescricao']),
        segmento: findKey(headers, ['Segmento']),
        situacao: findKey(headers, ['SituacaoCadastral']),
        endereco: findKey(headers, ['Endereco']),
        numero: findKey(headers, ['Numero']),
        complemento: findKey(headers, ['Complemento']),
        bairro: findKey(headers, ['Bairro']),
        cep: findKey(headers, ['Cep']),
        telefone: findKey(headers, ['Telefone']),
        dataBusca: findKey(headers, ['DataBusca']),
        status: findKey(headers, ['Status']),
        statusData: findKey(headers, ['StatusData']),
        statusMotivo: findKey(headers, ['StatusMotivo']),
        statusRetorno: findKey(headers, ['StatusRetornoPrevisto']),
        visitaOrigemId: findKey(headers, ['VisitaOrigemId'])
    };
    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    return rows.map((row) => ({
        id: s(row, key.id),
        cnpj: s(row, key.cnpj),
        nome: s(row, key.nome),
        nomeFantasia: s(row, key.nomeFantasia),
        cidade: s(row, key.cidade),
        uf: s(row, key.uf),
        cnaeCodigo: s(row, key.cnaeCodigo),
        cnaeDescricao: s(row, key.cnaeDescricao),
        segmento: s(row, key.segmento),
        situacaoCadastral: s(row, key.situacao),
        endereco: s(row, key.endereco),
        numero: s(row, key.numero),
        complemento: s(row, key.complemento),
        bairro: s(row, key.bairro),
        cep: s(row, key.cep),
        telefone: s(row, key.telefone),
        dataBusca: s(row, key.dataBusca),
        status: s(row, key.status) || 'buscado',
        statusData: s(row, key.statusData),
        statusMotivo: s(row, key.statusMotivo),
        statusRetornoPrevisto: s(row, key.statusRetorno),
        visitaOrigemId: s(row, key.visitaOrigemId)
    }));
}

export async function handleGetRadarClientes(payload) {
    await ensureCanAccessRadar(payload.user);
    // Cache único (não por-usuário) — a base do Radar não é dado pessoal de
    // ninguém, todo mundo com acesso vê a mesma coisa.
    const all = await withCache('radar_clientes_all', 90, () => readRadarClienteRows());

    if (payload.scope === 'all') {
        return { status: 'success', clientes: all };
    }

    const cidade = String(payload.cidade || '').trim().toLowerCase();
    if (!cidade) throw new Error('Selecione uma cidade.');
    const uf = String(payload.uf || '').trim().toLowerCase();
    const filtered = all.filter((c) =>
        c.cidade.trim().toLowerCase() === cidade && (!uf || c.uf.trim().toLowerCase() === uf));
    return { status: 'success', clientes: filtered };
}

// Cobre os 3 botões do card de detalhe ("já atendido", "recusou", e o flip
// pós-visita de "agendar prospecção") — um único endpoint, só muda o status
// enviado e quais campos extras vêm junto.
export async function handleUpdateRadarClienteStatus(payload) {
    await ensureCanAccessRadar(payload.user);
    const id = String(payload.id || '').trim();
    const status = String(payload.status || '').trim();
    if (!VALID_STATUSES.includes(status)) throw new Error('Status inválido.');
    ensureTextLength(payload.motivo, 'Motivo');

    const headers = await getHeaders(CLIENTES_SHEET);
    const rows = await getSheetObjects(CLIENTES_SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Empresa não encontrada no Radar.');

    const current = rows[rowIndex];
    const keyMap = {
        status: findObjectKey(current, ['status']) || 'Status',
        statusData: findObjectKey(current, ['statusdata']) || 'StatusData',
        statusMotivo: findObjectKey(current, ['statusmotivo']) || 'StatusMotivo',
        statusRetorno: findObjectKey(current, ['statusretornoprevisto']) || 'StatusRetornoPrevisto',
        visitaOrigemId: findObjectKey(current, ['visitaorigemid']) || 'VisitaOrigemId'
    };

    current[keyMap.status] = status;
    current[keyMap.statusData] = formatDate(new Date());
    current[keyMap.statusMotivo] = status === 'recusado' ? (payload.motivo || '') : '';
    current[keyMap.statusRetorno] = (status === 'recusado' && payload.retornoPrevisto)
        ? formatDateFromInput(payload.retornoPrevisto) : '';
    if (payload.visitaOrigemId) current[keyMap.visitaOrigemId] = String(payload.visitaOrigemId);

    await updateRow(CLIENTES_SHEET, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['radar_clientes']);
    return { status: 'success' };
}

// ── Solicitações de cidade ───────────────────────────────────────────────

export async function handleCreateRadarSolicitacaoCidade(payload) {
    const user = await ensureCanAccessRadar(payload.user);
    const cidade = String(payload.cidade || '').trim();
    if (!cidade) throw new Error('Informe a cidade.');

    await ensureSheet(SOLICITACOES_SHEET, SOLICITACOES_HEADERS);
    const headers = await getHeaders(SOLICITACOES_SHEET);
    const id = Date.now();
    const fields = {
        'Id': id,
        'CidadeSolicitada': cidade,
        'Uf': String(payload.uf || '').trim(),
        'SolicitadoPor': user.name,
        'DataSolicitacao': formatDate(new Date()),
        'Urgente': payload.urgente ? 'Sim' : 'Nao',
        'Status': 'pendente'
    };
    await appendRow(SOLICITACOES_SHEET, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    clearCacheByPrefix(['radar_solicitacoes']);
    return { status: 'success' };
}

export async function handleGetRadarSolicitacoesCidade(payload) {
    await ensureAdmin(payload.user);
    const rows = await withCache('radar_solicitacoes', 120, async () => {
        const exists = await sheetExists(SOLICITACOES_SHEET);
        if (!exists) return [];
        const { headers, rows } = await getSheetWithHeaders(SOLICITACOES_SHEET);
        if (!headers.length) return [];
        const key = {
            id: findKey(headers, ['Id']),
            cidade: findKey(headers, ['CidadeSolicitada']),
            uf: findKey(headers, ['Uf', 'UF']),
            solicitadoPor: findKey(headers, ['SolicitadoPor']),
            data: findKey(headers, ['DataSolicitacao']),
            urgente: findKey(headers, ['Urgente']),
            status: findKey(headers, ['Status'])
        };
        const v = (row, k) => (k ? (row[k] ?? '') : '');
        const s = (row, k) => String(v(row, k) || '');
        return rows.map((row) => ({
            id: s(row, key.id),
            cidade: s(row, key.cidade),
            uf: s(row, key.uf),
            solicitadoPor: s(row, key.solicitadoPor),
            dataSolicitacao: s(row, key.data),
            urgente: s(row, key.urgente).toLowerCase() === 'sim',
            status: s(row, key.status) || 'pendente'
        }));
    });
    return { status: 'success', solicitacoes: rows.filter((r) => r.status === 'pendente') };
}

// ── Importação CSV (admin) ───────────────────────────────────────────────

// Parser escrito na mão (sem biblioteca — o projeto não tem nenhuma
// dependência de parsing de arquivo hoje) "quote-aware": nome de empresa
// pode ter vírgula dentro de aspas, um split(',') ingênuo quebraria essas
// linhas. Também ignora o BOM UTF-8 que o Excel costuma colocar no início.
export function parseRadarCsv(text) {
    const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const table = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];
        if (inQuotes) {
            if (ch === '"') {
                if (clean[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(field); field = '';
        } else if (ch === '\r') {
            // ignora — o \n seguinte fecha a linha
        } else if (ch === '\n') {
            row.push(field); field = '';
            table.push(row); row = [];
        } else {
            field += ch;
        }
    }
    if (field !== '' || row.length) { row.push(field); table.push(row); }
    return table.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

// Nomes de coluna exatos confirmados no export real do programa desktop.
// nomeFantasia aceita a grafia antiga (nome_fantasia) e a nova (Nome
// Fantasia) — o export mudou de formato no meio dessa mesma sessão.
const CSV_COLUMN_CANDIDATES = {
    cnpj: ['cnpj (referência interna)', 'cnpj'],
    nome: ['cliente'],
    nomeFantasia: ['nome fantasia', 'nome_fantasia', 'nomefantasia'],
    cnaeCodigo: ['cnae (referência interna)', 'cnae'],
    cnaeDescricao: ['ramo de atividade (cnae)', 'ramo de atividade'],
    segmento: ['segmento'],
    situacao: ['situação cadastral', 'situacao cadastral'],
    endereco: ['endereço', 'endereco'],
    numero: ['número', 'numero'],
    complemento: ['complemento'],
    bairro: ['bairro'],
    cep: ['cep'],
    cidade: ['cidade'],
    uf: ['uf'],
    telefone: ['telefone(s)', 'telefones', 'telefone'],
    dataBusca: ['data da busca', 'data busca']
};

// Admin sobe o CSV (upload no navegador, texto cru em payload.csvText) —
// o parsing roda uma única vez, aqui no servidor. CNPJ é a chave de dedup:
// linha nova vira empresa "buscado"; CNPJ já cadastrado só atualiza campos
// informativos (nunca Status/StatusData/StatusMotivo/StatusRetornoPrevisto/
// VisitaOrigemId — esses são controlados só pelo vendedor). Cidade nova
// (cidade+uf que ainda não está em RadarCidadesDisponiveis) é liberada
// automaticamente sem Lat/Lng (ver Bloco 6) e marca solicitações pendentes
// daquela cidade como atendidas. Sempre admin, mesmo se o toggle de acesso
// ao Radar estiver desligado pros demais.
export async function handleImportRadarClientesCsv(payload) {
    await ensureAdmin(payload.user);
    const csvText = String(payload.csvText || '');
    if (!csvText.trim()) throw new Error('Envie um arquivo CSV.');

    const table = parseRadarCsv(csvText);
    if (table.length < 2) throw new Error('CSV vazio ou sem linhas de dados.');

    const csvHeaders = table[0].map((h) => String(h || '').trim());
    const col = {};
    for (const [key, candidates] of Object.entries(CSV_COLUMN_CANDIDATES)) {
        col[key] = findKey(csvHeaders, candidates);
    }
    if (!col.cnpj || !col.nome || !col.cidade) {
        throw new Error('CSV não reconhecido — confira se as colunas CNPJ, Cliente e Cidade estão presentes.');
    }
    const idxOf = (key) => (col[key] ? csvHeaders.indexOf(col[key]) : -1);
    const idxCnpj = idxOf('cnpj'), idxNome = idxOf('nome'), idxFantasia = idxOf('nomeFantasia'),
        idxCnaeCod = idxOf('cnaeCodigo'), idxCnaeDesc = idxOf('cnaeDescricao'), idxSegmento = idxOf('segmento'),
        idxSituacao = idxOf('situacao'), idxEndereco = idxOf('endereco'), idxNumero = idxOf('numero'),
        idxComplemento = idxOf('complemento'), idxBairro = idxOf('bairro'), idxCep = idxOf('cep'),
        idxCidade = idxOf('cidade'), idxUf = idxOf('uf'), idxTelefone = idxOf('telefone'), idxData = idxOf('dataBusca');
    const cell = (row, i) => (i > -1 ? String(row[i] || '').trim() : '');

    await ensureSheet(CLIENTES_SHEET, CLIENTES_HEADERS);
    await ensureSheet(CIDADES_SHEET, CIDADES_HEADERS);
    // Adiciona colunas novas (Segmento/Endereco/etc) numa planilha já
    // existente sem mexer nas linhas já gravadas — cabeçalho evolui, dado
    // antigo continua lá, só sem valor nessas colunas até o próximo reimport.
    await ensureHeaderColumns(CLIENTES_SHEET, CLIENTES_HEADERS);

    const clientesHeaders = await getHeaders(CLIENTES_SHEET);
    const existingClientes = await getSheetObjects(CLIENTES_SHEET);
    const cnpjToExisting = new Map();
    existingClientes.forEach((row, i) => {
        const rowCnpjKey = findObjectKey(row, ['cnpj']) || 'Cnpj';
        const cnpj = normalizeCnpj(row[rowCnpjKey]);
        if (cnpj) cnpjToExisting.set(cnpj, { rowNumber: i + 2, row });
    });

    const cidadesExistentes = await readCidadesRows();
    const cidadeSet = new Set(cidadesExistentes.map((c) => `${c.cidade.trim().toLowerCase()}|${c.uf.trim().toLowerCase()}`));
    const novasCidades = new Map(); // "cidade|uf" -> { cidade, uf }

    const newRows = [];
    const seenNewByCnpj = new Map(); // cnpj -> índice em newRows (duplicata dentro do próprio arquivo)
    const updates = [];
    const seenExistingByCnpj = new Map(); // cnpj -> índice em updates (idem, pra CNPJ já cadastrado)
    let novas = 0, atualizadas = 0, ignoradas = 0, duplicadasNoArquivo = 0;
    const baseId = Date.now();

    for (let r = 1; r < table.length; r++) {
        const csvRow = table[r];
        const cnpj = normalizeCnpj(cell(csvRow, idxCnpj));
        const nome = cell(csvRow, idxNome);
        const cidade = cell(csvRow, idxCidade);
        if (!cnpj || !nome || !cidade) { ignoradas++; continue; }

        const uf = cell(csvRow, idxUf);
        const nomeFantasia = cell(csvRow, idxFantasia);
        const cnaeCodigo = cell(csvRow, idxCnaeCod);
        const cnaeDescricao = cell(csvRow, idxCnaeDesc);
        const segmento = cell(csvRow, idxSegmento);
        const situacao = cell(csvRow, idxSituacao);
        const endereco = cell(csvRow, idxEndereco);
        const numero = cell(csvRow, idxNumero);
        const complemento = cell(csvRow, idxComplemento);
        const bairro = cell(csvRow, idxBairro);
        const cep = cell(csvRow, idxCep);
        const telefone = cell(csvRow, idxTelefone);
        const dataBuscaRaw = cell(csvRow, idxData);
        const dataBusca = formatDateFromInput(dataBuscaRaw) || dataBuscaRaw;

        const existing = cnpjToExisting.get(cnpj);
        if (existing) {
            // Se o mesmo CNPJ (já cadastrado) aparecer 2x no arquivo, parte da
            // linha JÁ ATUALIZADA nesta importação (não da original lida do
            // Sheets) — senão a segunda ocorrência sobrescreveria o batchUpdate
            // da primeira com dados desatualizados, e o resumo contaria 2
            // "atualizadas" pra uma única empresa.
            const alreadyIdx = seenExistingByCnpj.get(cnpj);
            const base = alreadyIdx !== undefined
                ? Object.fromEntries(clientesHeaders.map((h, i) => [h, updates[alreadyIdx].rowValues[i]]))
                : existing.row;
            const current = { ...base };
            const setField = (candidates, value) => {
                const k = findObjectKey(current, candidates);
                if (k) current[k] = value;
            };
            setField(['nome'], nome);
            setField(['nomefantasia'], nomeFantasia);
            setField(['cidade'], cidade);
            setField(['uf'], uf);
            setField(['cnaecodigo'], cnaeCodigo);
            setField(['cnaedescricao'], cnaeDescricao);
            setField(['segmento'], segmento);
            setField(['situacaocadastral'], situacao);
            setField(['endereco'], endereco);
            setField(['numero'], numero);
            setField(['complemento'], complemento);
            setField(['bairro'], bairro);
            setField(['cep'], cep);
            setField(['telefone'], telefone);
            setField(['databusca'], dataBusca);
            const rowValues = clientesHeaders.map((h) => (current[h] !== undefined ? current[h] : ''));
            if (alreadyIdx !== undefined) {
                updates[alreadyIdx].rowValues = rowValues;
                duplicadasNoArquivo++;
            } else {
                seenExistingByCnpj.set(cnpj, updates.length);
                updates.push({ rowNumber: existing.rowNumber, rowValues });
                atualizadas++;
            }
        } else {
            // Campos informativos de uma empresa nova — Status/StatusData/etc
            // ficam de fora daqui de propósito, são controlados só pelo
            // vendedor (handleUpdateRadarClienteStatus), nunca pela importação.
            const buildFields = (id) => ({
                Id: id, Cnpj: cnpj, Nome: nome, NomeFantasia: nomeFantasia, Cidade: cidade, Uf: uf,
                CnaeCodigo: cnaeCodigo, CnaeDescricao: cnaeDescricao, Segmento: segmento,
                Endereco: endereco, Numero: numero, Complemento: complemento, Bairro: bairro, Cep: cep,
                Telefone: telefone, SituacaoCadastral: situacao, DataBusca: dataBusca,
                Status: 'buscado', StatusData: '', StatusMotivo: '', StatusRetornoPrevisto: '', VisitaOrigemId: ''
            });
            if (seenNewByCnpj.has(cnpj)) {
                // Mesmo CNPJ apareceu 2x no próprio arquivo — atualiza a linha
                // nova já preparada em vez de duplicar (mantém o Id já gerado).
                const i = seenNewByCnpj.get(cnpj);
                const id = newRows[i][clientesHeaders.indexOf('Id')];
                const fields = buildFields(id);
                newRows[i] = clientesHeaders.map((h) => (fields[h] !== undefined ? fields[h] : ''));
                duplicadasNoArquivo++;
            } else {
                const fields = buildFields(String(baseId + newRows.length));
                seenNewByCnpj.set(cnpj, newRows.length);
                newRows.push(clientesHeaders.map((h) => (fields[h] !== undefined ? fields[h] : '')));
                novas++;
            }
        }

        const cidadeKey = `${cidade.toLowerCase()}|${uf.toLowerCase()}`;
        if (!cidadeSet.has(cidadeKey) && !novasCidades.has(cidadeKey)) {
            novasCidades.set(cidadeKey, { cidade, uf });
        }
    }

    if (newRows.length) await appendRows(CLIENTES_SHEET, newRows);
    if (updates.length) await batchUpdateRows(CLIENTES_SHEET, updates);

    let cidadesAdicionadas = 0;
    if (novasCidades.size) {
        const cidadesHeaders = await getHeaders(CIDADES_SHEET);
        const hoje = formatDate(new Date());
        const cidadeRows = Array.from(novasCidades.values()).map(({ cidade, uf }) => {
            const coords = lookupCityCoords(cidade, uf);
            const fields = {
                Cidade: cidade, Uf: uf, LiberadaEm: hoje,
                Lat: coords ? coordToCellValue(coords.lat) : '', Lng: coords ? coordToCellValue(coords.lng) : ''
            };
            return cidadesHeaders.map((h) => (fields[h] !== undefined ? fields[h] : ''));
        });
        await appendRows(CIDADES_SHEET, cidadeRows);
        cidadesAdicionadas = cidadeRows.length;
    }

    // Backfill: cidade já liberada antes da tabela de municípios existir (ou
    // liberada manualmente) pode ter ficado sem Lat/Lng — aproveita esta
    // mesma importação (ação já admin/já de escrita) pra completar, sem
    // precisar de uma tela extra só pra isso.
    const cidadesSemCoord = cidadesExistentes.filter((c) => c.lat === null || c.lng === null);
    if (cidadesSemCoord.length) {
        const cidadesHeadersRaw = await getHeaders(CIDADES_SHEET);
        const cidadesRowsRaw = await getSheetObjects(CIDADES_SHEET);
        const backfillUpdates = [];
        cidadesRowsRaw.forEach((row, i) => {
            const latKey = findObjectKey(row, ['lat']) || 'Lat';
            const lngKey = findObjectKey(row, ['lng']) || 'Lng';
            if (parseCoordValue(row[latKey]) !== null && parseCoordValue(row[lngKey]) !== null) return;
            const cidadeKeyName = findObjectKey(row, ['cidade']) || 'Cidade';
            const ufKeyName = findObjectKey(row, ['uf']) || 'Uf';
            const coords = lookupCityCoords(row[cidadeKeyName], row[ufKeyName]);
            if (!coords) return;
            const current = { ...row, [latKey]: coordToCellValue(coords.lat), [lngKey]: coordToCellValue(coords.lng) };
            backfillUpdates.push({ rowNumber: i + 2, rowValues: cidadesHeadersRaw.map((h) => (current[h] !== undefined ? current[h] : '')) });
        });
        if (backfillUpdates.length) await batchUpdateRows(CIDADES_SHEET, backfillUpdates);
    }

    // Marca como "atendida" as solicitações pendentes cujas cidades acabaram
    // de ser liberadas por esta importação.
    let solicitacoesAtendidas = 0;
    if (novasCidades.size && await sheetExists(SOLICITACOES_SHEET)) {
        const solHeaders = await getHeaders(SOLICITACOES_SHEET);
        const solRows = await getSheetObjects(SOLICITACOES_SHEET);
        const solUpdates = [];
        solRows.forEach((row, i) => {
            const statusKey = findObjectKey(row, ['status']) || 'Status';
            if (String(row[statusKey] || '').trim().toLowerCase() !== 'pendente') return;
            const cidadeKey2 = findObjectKey(row, ['cidadesolicitada']) || 'CidadeSolicitada';
            const ufKey2 = findObjectKey(row, ['uf']) || 'Uf';
            const key = `${String(row[cidadeKey2] || '').trim().toLowerCase()}|${String(row[ufKey2] || '').trim().toLowerCase()}`;
            if (!novasCidades.has(key)) return;
            const current = { ...row, [statusKey]: 'atendida' };
            solUpdates.push({ rowNumber: i + 2, rowValues: solHeaders.map((h) => (current[h] !== undefined ? current[h] : '')) });
        });
        if (solUpdates.length) {
            await batchUpdateRows(SOLICITACOES_SHEET, solUpdates);
            solicitacoesAtendidas = solUpdates.length;
        }
    }

    clearCacheByPrefix(['radar_clientes', 'radar_cidades', 'radar_solicitacoes']);
    return { status: 'success', novas, atualizadas, ignoradas, duplicadasNoArquivo, cidadesAdicionadas, solicitacoesAtendidas };
}
