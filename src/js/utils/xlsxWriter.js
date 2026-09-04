// Gera um .xlsx de verdade, no navegador, sem nenhuma dependência — um
// .xlsx é só um .zip com XML dentro (OOXML). Escreve as entradas do zip
// "stored" (sem compressão), que é bem mais simples de montar na mão do
// que implementar DEFLATE, e o Excel abre igual.
//
// Uso: downloadXLSX(linhas, 'arquivo.xlsx', [{ key: 'campo', label: 'Coluna' }])

function crc32(bytes) {
    let table = crc32._table;
    if (!table) {
        table = crc32._table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(v) { return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]); }
function u32(v) { return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]); }

function concatBytes(chunks) {
    let total = 0;
    chunks.forEach((c) => { total += c.length; });
    const out = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((c) => { out.set(c, offset); offset += c.length; });
    return out;
}

// Zip mínimo: entradas "stored" (método 0) + diretório central + EOCD.
// Data/hora do DOS fixas (1980-01-01) — não faz diferença pro Excel.
function buildZip(files) {
    const DOS_TIME = 0;
    const DOS_DATE = 0x21;
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach(({ name, content }) => {
        const nameBytes = enc.encode(name);
        const dataBytes = enc.encode(content);
        const crc = crc32(dataBytes);
        const size = dataBytes.length;

        const local = concatBytes([
            u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
            u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0),
            nameBytes, dataBytes
        ]);
        localParts.push(local);

        centralParts.push(concatBytes([
            u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
            u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
            u16(0), u16(0), u32(0), u32(offset),
            nameBytes
        ]));

        offset += local.length;
    });

    const centralDir = concatBytes(centralParts);
    const eocd = concatBytes([
        u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
        u32(centralDir.length), u32(offset), u16(0)
    ]);

    return concatBytes([...localParts, centralDir, eocd]);
}

function xmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Índice de coluna (0-based) → letra da coluna do Excel (0→A, 25→Z, 26→AA…).
function colLetter(n) {
    let s = '';
    n += 1;
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

function buildSheetXml(headers, rows) {
    const cols = `<cols>${headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="24" customWidth="1"/>`).join('')}</cols>`;
    const cell = (col, r, value) => `<c r="${colLetter(col)}${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    const headerRow = `<row r="1">${headers.map((h, i) => cell(i, 1, h)).join('')}</row>`;
    const dataRows = rows.map((row, ri) => {
        const r = ri + 2;
        return `<row r="${r}">${headers.map((_, ci) => cell(ci, r, row[ci])).join('')}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `${cols}<sheetData>${headerRow}${dataRows}</sheetData></worksheet>`;
}

// Nome de aba do Excel: até 31 caracteres, sem : \ / ? * [ ].
function sanitizeSheetName(name) {
    const clean = String(name || 'Dados').replace(/[:\\/?*[\]]/g, ' ').trim();
    return (clean || 'Dados').slice(0, 31);
}

export function downloadXLSX(data, filename, columns, sheetName) {
    const headers = columns.map((c) => c.label);
    const rows = (data || []).map((row) => columns.map((c) => row[c.key] ?? ''));
    const sheet = sanitizeSheetName(sheetName);

    const files = [
        {
            name: '[Content_Types].xml',
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
                `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
                `<Default Extension="xml" ContentType="application/xml"/>` +
                `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
                `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
                `</Types>`
        },
        {
            name: '_rels/.rels',
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
                `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
                `</Relationships>`
        },
        {
            name: 'xl/workbook.xml',
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
                `<sheets><sheet name="${xmlEscape(sheet)}" sheetId="1" r:id="rId1"/></sheets>` +
                `</workbook>`
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
                `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
                `</Relationships>`
        },
        { name: 'xl/worksheets/sheet1.xml', content: buildSheetXml(headers, rows) }
    ];

    const blob = new Blob([buildZip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
