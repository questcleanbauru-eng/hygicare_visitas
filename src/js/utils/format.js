import { state } from '../app.js';

export function formatDateFromDisplay(inputValue) {
    if (!inputValue || !inputValue.includes('-')) { return inputValue || ''; }
    const parts = inputValue.split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}


export function normalizeVisit(visit) {
    const rawDate = visit['Data da Visita'] || visit.dataVisita || '';
    return {
        id: String(visit.ID || visit.id || ''),
        prospeccao: visit['Prospecção'] || visit.prospeccao || visit['Prospeccao'] || 'Sim',
        vendedorGerente: visit['Vendedor/Gerente'] || visit.vendedorGerente || '',
        dataVisita: rawDate,
        dataVisitaInput: formatInputDateFromDisplay(rawDate) || rawDate,
        horario: parseSheetTime(visit['Horário'] || visit.horario || visit['Horario'] || ''),
        cliente: visit['Cliente'] || visit.cliente || '',
        contato: visit['Contato'] || visit.contato || '',
        cidade: visit['Cidade'] || visit.cidade || '',
        areaAtuacao: visit['Área de Atuação'] || visit['Area de Atuacao'] || visit.areaAtuacao || '',
        potencialCliente: visit['Potencial do Cliente'] || visit.potencialCliente || '',
        tipoVisita: visit['Tipo da Visita'] || visit.tipoVisita || '',
        gerencia: visit['Gerência'] || visit['Gerencia'] || visit.gerencia || '',
        veiculo: visit['Qual o Veículo?'] || visit['Qual o Veiculo?'] || visit.veiculo || 'Particular',
        observacao: visit['Observação'] || visit['Observacao'] || visit.observacao || '',
        latitude: visit['Latitude'] || visit.latitude || '',
        longitude: visit['Longitude'] || visit.longitude || '',
        _pending: !!visit._pending
    };
}


export function normalizeProposal(proposal) {
    const atualizacao = proposal['Atualização'] || proposal['Atualizacao'] || proposal.atualizacao || '';
    const daysWithoutUpdate = calculateDaysFromDisplayDate(atualizacao);
    return {
        id: String(proposal.Id || proposal.ID || proposal.id || ''),
        data: proposal.Data || proposal.data || '',
        vendedor: proposal.Vendedor || proposal.vendedor || '',
        cliente: proposal.Cliente || proposal.cliente || '',
        foco: proposal.Foco || proposal.foco || '',
        produtos: proposal.Produtos || proposal.produtos || '',
        gerencia: proposal.Gerencia || proposal['Gerência'] || proposal.gerencia || '',
        cidade: proposal.Cidade || proposal.cidade || '',
        status: proposal.Status || proposal.status || '',
        atualizacao,
        hora: parseSheetTime(proposal.Hora || proposal.hora || ''),
        obs: proposal['Observação'] || proposal['Observacao'] || proposal['Atualizar/OBS'] || proposal.obs || proposal.observacao || '',
        dataLimite: proposal['Data Limite'] || proposal.dataLimite || '',
        email: proposal['E-mail'] || proposal.email || '',
        atrasada: (proposal.Status || proposal.status || '').toUpperCase() === 'AGUARDANDO' && daysWithoutUpdate > 30,
        diasAtraso: daysWithoutUpdate,
        _pending: !!proposal._pending
    };
}


export function normalizeContrato(contrato) {
    const c = contrato || {};
    const fim = c.Fim || c.fim || '';
    const inicio = c.Inicio || c.inicio || '';
    const diasRestantes = fim ? -calculateDaysFromDisplayDate(fim) : null;
    // Algumas linhas antigas trazem erro de fórmula da planilha (ex: "#REF!")
    // em vez de Sim/Não — trata qualquer coisa que não seja "Não" como "Sim"
    // em vez de mostrar o erro cru pro usuário.
    const rawAviso = String(c.EnviarAviso || c.enviarAviso || '').trim().toLowerCase();
    const enviarAviso = ['nao', 'não', 'no'].includes(rawAviso) ? 'Não' : 'Sim';
    return {
        id: String(c.Id || c.ID || c.id || ''),
        ativo: c.Ativo || c.ativo || 'Sim',
        data: c.Data || c.data || '',
        vendedor: c.Vendedor || c.vendedor || '',
        cliente: c.Cliente || c.cliente || '',
        cidade: c.Cidade || c.cidade || '',
        assinado: c.Assinado || c.assinado || 'Nao',
        inicio,
        fim,
        anexo: c.Anexo || c.anexo || '',
        enviarAviso,
        obs: c.Obs || c.obs || '',
        diasRestantes,
        vencido: diasRestantes !== null && diasRestantes < 0,
        venceEmBreve: diasRestantes !== null && diasRestantes >= 0 && diasRestantes <= 30,
        _pending: !!c._pending
    };
}


