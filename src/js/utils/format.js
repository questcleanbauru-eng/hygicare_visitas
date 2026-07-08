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
        enviarAviso: c.EnviarAviso || c.enviarAviso || 'Sim',
        obs: c.Obs || c.obs || '',
        diasRestantes,
        vencido: diasRestantes !== null && diasRestantes < 0,
        venceEmBreve: diasRestantes !== null && diasRestantes >= 0 && diasRestantes <= 30,
        _pending: !!c._pending
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
    const [day, month, year] = value.split('/');
    if (!day || !month || !year) {
        return value;
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
    const formatted = formatDateFieldValue(value);
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
    if (!value || typeof value !== 'string' || !value.includes('/')) {
        return 0;
    }
    const [day, month, year] = value.split('/').map(Number);
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
