import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from 'docx';

// Dados fixos das duas empresas que podem emitir o contrato de comodato —
// copiados dos contratos de verdade já assinados (ver pasta "CONTRATOS
// HYGICARE VS CLIENTES" do Bruno). Sem fallback: o admin escolhe uma das
// duas na hora de gerar (ver handleGerarContratoComodato).
export const EMPRESAS_COMODATO = {
    hygicare: {
        nome: 'HYGICARE PRODUTOS DE HIGIENE LTDA',
        cnpj: '08.159.080/0001-34',
        endereco: 'Rua Dr. Jose Ranieri, 9-41',
        bairro: 'Jardim Cruzeiro do Sul',
        cidade: 'Bauru',
        estado: 'São Paulo',
        cep: '17030-370'
    },
    quest: {
        nome: 'QUEST CLEAN PRODUTOS DE HIGIENE LTDA',
        cnpj: '26.135.199/0001-59',
        endereco: 'Rua Jacob Corso, nº 3-62-41',
        bairro: 'Jardim Hojas',
        cidade: 'Bauru',
        estado: 'São Paulo',
        cep: '17020-830'
    }
};

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function dataPorExtenso(date) {
    return `${date.getDate()} de ${MESES[date.getMonth()]} de ${date.getFullYear()}`;
}

const BORDER = { style: BorderStyle.SINGLE, size: 2, color: 'CBD5E1' };
const CELL_BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

function cell(text, { header = false, width } = {}) {
    return new TableCell({
        width: width ? { size: width, type: WidthType.DXA } : undefined,
        borders: CELL_BORDERS,
        shading: header ? { fill: 'F1F5F9' } : undefined,
        children: [new Paragraph({ children: [new TextRun({ text: String(text || ''), bold: header, size: 20 })] })]
    });
}

function itensTable(itens) {
    const rows = [
        new TableRow({ children: [cell('DESCRIÇÃO', { header: true, width: 5000 }), cell('QUANTIDADE', { header: true, width: 2500 }), cell('OBSERVAÇÃO', { header: true, width: 2500 })] })
    ];
    itens.forEach((it) => {
        rows.push(new TableRow({ children: [
            cell(it.equipamento, { width: 5000 }),
            cell(`${it.quantidade} UNIDADE${Number(it.quantidade) > 1 ? 'S' : ''}`, { width: 2500 }),
            cell(it.observacao || '', { width: 2500 })
        ] }));
    });
    return new Table({ width: { size: 10000, type: WidthType.DXA }, columnWidths: [5000, 2500, 2500], rows });
}

function paragrafo(text, opts = {}) {
    return new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text, size: 22, bold: !!opts.bold })] });
}

function assinaturaBlock(nome, cnpj) {
    return [
        new Paragraph({ spacing: { before: 400 }, text: '________________________________________________' }),
        paragrafo(`NOME: ${nome}`),
        paragrafo(`CNPJ: ${cnpj}`)
    ];
}