export function normalizeManutencao(item) {
    const m = item || {};
    return {
        id: String(m.Id || m.ID || m.id || ''),
        data: m.Data || m.data || '',
        tecnico: m.Tecnico || m.tecnico || '',
        gerencia: m.Gerencia || m.gerencia || '',
        cliente: m.Cliente || m.cliente || '',
        cidade: m.Cidade || m.cidade || '',
        itensTabela: m.ItensTabela || m.itensTabela || '[]',
        observacao: m.Observacao || m.observacao || '',
        assinaturaTecnico: m.AssinaturaTecnico || m.assinaturaTecnico || '',
        assinaturaCliente: m.AssinaturaCliente || m.assinaturaCliente || '',
        pendenteAprovacao: m.PendenteAprovacao || m.pendenteAprovacao || '',
        _pending: !!m._pending
    };
}


export function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


export function formatDateForDisplay(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}


export function formatTimeForInput(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}


export function formatTimeFieldValue(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 4);
    if (digits.length <= 2) {
        return digits;
    }
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}


export function visitTypeClass(tipo) {
    const t = (tipo || '').toUpperCase();
    if (t.includes('PREVENTIVA')) { return 'tag tag-preventiva'; }
    if (t.includes('PEDIDO'))     { return 'tag tag-pedido'; }
    if (t.includes('MANUT') || t.includes('OPEN')) { return 'tag tag-manutencao'; }
    if (t.includes('PROJETO'))    { return 'tag tag-projeto'; }
    return 'tag tag-visita';
}


export function proposalStatusClass(status, overdue) {
    if (overdue) { return 'status-pill status-overdue'; }
    const s = (status || '').toUpperCase();
    if (s === 'AGUARDANDO')         { return 'status-pill status-aguardando'; }
    if (s.includes('CONCLU'))       { return 'status-pill status-concluido'; }
    if (s.includes('CANCEL'))       { return 'status-pill status-cancelado'; }
    if (s.includes('PERDI'))        { return 'status-pill status-perdido'; }
    if (s.includes('ANDAMENTO') || s.includes('PROGRESS')) { return 'status-pill status-andamento'; }
    return 'status-pill';
}


// ── Ícones (redesenho visual) ─────────────────────────────────────────
// Mapeamento por palavra-chave (não é lista fechada) — cobre tipo de
// visita, que vem dinâmico da planilha e não tem valores fixos no código.

export function visitTypeIcon(tipo) {
    const t = (tipo || '').toUpperCase();
    if (t.includes('PREVENTIVA'))   { return '🛡️'; }
    if (t.includes('PEDIDO'))       { return '📦'; }
    if (t.includes('MANUT'))        { return '🔧'; }
    if (t.includes('PROSPEC'))      { return '🎯'; }
    if (t.includes('TREINAMENTO'))  { return '🎓'; }
    if (t.includes('ENTREGA'))      { return '🚚'; }
    if (t.includes('INFORMA'))      { return 'ℹ️'; }
    if (t.includes('TESTE'))        { return '🧪'; }
    if (t.includes('NEGOCIA'))      { return '🤝'; }
    if (t.includes('FECHAMENTO'))   { return '🏁'; }
    if (t.includes('APRESENTA'))    { return '📊'; }
    if (t.includes('DOCUMENTO'))    { return '📄'; }
    if (t.includes('ATUALIZAR'))    { return '🔄'; }
    if (t.includes('OPEN'))         { return '🔓'; }
    if (t.includes('CLOSE'))        { return '🔒'; }
    if (t.includes('PROJETO'))      { return '📐'; }
    return '📋';
}

// Alguns registros antigos (importados da planilha manual) já guardam o
// valor com "R$" incluído no texto — remove o prefixo antes de reexibir,
// senão duplica ("R$ R$ 1,00").
export function formatCurrency(value) {
    const clean = String(value || '').replace(/^\s*r\$\s*/i, '').trim();
    return clean ? `R$ ${clean}` : '';
}

// Converte texto de moeda BR ("R$ 1.234,56") pro Number equivalente (1234.56)
// — remove "R$"/espaços, remove "." de milhar, troca "," decimal por ".".
export function parseCurrencyBR(raw) {
    const cleaned = String(raw || '').replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
    return Number(cleaned) || 0;
}

