import {
    getSheetObjects, getHeaders, appendRow, appendRows, updateRow, batchUpdateRows,
    sheetExists, createSheet, clearCacheByPrefix
} from '../sheets.js';
import { ensureAdmin } from '../common.js';
import { xlsxToTable } from './xlsx.js';

// ── Importação da base antiga (migração) ────────────────────────────────────
// Alimenta as abas do app (Visitas, Propostas, …) com os relatórios
// exportados do sistema antigo. Mesmo padrão da importação de CSV do Radar:
// admin-only, parser próprio, dedup por chave, appendRows pra não estourar a
// cota de escrita do Sheets, resumo de contagens devolvido pra tela.
//
// Fluxo em 2 passos (comum a todas as entidades):
//  - dryRun:true  → só analisa. Devolve resumo (novas/puladas/ignoradas) e a
//    lista de vendedores do arquivo que não bateram com o cadastro, pra tela
//    montar o de-para.
//  - dryRun:false + vendedorMap → grava de verdade. vendedorMap é
//    { "NOME NO ARQUIVO": "NomeVendedor do app" | "__IGNORAR__" }; as
//    entradas resolvidas ficam salvas em ImportacaoApelidos pro próximo
//    export casar sozinho.

// Parser CSV escrito na mão (o projeto não tem dependência de parsing),
// "quote-aware" (nome de cliente pode ter vírgula dentro de aspas) e com
// auto-detecção de delimitador — o Excel em pt-BR costuma salvar com ';'.
// Ignora o BOM UTF-8 que o Excel coloca no início.
export function parseCsv(text) {
    const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const delimiter = detectDelimiter(clean);
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
        } else if (ch === delimiter) {
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

// Conta vírgulas vs. ponto-e-vírgula fora de aspas na primeira linha —
// quem tiver mais é o delimitador. Empate/nenhum → vírgula (padrão).
function detectDelimiter(text) {
    const firstLine = (text.split(/\r?\n/)[0] || '');
    let commas = 0, semis = 0, inQuotes = false;
    for (const ch of firstLine) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (inQuotes) continue;
        else if (ch === ',') commas++;
        else if (ch === ';') semis++;
    }
    return semis > commas ? ';' : ',';
}

