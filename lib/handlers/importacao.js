import {
    getSheetObjects, getHeaders, appendRow, appendRows, updateRow,
    sheetExists, createSheet, clearCacheByPrefix
} from '../sheets.js';
import { ensureAdmin } from '../common.js';

// ── Importação da base antiga (migração) ────────────────────────────────────
// Alimenta a aba `Visitas` do app com os relatórios exportados do sistema
// antigo (as abas BASE = visitas ativas e PROSPECÇÃO). Mesmo padrão da
// importação de CSV do Radar: admin-only, parser próprio, dedup por chave,
// appendRows pra não estourar a cota de escrita do Sheets, resumo de
// contagens devolvido pra tela.

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

// Grafias aceitas por coluna da planilha antiga (BASE / PROSPECÇÃO).
const VISITA_COLS = {
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
};

const APELIDOS_SHEET = 'ImportacaoApelidos';
const APELIDOS_HEADERS = ['De', 'Para'];
const IGNORAR = '__IGNORAR__';

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

// A aba Visitas já tem Latitude/Longitude (ensureVisitasGeoColumns) mas pode
// não ter Prospecção/SyncTimestamp numa planilha mais antiga — sem essas
// colunas o valor gravado pelo import seria descartado em silêncio
// (headers.map só escreve nas colunas que existem).
async function ensureVisitasImportColumns() {
    const headers = await getHeaders('Visitas');
    const missing = ['Prospecção', 'SyncTimestamp'].filter((h) => !headers.includes(h));
    if (missing.length) await updateRow('Visitas', 1, [...headers, ...missing]);
}

// Fluxo em 2 passos:
//  - dryRun:true  → só analisa. Devolve resumo (novas/puladas/ignoradas) e a
//    lista de vendedores do arquivo que não bateram com o cadastro, pra tela
//    montar o de-para.
//  - dryRun:false + vendedorMap → grava de verdade. vendedorMap é
//    { "NOME NO ARQUIVO": "NomeVendedor do app" | "__IGNORAR__" }; as
//    entradas resolvidas ficam salvas em ImportacaoApelidos pro próximo
//    export casar sozinho.
export async function handleImportVisitasLegacy(payload) {
    await ensureAdmin(payload.user);

    const tipo = String(payload.tipo || '').trim().toLowerCase();
    if (tipo !== 'ativas' && tipo !== 'prospeccao') {
        throw new Error('Tipo inválido — escolha "Visitas ativas" ou "Prospecção".');
    }
    const csvText = String(payload.csvText || '');
    if (!csvText.trim()) throw new Error('Envie um arquivo CSV.');
    if (csvText.length > 6_000_000) {
        throw new Error('Arquivo muito grande. Divida a exportação em partes menores.');
    }
    const dryRun = payload.dryRun !== false;
    const vendedorMap = (payload.vendedorMap && typeof payload.vendedorMap === 'object') ? payload.vendedorMap : {};

    const table = parseCsv(csvText);
    if (table.length < 2) throw new Error('CSV vazio ou sem linhas de dados.');

    const csvHeaders = table[0].map((h) => String(h || '').trim());
    const idx = {};
    for (const [key, candidates] of Object.entries(VISITA_COLS)) {
        idx[key] = findColIndex(csvHeaders, candidates);
    }
    if (idx.cliente === -1) {
        throw new Error('CSV não reconhecido — coluna "Cliente" não encontrada.');
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

    let visitasHeaders = null;
    let existingIds = null;
    if (!dryRun) {
        await ensureVisitasImportColumns();
        visitasHeaders = await getHeaders('Visitas');
        const existing = await getSheetObjects('Visitas');
        existingIds = new Set(
            existing.map((r) => String(r.ID ?? r.Id ?? '').trim()).filter(Boolean)
        );
    } else {
        const existing = await getSheetObjects('Visitas');
        existingIds = new Set(
            existing.map((r) => String(r.ID ?? r.Id ?? '').trim()).filter(Boolean)
        );
    }

    const prospeccaoValue = tipo === 'prospeccao' ? 'Sim' : 'Nao';
    const now = Date.now();

    let novas = 0, puladas = 0, ignoradas = 0;
    const naoReconhecidos = new Map(); // normName -> { nome, linhas }
    const newRows = [];
    const seenIds = new Set();

    for (let r = 1; r < table.length; r++) {
        const csvRow = table[r];
        const cliente = cell(csvRow, idx.cliente);
        if (!cliente) { ignoradas++; continue; }

        const rawId = cell(csvRow, idx.id);
        if (rawId && (existingIds.has(rawId) || seenIds.has(rawId))) { puladas++; continue; }

        const rawVend = cell(csvRow, idx.vendedor);
        const resolved = resolveVendedor(rawVend);
        if (!resolved.matched && rawVend) {
            const key = normName(rawVend);
            const entry = naoReconhecidos.get(key) || { nome: rawVend, linhas: 0 };
            entry.linhas++;
            naoReconhecidos.set(key, entry);
        }

        novas++;
        if (dryRun) continue;

        const usouCadastro = resolved.matched && resolved.nome;
        const vendedorFinal = usouCadastro ? resolved.nome : rawVend;
        const gerenciaFinal = usouCadastro ? resolved.gerencia : cell(csvRow, idx.gerencia);
        const horario = stripSeconds(cell(csvRow, idx.horario));
        const area = cell(csvRow, idx.area);
        const veiculo = cell(csvRow, idx.veiculo);
        const observacao = cell(csvRow, idx.observacao);

        // Apóstrofo força texto puro — sem isso, USER_ENTERED trata um ID só
        // de dígitos como número (come zeros à esquerda, notação científica).
        const fields = {
            'ID': rawId ? "'" + rawId : String(now + newRows.length),
            'Prospecção': prospeccaoValue,
            'Prospeccao': prospeccaoValue,
            'Vendedor/Gerente': vendedorFinal,
            'Data da Visita': cell(csvRow, idx.data),
            'Horário': horario,
            'Horario': horario,
            'Cliente': cliente,
            'Contato': cell(csvRow, idx.contato),
            'Cidade': cell(csvRow, idx.cidade),
            'Área de Atuação': area,
            'Area de Atuacao': area,
            'Potencial do Cliente': cell(csvRow, idx.potencial),
            'Tipo da Visita': cell(csvRow, idx.tipo),
            'Gerência': gerenciaFinal,
            'Gerencia': gerenciaFinal,
            'Qual o Veículo?': veiculo,
            'Qual o Veiculo?': veiculo,
            'Observação': observacao,
            'Observacao': observacao,
            'Latitude': '',
            'Longitude': '',
            'SyncTimestamp': now
        };
        newRows.push(visitasHeaders.map((h) => (fields[h] !== undefined ? fields[h] : '')));
        if (rawId) seenIds.add(rawId);
    }

    if (!dryRun) {
        if (newRows.length) {
            await appendRows('Visitas', newRows);
            clearCacheByPrefix(['v_', 'vp_raw', 'd_', 'visitas_sheet_raw']);
        }
        // Salva os de-para resolvidos pra não perguntar de novo no próximo
        // export. Só nomes que apontam pra um vendedor de verdade — "deixar
        // sem vendedor" não vira apelido.
        const toSave = [];
        for (const [de, para] of Object.entries(vendedorMap)) {
            const p = String(para || '').trim();
            if (!de.trim() || !p || p === IGNORAR) continue;
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

    return {
        status: 'success',
        dryRun,
        resumo: { novas, puladas, ignoradas },
        vendedoresNaoReconhecidos,
        vendedoresApp
    };
}