export function proposalStatusIcon(status) {
    const s = (status || '').toUpperCase();
    if (s.includes('GANH'))     { return '🏆'; }
    if (s.includes('PERDI'))    { return '❌'; }
    if (s.includes('NEGOCIA'))  { return '🤝'; }
    if (s.includes('ENVIA') || s === 'AGUARDANDO') { return '📤'; }
    if (s.includes('CONCLU'))   { return '🏆'; }
    if (s.includes('CANCEL'))   { return '❌'; }
    return '📄';
}

export function funilStatusIcon(status) {
    const s = (status || '').toUpperCase();
    if (s.includes('IDENTIFICAR')) { return '🔎'; }
    if (s.includes('PROPOSTA'))    { return '📄'; }
    if (s.includes('NEGOCIA'))     { return '🤝'; }
    if (s.includes('CONCLU'))      { return '🏆'; }
    if (s.includes('PERDI'))       { return '❌'; }
    if (s.includes('RETOMAR'))     { return '🔄'; }
    return '📊';
}

export function contratoSituacaoIcon(contrato) {
    if (contrato && contrato.vencido)       { return '🔴'; }
    if (contrato && contrato.venceEmBreve)  { return '⏰'; }
    return '✅';
}

// Ícone por rótulo de campo (usado em renderDetailRow) — casamento por
// palavra-chave, não por string exata, pra cobrir variações de grafia
// ("Vendedor/Gerente" vs "Vendedor", "Data" vs "Data da Visita" etc.)
// sem precisar de uma entrada por variação.
// Ícones de linha em SVG (currentColor) — mesma decisão já tomada pro menu
// (ver NAV_ICON_SVG em ui.js: "renderizar igual em qualquer SO/navegador"),
// só que essa tela ainda usava emoji cru. stroke-width/viewBox batem com o
// conjunto do menu pra manter as duas telas com a mesma linguagem visual.
const FIELD_ICON = {
    hash:      '<circle cx="12" cy="12" r="10"/><line x1="9" y1="8" x2="9" y2="16"/><line x1="15" y1="8" x2="15" y2="16"/>',
    search:    '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>',
    target:    '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="10"/>',
    user:      '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    clock:     '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
    calendar:  '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    building:  '<rect x="4" y="3" width="16" height="18" rx="1"/><line x1="8" y1="7" x2="8.01" y2="7"/><line x1="12" y1="7" x2="12.01" y2="7"/><line x1="16" y1="7" x2="16.01" y2="7"/><line x1="8" y1="11" x2="8.01" y2="11"/><line x1="12" y1="11" x2="12.01" y2="11"/><line x1="16" y1="11" x2="16.01" y2="11"/><line x1="8" y1="15" x2="16" y2="15"/>',
    phone:     '<path d="M4 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L14 13l5 2v4a2 2 0 0 1-2 2C9.6 21 3 14.4 3 6a2 2 0 0 1 1-2z"/>',
    mail:      '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/>',
    pin:       '<path d="M12 22s7-6.1 7-12a7 7 0 0 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
    factory:   '<path d="M3 21V9l6 4V9l6 4V6h6v15z"/><line x1="3" y1="21" x2="21" y2="21"/>',
    star:      '<polygon points="12 2 15 9 22 9.5 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.5 9 9"/>',
    tag:       '<path d="M20 12.5 12.5 20a1.5 1.5 0 0 1-2.1 0l-6.4-6.4a1.5 1.5 0 0 1 0-2.1L11.5 4H20z"/><circle cx="15.5" cy="8.5" r="1.5"/>',
    briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    car:       '<path d="M4 16V11l2-5h12l2 5v5"/><rect x="3" y="13" width="18" height="6" rx="1.5"/><circle cx="7.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/>',
    bulb:      '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11.2c.5.4.8 1 .8 1.8h4.4c0-.8.3-1.4.8-1.8A6 6 0 0 0 12 3z"/>',
    box:       '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><polyline points="3 8 12 13 21 8"/><line x1="12" y1="13" x2="12" y2="21"/>',
    activity:  '<polyline points="3 12 8 12 10 6 14 18 16 12 21 12"/>',
    check:     '<circle cx="12" cy="12" r="10"/><polyline points="8 12.5 11 15.5 16 9"/>',
    pen:       '<path d="M4 20l3.5-.9 11-11a2 2 0 0 0-3-3l-11 11z"/><line x1="15" y1="5" x2="19" y2="9"/>',
    bell:      '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    wrench:    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    coin:      '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="17"/><path d="M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.3 1.3 1.9 3 2.2 3 .9 3 2.2-1.3 2.3-3 2.3-3-1.1-3-2.5"/>',
    flag:      '<line x1="5" y1="21" x2="5" y2="3"/><path d="M5 4h13l-3 5 3 5H5"/>',
    note:      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'
};