// Normaliza cabeçalho pra casar coluna: sem acento, minúsculo, espaços
// colapsados. Assim "Área de Atuação", "Area Atuação" e "AREA DE ATUACAO"
// batem no mesmo candidato.
function normHeader(value) {
    return String(value || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().trim().replace(/\s+/g, ' ');
}

// Normaliza nome de vendedor pra comparar com NomeVendedor da aba
// Vendedores (o app já compara em minúsculas pra decidir "de quem é a
// visita", então caixa não importa — o que pega é acento/espaço/abreviação).
function normName(value) {
    return String(value || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase().trim().replace(/\s+/g, ' ');
}

function findColIndex(headers, candidates) {
    const normHeaders = headers.map(normHeader);
    for (const candidate of candidates) {
        const idx = normHeaders.indexOf(normHeader(candidate));
        if (idx > -1) return idx;
    }
    return -1;
}

// "15:06:46" → "15:06"; "9:5" ou lixo → devolve como veio (trim).
function stripSeconds(value) {
    const s = String(value || '').trim();
    const m = s.match(/^(\d{1,2}:\d{2})(?::\d{2})?$/);
    return m ? m[1] : s;
}

const APELIDOS_SHEET = 'ImportacaoApelidos';
const APELIDOS_HEADERS = ['De', 'Para'];
const IGNORAR = '__IGNORAR__';       // importa a linha, mas sem vendedor
const DESCARTAR = '__DESCARTAR__';   // não importa a linha

async function ensureApelidosSheet() {
    if (!(await sheetExists(APELIDOS_SHEET))) {
        await createSheet(APELIDOS_SHEET);
        await appendRow(APELIDOS_SHEET, APELIDOS_HEADERS);
    }
}

async function readApelidos() {
    if (!(await sheetExists(APELIDOS_SHEET))) return new Map();
    const rows = await getSheetObjects(APELIDOS_SHEET);
    const map = new Map();
    rows.forEach((r) => {
        const de = normName(r.De ?? r.de);
        const para = String(r.Para ?? r.para ?? '').trim();
        if (de && para) map.set(de, para);
    });
    return map;
}

// Monta a linha na ordem dos headers reais da aba. Tenta match exato da
// chave primeiro; se não achar, cai num match tolerante (minúsculo + sem
// espaços/pontuação) — a aba Funil tem headers em CAIXA ALTA e com grafias
// tipo "VL MENSAL R$" que não batem 1:1 com as chaves do buildRow.
function looseKey(value) {
    return String(value || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '');
}
function assembleRow(headers, fields) {
    const loose = {};
    for (const k of Object.keys(fields)) loose[looseKey(k)] = fields[k];
    return headers.map((h) => {
        if (fields[h] !== undefined) return fields[h];
        const lk = looseKey(h);
        return loose[lk] !== undefined ? loose[lk] : '';
    });
}

// Como assembleRow, mas pra ATUALIZAR uma linha que já existe: só troca a
// célula quando o import trouxe um valor não-vazio pra ela; qualquer coluna
// não mapeada (ou mapeada mas vazia no CSV) mantém o que já estava lá.
function mergeRow(headers, fields, existingRow) {
    const loose = {};
    for (const k of Object.keys(fields)) loose[looseKey(k)] = fields[k];
    return headers.map((h) => {
        let v = fields[h];
        if (v === undefined) v = loose[looseKey(h)];
        if (v !== undefined && String(v).trim() !== '') return v;
        return existingRow[h] !== undefined ? existingRow[h] : '';
    });
}

// Acrescenta colunas que o import precisa mas a aba pode não ter numa
// planilha mais antiga — sem elas o valor gravado seria descartado em
// silêncio (headers.map só escreve nas colunas que existem).
async function ensureColumns(sheet, cols) {
    if (!cols.length) return;
    const headers = await getHeaders(sheet);
    const missing = cols.filter((h) => !headers.includes(h));
    if (missing.length) await updateRow(sheet, 1, [...headers, ...missing]);
}

// ── Specs por entidade ─────────────────────────────────────────────────────
// Cada spec descreve: aba de destino, grafias aceitas por coluna, colunas a
// garantir antes de escrever, prefixos de cache a invalidar, e a função que
// monta o objeto-linha (chaves com e sem acento — headers.map escolhe a que
// a aba real usa).

const VISITAS_SPEC = {
    sheet: 'Visitas',
    ensure: ['Prospecção', 'SyncTimestamp'],
    cachePrefixes: ['v_', 'vp_raw', 'd_', 'visitas_sheet_raw'],
    cols: {
        id: ['id'],
        vendedor: ['vendedor/ gerente', 'vendedor/gerente', 'vendedor / gerente', 'vendedor gerente', 'vendedor'],
        data: ['data da visita', 'data visita', 'data'],
        horario: ['horario', 'hora'],
        cliente: ['cliente:', 'cliente', 'nome do cliente'],
        contato: ['contato'],
        cidade: ['cidade'],
        area: ['area atuacao', 'area de atuacao', 'area atuação', 'area de atuação'],
        potencial: ['potencial do cliente', 'potencial'],
        tipo: ['tipo da visita', 'tipo visita', 'tipo'],
        gerencia: ['gerencia'],
        veiculo: ['qual o veiculo?', 'qual o veiculo', 'veiculo'],
        observacao: ['observacao', 'obs', 'observação']
    },
    buildRow(get, ctx) {
        const usouCadastro = ctx.resolved.matched && ctx.resolved.nome;
        const gerencia = usouCadastro ? ctx.resolved.gerencia : get('gerencia');
        const horario = stripSeconds(get('horario'));
        const area = get('area');
        const veiculo = get('veiculo');
        const obs = get('observacao');
        const prospeccao = ctx.payload.tipo === 'prospeccao' ? 'Sim' : 'Nao';
        return {
            'ID': ctx.idCell ? "'" + ctx.idCell : String(ctx.now + ctx.seq),
            'Prospecção': prospeccao,
            'Prospeccao': prospeccao,
            'Vendedor/Gerente': usouCadastro ? ctx.resolved.nome : get('vendedor'),
            'Data da Visita': get('data'),
            'Horário': horario,
            'Horario': horario,
            'Cliente': get('cliente'),
            'Contato': get('contato'),
            'Cidade': get('cidade'),
            'Área de Atuação': area,
            'Area de Atuacao': area,
            'Potencial do Cliente': get('potencial'),
            'Tipo da Visita': get('tipo'),
            'Gerência': gerencia,
            'Gerencia': gerencia,
            'Qual o Veículo?': veiculo,
            'Qual o Veiculo?': veiculo,
            'Observação': obs,
            'Observacao': obs,
            'Latitude': '',
            'Longitude': '',
            'SyncTimestamp': ctx.now
        };
    }
};

const PROPOSTAS_SPEC = {
    sheet: 'Propostas',
    ensure: ['SyncTimestamp'],
    cachePrefixes: ['p_', 'vp_raw', 'd_', 'propostas_sheet_raw'],
    // Quando a linha não traz vendedor, o admin escolhe um vendedor por
    // cliente na tela de análise (clienteVendedorMap).
    perClienteVendedor: true,
    cols: {
        id: ['id'],
        vendedor: ['vendedor'],
        data: ['data'],
        cliente: ['cliente'],
        foco: ['foco'],
        produtos: ['produtos'],
        gerencia: ['gerencia'],
        cidade: ['cidade'],
        status: ['status'],
        atualizacao: ['atualizacao', 'atualização'],
        atualizar: ['atualizar'],
        obs: ['obs', 'observacao', 'observação'],
        dataLimite: ['data limite', 'datalimite'],
        email: ['e-mail', 'email']
    },
    buildRow(get, ctx) {
        const usouCadastro = ctx.resolved.matched && ctx.resolved.nome;
        const gerencia = usouCadastro ? ctx.resolved.gerencia : get('gerencia');
        // "ATUALIZAR" e "OBS" eram 2 colunas na planilha antiga; no app viram
        // a coluna única "Atualizar/OBS". Junta as duas quando ambas têm texto.
        const obs = [get('atualizar'), get('obs')].map((s) => s.trim()).filter(Boolean).join('\n');
        return {
            'Id': ctx.idCell ? "'" + ctx.idCell : String(ctx.now + ctx.seq),
            'Data': get('data'),
            'Vendedor': usouCadastro ? ctx.resolved.nome : get('vendedor'),
            'Cliente': get('cliente'),
            'Foco': ctx.focoOverride || get('foco'),
            'Produtos': get('produtos'),
            'Gerencia': gerencia,
            'Gerência': gerencia,
            'Cidade': ctx.cidadeOverride || get('cidade'),
            // Sem status no arquivo → entra como "Aguardando".
            'Status': get('status') || 'Aguardando',
            'Atualização': get('atualizacao'),
            'Atualizacao': get('atualizacao'),
            'Hora': '',
            'Atualizar/OBS': obs,
            'Observação': obs,
            'Observacao': obs,
            'Data Limite': get('dataLimite'),
            'E-mail': get('email'),
            'Email': get('email'),
            'SyncTimestamp': ctx.now
        };
    }
};

const FUNIL_SPEC = {
    sheet: 'Funil',
    ensure: ['SyncTimestamp'],
    cachePrefixes: ['f_', 'd_', 'funil_sheet_raw'],
    perClienteVendedor: true,
    cols: {
        id: ['id'],
        data: ['data'],
        ativo: ['ativo'],
        status: ['status'],
        vendedor: ['vendedor'],
        cliente: ['cliente'],
        cidade: ['cidade'],
        foco: ['foco'],
        atuacao: ['atuacao', 'atuação', 'area de atuacao', 'area de atuação'],
        aplicacao: ['aplicacao', 'aplicação'],
        equipamento: ['equipamento', 'equipamentos'],
        gerencia: ['gerencia'],
        vlMensal: ['vl mensal', 'vl mensal r$', 'vl mensal rs', 'valor mensal', 'vlmensal'],
        conclusao: ['conclusao', 'conclusão'],
        atualizacao: ['atualizacao', 'atualização'],
        infImportantes: ['inf importantes', 'informacoes importantes', 'informações importantes'],
        comentarios: ['comentarios', 'comentários']
    },
    buildRow(get, ctx) {
        const usouCadastro = ctx.resolved.matched && ctx.resolved.nome;
        const gerencia = usouCadastro ? ctx.resolved.gerencia : get('gerencia');
        const atuacao = get('atuacao');
        const aplicacao = get('aplicacao');
        const equipamentos = get('equipamento');
        const vlMensal = get('vlMensal');
        const conclusao = get('conclusao');
        const atualizacao = get('atualizacao');
        const inf = get('infImportantes');
        const com = get('comentarios');
        // A aba Funil tem headers em CAIXA ALTA / com grafias variadas
        // ("VL MENSAL R$", "ATUAÇÃO"…). assembleRow faz match tolerante, e
        // as variantes explícitas abaixo cobrem os casos que a normalização
        // não colapsa (o "R$" de VL MENSAL, principalmente).
        return {
            'Id': ctx.idCell ? "'" + ctx.idCell : String(ctx.now + ctx.seq),
            'Data': get('data'),
            'Atualizacao': atualizacao,
            'Atualização': atualizacao,
            'Ativo': get('ativo'),
            'Status': get('status'),
            'Vendedor': usouCadastro ? ctx.resolved.nome : get('vendedor'),
            'Cliente': get('cliente'),
            'Cidade': ctx.cidadeOverride || get('cidade'),
            'Foco': ctx.focoOverride || get('foco'),
            'Atuacao': atuacao,
            'Atuação': atuacao,
            'Área de Atuação': atuacao,
            'Area de Atuacao': atuacao,
            'Aplicacao': aplicacao,
            'Aplicação': aplicacao,
            'Equipamentos': equipamentos,
            'Gerencia': gerencia,
            'Gerência': gerencia,
            'Vl Mensal': vlMensal,
            'VL MENSAL R$': vlMensal,
            'Vl Mensal R$': vlMensal,
            'Valor Mensal': vlMensal,
            'Conclusao': conclusao,
            'Conclusão': conclusao,
            'Inf Importantes': inf,
            'Comentarios': com,
            'Comentários': com,
            'MotivoPerda': '',
            'SyncTimestamp': ctx.now
        };
    }
};

// Base de clientes exportada do sistema antigo → aba Clientes (usada só pra
// autofill de cliente / lookups, não é entidade sincronizada). Diferente das
// outras: modo "upsert" — o admin reexporta periodicamente pra atualizar a
// base, então Código já cadastrado ATUALIZA as colunas mapeadas em vez de
// pular. Só as colunas que o app lê entram; o resto do export é descartado.
const CLIENTES_SPEC = {
    sheet: 'Clientes',
    mode: 'upsert',
    requiredCol: 'nome',
    idHeaders: ['ID_Cliente', 'Id_Cliente', 'IdCliente', 'ID', 'Id', 'id'],
    ensure: [],
    cachePrefixes: ['formdata', 'clientes_raw_all', 'admin_all'],
    cols: {
        id: ['codigo', 'código', 'cod', 'cod cliente', 'codigo cliente', 'id', 'id cliente', 'id_cliente'],
        nome: ['nome', 'nome do cliente', 'nome cliente', 'cliente', 'razao social', 'razão social', 'razao', 'nome/razao social'],
        cidade: ['cidade', 'municipio', 'município'],
        // Só grafias específicas de "área de atuação" — nada de "grupo"/"ramo"
        // solto, que já pegou a coluna errada uma vez.
        area: ['area atuacao', 'area de atuacao', 'área de atuação', 'area de atuação', 'ramo de atividade', 'segmento'],
        vendedor: ['vendedor', 'vendedor responsavel', 'vendedor responsável', 'representante', 'consultor'],
        potencial: ['potencial', 'potencial do cliente', 'potencial cliente'],
        email: ['e-mail', 'email', 'e mail']
        // Contato e Telefone ficaram DE FORA de propósito (pedido do admin) —
        // não são lidos do export; se já existirem no cadastro, o upsert
        // mantém (mergeRow não toca em coluna que não está aqui).
    },
    buildRow(get, ctx) {
        const usouCadastro = ctx.resolved.matched && ctx.resolved.nome;
        const area = get('area');
        const email = get('email');
        return {
            'ID_Cliente': ctx.idCell ? "'" + ctx.idCell : String(ctx.now + ctx.seq),
            'Nome do Cliente': get('nome'),
            'Cidade': get('cidade'),
            'Área de Atuação': area,
            'Area de Atuacao': area,
            'Vendedores': usouCadastro ? ctx.resolved.nome : get('vendedor'),
            // Só grava gerência quando casou o vendedor — senão fica vazio e o
            // mergeRow mantém a que já estava no cadastro.
            'Gerencia': usouCadastro ? ctx.resolved.gerencia : '',
            'Gerência': usouCadastro ? ctx.resolved.gerencia : '',
            'Potencial do Cliente': get('potencial'),
            'E-mail': email,
            'Email': email
        };
    }
};

// ── Motor genérico ─────────────────────────────────────────────────────────

async function runLegacyImport(payload, spec) {
    await ensureAdmin(payload.user);

    const dryRun = payload.dryRun !== false;
    const vendedorMap = (payload.vendedorMap && typeof payload.vendedorMap === 'object') ? payload.vendedorMap : {};
    // { "NOME DO CLIENTE": "NomeVendedor" | "__IGNORAR__" } — usado só quando
    // a linha do arquivo não tem vendedor (spec.perClienteVendedor).
    const clienteVendedorMap = (payload.clienteVendedorMap && typeof payload.clienteVendedorMap === 'object') ? payload.clienteVendedorMap : {};
    const clienteKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

    let table;
    if (payload.xlsxBase64) {
        const b64 = String(payload.xlsxBase64);
        // O corpo da request no Vercel tem teto de ~4,5 MB — base64 infla 33%,
        // então trava um pouco antes. Excel comprime muito, cabe MUITA linha
        // nesse limite; se estourar, salvar como CSV resolve.
        if (b64.length > 4_000_000) {
            throw new Error('Excel muito grande pra enviar. Salve como CSV (Arquivo → Salvar Como → CSV UTF-8) ou divida em partes.');
        }
        try {
            table = xlsxToTable(Buffer.from(b64, 'base64'));
        } catch (e) {
            throw new Error('Não consegui ler o Excel (' + e.message + '). Se possível, salve como CSV e tente de novo.');
        }
    } else {
        const csvText = String(payload.csvText || '');
        if (!csvText.trim()) throw new Error('Envie um arquivo CSV ou Excel.');
        if (csvText.length > 6_000_000) {
            throw new Error('Arquivo muito grande. Divida a exportação em partes menores.');
        }
        // .xls antigo (binário OLE2) ou .xlsx mandado como texto — o começo
        // tem bytes nulos/de controle que um CSV nunca teria.
        if (/[\x00]/.test(csvText.slice(0, 2000)) || csvText.slice(0, 8) === 'PK\x03\x04') {
            throw new Error('Isso não parece um CSV. Se for .xls antigo, salve como .xlsx ou CSV UTF-8 no Excel.');
        }
        table = parseCsv(csvText);
    }
    if (table.length < 2) throw new Error('Planilha vazia ou sem linhas de dados.');

    const requiredCol = spec.requiredCol || 'cliente';
    const mode = spec.mode || 'skip';

    const csvHeaders = table[0].map((h) => String(h || '').trim());
    const idx = {};
    const colunasMapeadas = {};
    for (const [key, candidates] of Object.entries(spec.cols)) {
        idx[key] = findColIndex(csvHeaders, candidates);
        colunasMapeadas[key] = idx[key] > -1 ? csvHeaders[idx[key]] : null;
    }
    if (idx[requiredCol] === -1) {
        throw new Error(`CSV não reconhecido — coluna obrigatória "${requiredCol}" não encontrada.`);
    }
    const cell = (row, i) => (i > -1 ? String(row[i] ?? '').trim() : '');

    // Fonte de verdade de nome canônico + gerência.
    const vendedores = await getSheetObjects('Vendedores');
    const vendByNorm = new Map();
    vendedores.forEach((v) => {
        const n = normName(v.NomeVendedor);
        if (n) vendByNorm.set(n, { nome: v.NomeVendedor, gerencia: v.Gerencia || '' });
    });

    const apelidos = await readApelidos();
    const providedMap = new Map();
    for (const [de, para] of Object.entries(vendedorMap)) {
        providedMap.set(normName(de), String(para || '').trim());
    }
    const clienteVendMap = new Map();
    for (const [cli, para] of Object.entries(clienteVendedorMap)) {
        clienteVendMap.set(clienteKey(cli), String(para || '').trim());
    }
    // Para linhas sem vendedor: resolve pelo vendedor escolhido pro cliente.
    function resolveVendedorPorCliente(clienteRaw) {
        const target = clienteVendMap.get(clienteKey(clienteRaw));
        if (!target || target === IGNORAR) return null;
        const t = vendByNorm.get(normName(target));
        return t ? { matched: true, ...t } : null;
    }

    // Resolve um nome do arquivo: match direto → de-para deste upload →
    // apelido salvo. { matched, nome, gerencia, ignored }.
    function resolveVendedor(rawName) {
        const n = normName(rawName);
        if (!n) return { matched: true, nome: '', gerencia: '' };
        if (vendByNorm.has(n)) return { matched: true, ...vendByNorm.get(n) };
        if (providedMap.has(n)) {
            const target = providedMap.get(n);
            if (!target || target === IGNORAR) return { matched: true, nome: '', gerencia: '', ignored: true };
            const t = vendByNorm.get(normName(target));
            if (t) return { matched: true, ...t };
        }
        if (apelidos.has(n)) {
            const t = vendByNorm.get(normName(apelidos.get(n)));
            if (t) return { matched: true, ...t };
        }
        return { matched: false, nome: rawName, gerencia: '' };
    }

    if (!dryRun) await ensureColumns(spec.sheet, spec.ensure || []);
    const sheetHeaders = dryRun ? null : await getHeaders(spec.sheet);
    const idHeaders = spec.idHeaders || ['ID', 'Id', 'id'];
    const rowId = (r) => {
        for (const h of idHeaders) {
            const v = r[h];
            if (v !== undefined && String(v).trim() !== '') return String(v).trim();
        }
        return '';
    };
    const existing = await getSheetObjects(spec.sheet);
    const existingById = new Map();
    existing.forEach((r, i) => {
        const id = rowId(r);
        if (id && !existingById.has(id)) existingById.set(id, { rowNumber: i + 2, row: r });
    });

    const now = Date.now();
    let novas = 0, atualizadas = 0, puladas = 0, ignoradas = 0, descartadas = 0;
    const naoReconhecidos = new Map(); // normName -> { nome, linhas }
    const clientesSemVendedor = new Map(); // clienteKey -> { cliente, linhas }
    const newRows = [];
    const updates = [];
    const seenIds = new Set();

    // Revisão linha a linha (só pra Propostas/Funil): o front mostra cada
    // linha com o vendedor já preenchido e deixa trocar/ignorar/descartar.
    // linhaMap: { "<nº da linha>": "NomeVendedor" | "__IGNORAR__" | "__DESCARTAR__" }.
    const linhaMap = (payload.linhaMap && typeof payload.linhaMap === 'object') ? payload.linhaMap : {};
    // { "<nº da linha>": "valor de Potencial do Cliente" } — sobrescreve o Foco.
    const linhaFocoMap = (payload.linhaFocoMap && typeof payload.linhaFocoMap === 'object') ? payload.linhaFocoMap : {};
    const linhaCidadeMap = (payload.linhaCidadeMap && typeof payload.linhaCidadeMap === 'object') ? payload.linhaCidadeMap : {};
    const querRevisaoPorLinha = !!spec.perClienteVendedor;
    const LINHAS_CAP = 1500;
    const linhas = [];
    let linhasTotais = 0;
    let potenciaisCliente = [];
    let cidadesApp = [];
    if (querRevisaoPorLinha) {
        try {
            const pc = await getSheetObjects('PotenciaisCliente');
            potenciaisCliente = pc.map((row) => String(row.Potencial || '').trim()).filter(Boolean);
        } catch (e) { /* aba pode não existir */ }
        try {
            const cd = await getSheetObjects('Cidades');
            cidadesApp = cd.map((row) => String(row.Cidade || '').trim()).filter(Boolean);
        } catch (e) { /* aba pode não existir */ }
    }

    for (let r = 1; r < table.length; r++) {
        const csvRow = table[r];
        const get = (key) => cell(csvRow, idx[key] ?? -1);

        if (!get(requiredCol)) { ignoradas++; continue; }

        const idCell = get('id');
        const jaExiste = idCell && existingById.has(idCell);
        const jaVistoNesteArquivo = idCell && seenIds.has(idCell);

        // skip: ID já cadastrado nunca é tocado (dados históricos).
        // upsert: ID já cadastrado atualiza só as colunas mapeadas que o CSV
        // trouxe preenchidas (o resto da linha fica intacto).
        if (jaVistoNesteArquivo || (jaExiste && mode === 'skip')) { puladas++; continue; }

        const rawVend = get('vendedor');
        const nRawVend = normName(rawVend);
        const decisao = String(linhaMap[String(r)] || '').trim(); // decisão manual desta linha

        // "Desconsiderar essa linha": manual (linhaMap) ou pela escolha do
        // vendedor/cliente.
        const descartarLinha = decisao === DESCARTAR
            || (nRawVend && providedMap.get(nRawVend) === DESCARTAR)
            || (!nRawVend && spec.perClienteVendedor && clienteVendMap.get(clienteKey(get('cliente'))) === DESCARTAR);
        if (descartarLinha) { descartadas++; continue; }

        const resolved = resolveVendedor(rawVend);
        if (!resolved.matched && rawVend && !decisao) {
            const key = normName(rawVend);
            const entry = naoReconhecidos.get(key) || { nome: rawVend, linhas: 0 };
            entry.linhas++;
            naoReconhecidos.set(key, entry);
        }

        // Vendedor efetivo: decisão manual da linha > vendedor por cliente >
        // resolução automática do arquivo.
        let effResolved = resolved;
        if (decisao === IGNORAR) {
            effResolved = { matched: true, nome: '', gerencia: '' };
        } else if (decisao) {
            // Nome digitado na revisão por linha: usa o do cadastro (com
            // gerência) se casar; senão grava o texto como veio.
            const t = vendByNorm.get(normName(decisao));
            effResolved = t ? { matched: true, ...t } : { matched: true, nome: decisao, gerencia: '' };
        } else if (spec.perClienteVendedor && !nRawVend) {
            const cliRaw = get('cliente');
            const porCliente = resolveVendedorPorCliente(cliRaw);
            if (porCliente) {
                effResolved = porCliente;
            } else if (cliRaw) {
                const ck = clienteKey(cliRaw);
                const e = clientesSemVendedor.get(ck) || { cliente: cliRaw, linhas: 0 };
                e.linhas++;
                clientesSemVendedor.set(ck, e);
            }
        }

        if (querRevisaoPorLinha && dryRun) {
            linhasTotais++;
            if (linhas.length < LINHAS_CAP) {
                linhas.push({
                    n: r,
                    data: get('data'),
                    cliente: get('cliente'),
                    produtos: get('produtos'),
                    foco: get('foco'),
                    cidade: get('cidade'),
                    vendedorArquivo: rawVend,
                    vendedorSugerido: (effResolved.matched && effResolved.nome) ? effResolved.nome : ''
                });
            }
        }

        if (jaExiste) atualizadas++; else novas++;
        if (idCell) seenIds.add(idCell);
        if (dryRun) continue;

        const focoOverride = String(linhaFocoMap[String(r)] || '').trim();
        const cidadeOverride = String(linhaCidadeMap[String(r)] || '').trim();
        const fields = spec.buildRow(get, { resolved: effResolved, focoOverride, cidadeOverride, idCell, now, seq: newRows.length, payload });
        if (jaExiste) {
            const { rowNumber, row } = existingById.get(idCell);
            updates.push({ rowNumber, rowValues: mergeRow(sheetHeaders, fields, row) });
        } else {
            newRows.push(assembleRow(sheetHeaders, fields));
        }
    }

    if (!dryRun) {
        if (newRows.length) await appendRows(spec.sheet, newRows);
        if (updates.length) await batchUpdateRows(spec.sheet, updates);
        if (newRows.length || updates.length) clearCacheByPrefix(spec.cachePrefixes);
        // Salva os de-para resolvidos pra não perguntar de novo no próximo
        // export. Só nomes que apontam pra um vendedor de verdade — "deixar
        // sem vendedor" não vira apelido.
        const toSave = [];
        for (const [de, para] of Object.entries(vendedorMap)) {
            const p = String(para || '').trim();
            if (!de.trim() || !p || p === IGNORAR || p === DESCARTAR) continue;
            if (!apelidos.has(normName(de))) toSave.push([de.trim(), p]);
        }
        if (toSave.length) {
            await ensureApelidosSheet();
            await appendRows(APELIDOS_SHEET, toSave);
        }
    }

    const vendedoresNaoReconhecidos = Array.from(naoReconhecidos.values())
        .sort((a, b) => b.linhas - a.linhas);
    const vendedoresApp = vendedores
        .map((v) => String(v.NomeVendedor || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const clientesSemVendedorArr = Array.from(clientesSemVendedor.values())
        .sort((a, b) => b.linhas - a.linhas);

    return {
        status: 'success',
        dryRun,
        resumo: { novas, atualizadas, puladas, ignoradas, descartadas },
        colunasMapeadas,
        vendedoresNaoReconhecidos,
        clientesSemVendedor: clientesSemVendedorArr,
        linhas,
        linhasTruncadas: linhasTotais > linhas.length,
        potenciaisCliente,
        cidadesApp,
        vendedoresApp
    };
}

// ── Handlers expostos ──────────────────────────────────────────────────────

export async function handleImportVisitasLegacy(payload) {
    const tipo = String(payload.tipo || '').trim().toLowerCase();
    if (tipo !== 'ativas' && tipo !== 'prospeccao') {
        throw new Error('Tipo inválido — escolha "Visitas ativas" ou "Prospecção".');
    }
    return runLegacyImport({ ...payload, tipo }, VISITAS_SPEC);
}

export async function handleImportPropostasLegacy(payload) {
    return runLegacyImport(payload, PROPOSTAS_SPEC);
}

export async function handleImportFunilLegacy(payload) {
    return runLegacyImport(payload, FUNIL_SPEC);
}

export async function handleImportClientesLegacy(payload) {
    return runLegacyImport(payload, CLIENTES_SPEC);
}