// Modelo "elaborado" — contrato completo (preâmbulo, objeto, cláusulas de
// uso/mau uso/responsabilidade/prazo/devolução, assinaturas), igual ao
// modelo real já usado pela Hygicare (MODELO DE CONTRATO - HYGICARE - ANO
// 2025 - (COMODATO DE EQUIPAMENTOS).docx) — só com a empresa/cliente/itens
// trocados pelos da ocorrência.
function buildElaborado({ empresa, cliente, itens, dataContrato }) {
    const children = [
        new Paragraph({ heading: 'Heading1', alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: 'ACORDO COMERCIAL', bold: true, size: 28 })] }),
        paragrafo('As partes abaixo identificadas celebram o presente Acordo Comercial, o qual será regido pelas cláusulas e condições estabelecidas a seguir.'),
        paragrafo('PREÂMBULO:', { bold: true }),
        paragrafo(`1. FORNECEDORA: ${empresa.nome}, inscrita no CNPJ sob nº ${empresa.cnpj}, com sede na ${empresa.endereco}, bairro ${empresa.bairro}, cidade ${empresa.cidade} Estado de ${empresa.estado}, CEP ${empresa.cep}, doravante denominada FORNECEDORA, neste ato representada na forma de seu contrato social.`),
        paragrafo(`2. CLIENTE: ${cliente.nome}, inscrita no CNPJ sob nº ${cliente.cnpj || '[CNPJ não informado]'}, com sede na ${cliente.endereco || '[endereço não informado]'}, bairro ${cliente.bairro || '[bairro não informado]'}, cidade ${cliente.cidade || '[cidade não informada]'}, Estado de ${cliente.estado || '[estado não informado]'}, CEP ${cliente.cep || '[CEP não informado]'} neste ato devidamente representada na forma de seu contrato social, doravante denominada simplesmente CLIENTE.`),
        paragrafo('3. OBJETO', { bold: true }),
        paragrafo('3.1. O presente contrato tem como objeto o empréstimo, a título de comodato, dos seguintes equipamentos:'),
        itensTable(itens),
        paragrafo(''),
        paragrafo('4. CLÁUSULA QUARTA – DO OBJETO', { bold: true }),
        paragrafo('4.1. A Comodante cede, em comodato, os equipamentos acima descritos, em perfeito estado de funcionamento, para uso exclusivo da Comodatária, conforme condições estabelecidas neste contrato.'),
        paragrafo('5. CLÁUSULA QUINTA – DO USO DOS EQUIPAMENTOS', { bold: true }),
        paragrafo('5.1. A Comodatária compromete-se a utilizar os equipamentos única e exclusivamente com os produtos fornecidos pela Comodante, sendo vedado o uso de produtos ou acessórios de terceiros.'),
        paragrafo('6. CLÁUSULA SEXTA – DO MAU USO', { bold: true }),
        paragrafo('6.1. Em caso de mau uso, uso inadequado, negligência, ou utilização em desacordo com as instruções fornecidas, a Comodatária será a única responsável por todos os danos causados aos equipamentos, obrigando-se a ressarcir integralmente a Comodante pelos custos de reparo ou substituição.'),
        paragrafo('7. CLÁUSULA SÉTIMA – DA RESPONSABILIDADE', { bold: true }),
        paragrafo('7.1. A Comodatária declara receber os equipamentos em perfeito estado e se responsabiliza pelo extravio, perda ou destruição, comprometendo-se a indenizar a Comodante conforme valor de mercado ou nota fiscal.'),
        paragrafo('8. CLÁUSULA OITAVA – DO PRAZO', { bold: true }),
        paragrafo('8.1. O presente contrato terá vigência por prazo indeterminado, podendo ser rescindido por qualquer das partes mediante aviso prévio, por escrito, com antecedência mínima de 30 (trinta) dias.'),
        paragrafo('9. CLÁUSULA NONA – DA DEVOLUÇÃO', { bold: true }),
        paragrafo('9.1. Findo ou rescindido o contrato, a Comodatária deverá devolver todos os equipamentos à Comodante no prazo máximo de 15 (quinze) dias úteis, em perfeitas condições de uso.'),
        paragrafo('As Partes assinam o presente instrumento em 2 (duas) vias de igual forma e teor, para que produza seus efeitos legais.'),
        paragrafo(`${empresa.cidade.toUpperCase()}, ${dataPorExtenso(dataContrato)}`),
        ...assinaturaBlock(empresa.nome, empresa.cnpj),
        ...assinaturaBlock(cliente.nome, cliente.cnpj || '[CNPJ não informado]')
    ];
    return children;
}

// Modelo "simples" — recibo enxuto (sem cláusulas), pro comodato de baixo
// valor/risco onde o contrato completo é exagero — mesmo espírito dos
// "RECIBO DE COMODATO"/"PEDIDO DE VENDA" que o Bruno já usa pra isso.
function buildSimples({ empresa, cliente, itens, dataContrato, observacao }) {
    const children = [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: 'RECIBO DE COMODATO DE EQUIPAMENTOS', bold: true, size: 28 })] }),
        paragrafo(`${empresa.nome} — CNPJ ${empresa.cnpj}`, { bold: true }),
        paragrafo(`${empresa.endereco}, ${empresa.bairro}, ${empresa.cidade}/${empresa.estado} — CEP ${empresa.cep}`),
        paragrafo(''),
        paragrafo(`Cliente: ${cliente.nome}${cliente.cnpj ? ' — CNPJ ' + cliente.cnpj : ''}`, { bold: true }),
        cliente.cidade ? paragrafo(`Cidade: ${cliente.cidade}`) : paragrafo(''),
        paragrafo(`Data: ${dataPorExtenso(dataContrato)}`),
        paragrafo(''),
        itensTable(itens),
        paragrafo(''),
        observacao ? paragrafo(`Observações: ${observacao}`) : paragrafo(''),
        paragrafo('Recebi os equipamentos acima, em perfeito estado, a título de comodato, comprometendo-me a devolvê-los quando solicitado.'),
        ...assinaturaBlock(cliente.nome, cliente.cnpj || '')
    ];
    return children;
}

// itens: [{ equipamento, quantidade, observacao? }]
export async function buildComodatoDocx({ empresaKey, modelo, cliente, itens, dataContrato, observacao }) {
    const empresa = EMPRESAS_COMODATO[empresaKey] || EMPRESAS_COMODATO.hygicare;
    const children = modelo === 'simples'
        ? buildSimples({ empresa, cliente, itens, dataContrato: dataContrato || new Date(), observacao })
        : buildElaborado({ empresa, cliente, itens, dataContrato: dataContrato || new Date() });

    const doc = new Document({
        sections: [{ properties: {}, children }]
    });
    return Packer.toBuffer(doc);
}