function fieldIconSvg(key) {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FIELD_ICON[key]}</svg>`;
}

export function getFieldIcon(label) {
    const l = String(label || '').trim().toLowerCase();
    if (l === 'id') { return fieldIconSvg('hash'); }
    if (l.includes('busca') || l.includes('pesquis')) { return fieldIconSvg('search'); }
    if (l.includes('prospec')) { return fieldIconSvg('target'); }
    if (l.includes('vendedor')) { return fieldIconSvg('user'); }
    if (l.includes('horário') || l.includes('horario') || l === 'hora') { return fieldIconSvg('clock'); }
    if (l.includes('data') || l.includes('início') || l.includes('inicio') || l.includes('fim') || l.includes('limite') || l.includes('atualiza') || l.includes('período') || l.includes('periodo') || l.includes('criaç') || l.includes('criac')) { return fieldIconSvg('calendar'); }
    if (l.includes('cliente')) { return fieldIconSvg('building'); }
    if (l.includes('contato')) { return fieldIconSvg('phone'); }
    if (l.includes('e-mail') || l.includes('email')) { return fieldIconSvg('mail'); }
    if (l.includes('cidade')) { return fieldIconSvg('pin'); }
    if (l.includes('atuação') || l.includes('atuacao')) { return fieldIconSvg('factory'); }
    if (l.includes('potencial')) { return fieldIconSvg('star'); }
    if (l.includes('tipo')) { return fieldIconSvg('tag'); }
    if (l.includes('gerênc') || l.includes('gerenc')) { return fieldIconSvg('briefcase'); }
    if (l.includes('veículo') || l.includes('veiculo')) { return fieldIconSvg('car'); }
    if (l.includes('foco')) { return fieldIconSvg('bulb'); }
    if (l.includes('produto')) { return fieldIconSvg('box'); }
    if (l.includes('status') || l.includes('situação') || l.includes('situacao')) { return fieldIconSvg('activity'); }
    if (l.includes('ativo')) { return fieldIconSvg('check'); }
    if (l.includes('assinado')) { return fieldIconSvg('pen'); }
    if (l.includes('aviso')) { return fieldIconSvg('bell'); }
    if (l.includes('aplicaç') || l.includes('aplicac')) { return fieldIconSvg('settings'); }
    if (l.includes('equipamento')) { return fieldIconSvg('wrench'); }
    if (l.includes('vl mensal') || l.includes('valor')) { return fieldIconSvg('coin'); }
    if (l.includes('conclus')) { return fieldIconSvg('flag'); }
    if (l.includes('observ') || l === 'obs' || l.includes('coment') || l.includes('inf important') || l.includes('informaç') || l.includes('informac')) { return fieldIconSvg('note'); }
    return '';
}

// Rótulo de <label> de filtro/formulário com ícone prefixado — mesma lógica
// de ícone do renderDetailRow, reaproveitada aqui pra manter consistência
// visual entre tela de detalhe e filtros.
export function filterLabelHtml(label) {
    const icon = getFieldIcon(label);
    return `${icon ? `<span class="detail-label-icon" aria-hidden="true">${icon}</span>` : ''}${escapeHtml(label)}`;
}


export function getDateRangeForPeriod(period) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    if (period === 'semana-atual') {
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
        return { start, end: today };
    }
    if (period === 'mes-atual') {
        return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: today };
    }
    if (period === 'ultimos-3m') {
        return { start: new Date(today.getFullYear(), today.getMonth() - 2, 1), end: today };
    }
    return { start: null, end: null };
}


export function isAdminOrGerenteUser() {
    return ['admin', 'gerente'].includes((state.currentUser?.profile || '').toLowerCase());
}


export function parseSheetTime(value) {
    if (!value || typeof value !== 'string') { return value || ''; }
    // Google Sheets serializes time-only cells as ISO datetime with 1899-12-30 epoch
    const m = value.match(/T(\d{2}):(\d{2})/);
    if (m) { return `${m[1]}:${m[2]}`; }
    return value;
}


export function normalizeTimeValue(value) {
    const formatted = formatTimeFieldValue(value);
    const match = formatted.match(/^(\d{2}):(\d{2})$/);
    if (!match) {
        return '';
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return '';
    }

    return formatted;
}


export function formatInputDateFromDisplay(value) {
    if (!value || typeof value !== 'string' || !value.includes('/')) {
        return value;
    }
    const [day, month, yearRaw] = value.split('/');
    if (!day || !month || !yearRaw) {
        return value;
    }
    // Dado legado às vezes vem com ano de 2 dígitos ("10/06/14") — sem
    // expandir pra 4 dígitos, o <input type="date"> recebe um ISO inválido
    // e mostra o campo em branco. Pivô 69: 00-69 vira 20xx, 70-99 vira 19xx.
    let year = yearRaw;
    if (/^\d{2}$/.test(year)) {
        const y = Number(year);
        year = String(y <= 69 ? 2000 + y : 1900 + y);
    }
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}


export function formatDateFieldValue(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
    if (digits.length <= 2) {
        return digits;
    }
    if (digits.length <= 4) {
        return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    }
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}


export function normalizeDisplayDateValue(value) {
    // Data que já vem com barra (ex.: "29/7/2026", comum quando a planilha
    // não completa dia/mês com zero à esquerda) — usa os grupos capturados
    // direto, sem passar pelo reformatador de digitação (formatDateFieldValue
    // abaixo, feito pra ir montando a data enquanto o usuário digita only
    // dígitos crus). Esse reformatador assume sempre 2+2+4 dígitos; numa
    // data como "29/7/2026" (7 dígitos, não 8) ele fatiava errado e a data
    // virava inválida — o registro caía em "Sem data" mesmo tendo data.
    const raw = String(value || '').trim();
    const flexMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const formatted = flexMatch
        ? `${flexMatch[1].padStart(2, '0')}/${flexMatch[2].padStart(2, '0')}/${flexMatch[3]}`
        : formatDateFieldValue(value);
    const match = formatted.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) {
        return '';
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(year, month - 1, day);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return '';
    }

    return formatted;
}


export function calculateDaysFromDisplayDate(value) {
    // Passa pela mesma validação de calendário do normalizeDisplayDateValue —
    // sem isso, uma data impossível como 31/02 rolava silenciosamente pro JS
    // (vira 03/03) em vez de ser tratada como inválida.
    const normalized = normalizeDisplayDateValue(value);
    if (!normalized) {
        return 0;
    }
    const [day, month, year] = normalized.split('/').map(Number);
    const date = new Date(year, month - 1, day);
    const diff = Date.now() - date.getTime();
    return Math.floor(diff / 86400000);
}


export function parseDisplayDate(value) {
    const normalizedValue = normalizeDisplayDateValue(value);
    if (!normalizedValue) {
        return null;
    }
    const [day, month, year] = normalizedValue.split('/').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
}


export function parseInputDate(value) {
    if (!value || !String(value).includes('-')) {
        return null;
    }
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
}


export function compareVisitsByDateDesc(firstVisit, secondVisit) {
    const firstDate = parseDisplayDate(firstVisit.dataVisita);
    const secondDate = parseDisplayDate(secondVisit.dataVisita);
    const firstTime = firstDate ? firstDate.getTime() : 0;
    const secondTime = secondDate ? secondDate.getTime() : 0;

    if (firstTime !== secondTime) {
        return secondTime - firstTime;
    }

    return String(secondVisit.horario || '').localeCompare(String(firstVisit.horario || ''));
}


export function groupVisitsByMonth(visits) {
    return visits.reduce((groups, visit) => {
        const visitDate = parseDisplayDate(visit.dataVisita);
        const monthKey = visitDate
            ? `${visitDate.getFullYear()}-${String(visitDate.getMonth() + 1).padStart(2, '0')}`
            : 'Sem data';

        if (!groups[monthKey]) {
            groups[monthKey] = [];
        }

        groups[monthKey].push(visit);
        return groups;
    }, {});
}


export function formatMonthKey(monthKey) {
    if (monthKey === 'Sem data') {
        return monthKey;
    }

    const [year, month] = monthKey.split('-').map(Number);
    const date = new Date(year, month - 1, 1);
    const label = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(date);
    return label.charAt(0).toUpperCase() + label.slice(1);
}


export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}


export function titleCase(str) {
    if (!str) { return ''; }
    return String(str).toLowerCase().replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
}


export function getInitials(name) {
    if (!name) { return '?'; }
    const words = String(name).trim().split(/\s+/);
    return words.slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}


export function profileClass(profile) {
    const p = (profile || '').toLowerCase();
    if (p === 'gerente') { return 'gerente'; }
    if (p === 'admin') { return 'admin'; }
    return 'vendedor';
}
