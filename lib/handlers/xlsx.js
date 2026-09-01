import zlib from 'node:zlib';

// ── Leitor mínimo de .xlsx (sem dependência externa) ────────────────────────
// Um .xlsx é um ZIP de XMLs. Aqui vai só o suficiente pra importar uma
// planilha exportada de sistema: descompacta o ZIP com o zlib nativo do
// Node, lê shared strings / inline strings / números, e converte data
// (que o Excel guarda como número de série) pra "dd/MM/aaaa".
// NÃO cobre: várias abas (usa a primeira), rich text com formatação
// (concatena o texto), fórmulas (usa o valor cacheado), ZIP64.

function u16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function u32(buf, off) {
    return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] * 0x1000000)) >>> 0;
}

// Lê o Central Directory do ZIP → { nome: { method, compSize, localOffset } }.
function readZipEntries(buf) {
    // End Of Central Directory (assinatura 0x06054b50), varrendo do fim — o
    // comentário do ZIP tem no máx. 65535 bytes.
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= minPos; i--) {
        if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('não é um arquivo ZIP/xlsx válido');
    const cdOffset = u32(buf, eocd + 16);
    const cdCount = u16(buf, eocd + 10);

    const entries = {};
    let p = cdOffset;
    for (let n = 0; n < cdCount && p + 46 <= buf.length; n++) {
        if (u32(buf, p) !== 0x02014b50) break;
        const method = u16(buf, p + 10);
        const compSize = u32(buf, p + 20);
        const nameLen = u16(buf, p + 28);
        const extraLen = u16(buf, p + 30);
        const commentLen = u16(buf, p + 32);
        const localOffset = u32(buf, p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        entries[name] = { method, compSize, localOffset };
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function extractEntry(buf, entry) {
    if (!entry) return null;
    const lh = entry.localOffset;
    if (u32(buf, lh) !== 0x04034b50) throw new Error('arquivo xlsx corrompido');
    // O "extra" do local header pode diferir do central — reler daqui.
    const nameLen = u16(buf, lh + 26);
    const extraLen = u16(buf, lh + 28);
    const start = lh + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compSize);
    if (entry.method === 0) return raw;                     // stored
    if (entry.method === 8) return zlib.inflateRawSync(raw); // deflate
    throw new Error('compressão do xlsx não suportada');
}

function decodeXmlEntities(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#([0-9]+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&'); // por último, senão desfaz os de cima
}
function safeCodePoint(n) {
    try { return String.fromCodePoint(n); } catch (e) { return ''; }
}

// sharedStrings.xml: um <si> por índice; cada <si> pode ter vários <t>.
function parseSharedStrings(xml) {
    if (!xml) return [];
    const out = [];
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml))) {
        let text = '';
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = tRe.exec(m[1]))) text += tm[1];
        out.push(decodeXmlEntities(text));
    }
    return out;
}

// styles.xml → Set com os índices de <xf> (o s="..." das células) que são
// formato de data.
function parseDateStyleIndexes(xml) {
    const dateStyles = new Set();
    if (!xml) return dateStyles;

    const builtinDate = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
    const customDate = new Set();
    const nfRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
    let m;
    while ((m = nfRe.exec(xml))) {
        const code = decodeXmlEntities(m[2]).replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
        if (/[dmy]/i.test(code)) customDate.add(Number(m[1]));
    }

    const block = (xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || ['', ''])[1];
    const xfRe = /<xf\b([^>]*?)\/?>/g;
    let idx = 0;
    while ((m = xfRe.exec(block))) {
        const idm = m[1].match(/numFmtId="(\d+)"/);
        const id = idm ? Number(idm[1]) : 0;
        if (builtinDate.has(id) || customDate.has(id)) dateStyles.add(idx);
        idx++;
    }
    return dateStyles;
}

function colLetterToIndex(ref) {
    const m = String(ref).match(/^([A-Z]+)/);
    if (!m) return 0;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

// Excel guarda data como nº de série (dias desde 1899-12-30, com o bug do
// ano 1900). 25569 = série de 1970-01-01, então (série - 25569) = dias
// desde a época Unix. Correto pra qualquer data real (série > 60).
function excelSerialToBR(serial) {
    const n = Number(serial);
    if (!Number.isFinite(n)) return String(serial);
    const d = new Date(Math.round((n - 25569) * 86400000));
    if (isNaN(d.getTime())) return String(serial);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function firstValue(body) {
    const m = body.match(/<v>([\s\S]*?)<\/v>/);
    return m ? m[1] : null;
}

function parseSheet(xml, shared, dateStyles) {
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
        const cells = [];
        const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm;
        while ((cm = cRe.exec(rm[1]))) {
            const attrs = cm[1];
            const body = cm[2] || '';
            const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
            const ci = ref ? colLetterToIndex(ref) : cells.length;
            const t = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
            const sIdx = (attrs.match(/\bs="(\d+)"/) || [])[1];

            let value = '';
            if (t === 's') {
                const vi = firstValue(body);
                value = vi != null ? (shared[Number(vi)] ?? '') : '';
            } else if (t === 'inlineStr') {
                let text = '';
                const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
                let tm;
                while ((tm = tRe.exec(body))) text += tm[1];
                value = decodeXmlEntities(text);
            } else if (t === 'str') {
                value = decodeXmlEntities(firstValue(body) || '');
            } else if (t === 'b') {
                value = firstValue(body) === '1' ? 'TRUE' : 'FALSE';
            } else {
                const vi = firstValue(body);
                if (vi == null || vi === '') value = '';
                else if (sIdx != null && dateStyles.has(Number(sIdx))) value = excelSerialToBR(vi);
                else value = String(vi);
            }
            cells[ci] = value;
        }
        for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
        rows.push(cells);
    }
    return rows;
}

function firstSheetPath(entries, dec) {
    const wb = dec('xl/workbook.xml');
    const rels = dec('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
        const fs = wb.match(/<sheet\b[^>]*r:id="([^"]+)"[^>]*\/?>/);
        if (fs) {
            const rid = fs[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rel = rels.match(new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*Target="([^"]+)"'));
            if (rel) {
                const path = 'xl/' + rel[1].replace(/^\.?\/?xl\//, '').replace(/^\.?\//, '');
                if (entries[path]) return path;
            }
        }
    }
    const cands = Object.keys(entries)
        .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
    return cands[0] || 'xl/worksheets/sheet1.xml';
}

// Buffer do .xlsx → array de linhas (cada linha = array de strings), no
// mesmo formato que o parseCsv devolve: linhas 100% vazias removidas.
export function xlsxToTable(buf) {
    const entries = readZipEntries(buf);
    const dec = (name) => {
        const e = entries[name];
        if (!e) return '';
        const out = extractEntry(buf, e);
        return out ? out.toString('utf8') : '';
    };

    const shared = parseSharedStrings(dec('xl/sharedStrings.xml'));
    const dateStyles = parseDateStyleIndexes(dec('xl/styles.xml'));
    const sheetXml = dec(firstSheetPath(entries, dec));
    if (!sheetXml) throw new Error('nenhuma planilha encontrada no arquivo');

    return parseSheet(sheetXml, shared, dateStyles)
        .map((r) => r.map((c) => (c == null ? '' : String(c))))
        .filter((r) => r.some((c) => c.trim() !== ''));
}
