import { getSheetObjects, getHeaders, appendRow, updateRow, deleteRow, sheetExists, createSheet, withCache, clearCacheByPrefix } from '../sheets.js';
import { verifyUser, ensureAdmin, formatDate, formatDateFromInput, parseDate, resolveCreateId, ensureTextLength } from '../common.js';
import { logAudit } from '../audit.js';

// "Lembretes administrativos" — pedido explícito: Bruno queria usar o robô
// de WhatsApp como agenda/lembrete pra cobrar o time administrativo (ex.:
// "comprar tal coisa todo mês", "mandar nota fiscal") sem misturar isso com
// Agendamentos (que é especificamente retorno de visita a cliente e entra
// nos relatórios/contagens de vendedor). Sheet própria, só admin cria, mas
// quem está em "Destinatarios" vê e pode concluir/cancelar o que é dele.
const SHEET_NAME = 'LembretesAdministrativos';
const HEADERS = [
    'Id', 'Texto', 'Destinatarios', 'CriadoPorEmail', 'CriadoPorNome', 'CriadoEm', 'DataAlvo',
    'Recorrencia', 'RecorrenciaConfig', 'TerminoTipo', 'TerminoData', 'TerminoOcorrencias', 'OcorrenciaNumero',
    'Status', 'AtualizadoEm'
];

let _ensured = false;
async function ensureSheet() {
    if (_ensured) return;
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) {
        await createSheet(SHEET_NAME);
        await appendRow(SHEET_NAME, HEADERS);
        _ensured = true;
        return;
    }
    // Sheet já existia de antes da recorrência ganhar as colunas novas
    // (RecorrenciaConfig/TerminoTipo/...) — garante que elas existem sem
    // tocar nas linhas já gravadas, mesmo padrão usado em contratos.js pra
    // "Pausado". Sem isso, handleCreate/UpdateLembreteAdmin escreveriam
    // esses campos num header inexistente e eles simplesmente sumiriam.
    await withCache('lembretes_admin_headers_ensured', 600, async () => {
        const headers = await getHeaders(SHEET_NAME);
        const missing = HEADERS.filter((h) => !headers.includes(h));
        if (missing.length) await updateRow(SHEET_NAME, 1, [...headers, ...missing]);
        return true;
    });
    _ensured = true;
}

function rowToObject(row) {
    let recorrenciaConfig = {};
    try { recorrenciaConfig = JSON.parse(row.RecorrenciaConfig || '{}') || {}; } catch (e) { recorrenciaConfig = {}; }
    return {
        id: String(row.Id || ''),
        texto: row.Texto || '',
        destinatarios: String(row.Destinatarios || '').split(',').map((s) => s.trim()).filter(Boolean),
        criadoPorEmail: row.CriadoPorEmail || '',
        criadoPorNome: row.CriadoPorNome || '',
        criadoEm: row.CriadoEm || '',
        dataAlvo: row.DataAlvo || '',
        // Linha antiga sem Recorrencia preenchida = 'nenhuma'; 'mensal' de
        // antes da expansão continua válido como um dos tipos novos.
        recorrencia: row.Recorrencia || 'nenhuma',
        recorrenciaConfig,
        terminoTipo: row.TerminoTipo || 'nunca',
        terminoData: row.TerminoData || '',
        terminoOcorrencias: Number(row.TerminoOcorrencias) || 0,
        ocorrenciaNumero: Number(row.OcorrenciaNumero) || 1,
        status: row.Status || 'Pendente',
        atualizadoEm: row.AtualizadoEm || ''
    };
}

// Admin vê tudo; os outros só veem os lembretes onde aparecem como
// destinatário (pra poder concluir/cancelar o que é deles) — nunca a lista
// inteira do time.
export async function readLembretesAdminRows(user) {
    await ensureSheet();
    const rows = await withCache('lembretes_admin_sheet_raw', 60, () => getSheetObjects(SHEET_NAME));
    const parsed = rows.map(rowToObject);
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin') return parsed;
    const userName = String(user.name || '').trim().toLowerCase();
    return parsed.filter((r) => r.destinatarios.some((d) => d.trim().toLowerCase() === userName));
}

export async function handleGetLembretesAdmin(payload) {
    const user = await verifyUser(payload.user);
    const lembretes = await readLembretesAdminRows(user);
    return { status: 'success', lembretes };
}

// ── Recorrência: validação + cálculo da próxima data ──────────────────────
const RECORRENCIAS_VALIDAS = ['nenhuma', 'diaria', 'semanal', 'mensal', 'anual', 'personalizada'];
const TERMINO_TIPOS_VALIDOS = ['nunca', 'data', 'ocorrencias'];
const AJUSTES_FDS_VALIDOS = ['manter', 'adiar', 'antecipar'];

// Normaliza recorrência + config vindos do front, validando só o que cada
// tipo precisa (ex.: "semanal" sem nenhum dia marcado é erro; "mensal" não
// tem config nenhuma — usa o dia da própria Data alvo).
function normalizarRecorrencia(payload) {
    const recorrencia = RECORRENCIAS_VALIDAS.includes(payload.recorrencia) ? payload.recorrencia : 'nenhuma';
    const configIn = (payload.recorrenciaConfig && typeof payload.recorrenciaConfig === 'object') ? payload.recorrenciaConfig : {};
    const config = {};
    if (recorrencia === 'diaria') {
        config.apenasUteis = !!configIn.apenasUteis;
    } else if (recorrencia === 'semanal') {
        const dias = Array.from(new Set((Array.isArray(configIn.dias) ? configIn.dias : []).map(Number).filter((d) => d >= 0 && d <= 6))).sort();
        if (!dias.length) throw new Error('Escolha pelo menos um dia da semana.');
        config.dias = dias;
    } else if (recorrencia === 'personalizada') {
        const intervalo = Number(configIn.intervalo);
        if (!intervalo || intervalo < 1) throw new Error('Informe a cada quantos dias/semanas/meses repete.');
        config.intervalo = intervalo;
        config.unidade = ['dias', 'semanas', 'meses'].includes(configIn.unidade) ? configIn.unidade : 'dias';
    }
    if (recorrencia !== 'nenhuma' && AJUSTES_FDS_VALIDOS.includes(configIn.ajusteFimDeSemana)) {
        config.ajusteFimDeSemana = configIn.ajusteFimDeSemana;
    }
    return { recorrencia, config };
}

// Término é independente de ter recorrência ou não — um lembrete único
// também pode ter "encerrar sozinho nessa data" (pedido explícito: ex. um
// lembrete pontual que para de cobrar a partir de uma data específica,
// mesmo sem repetir todo mês/semana).
function normalizarTermino(payload, recorrencia) {
    let terminoTipo = TERMINO_TIPOS_VALIDOS.includes(payload.terminoTipo) ? payload.terminoTipo : 'nunca';
    let terminoData = '';
    let terminoOcorrencias = 0;
    if (terminoTipo === 'data') {
        if (!payload.terminoData) throw new Error('Informe até quando.');
        terminoData = formatDateFromInput(payload.terminoData);
    } else if (terminoTipo === 'ocorrencias') {
        // "Depois de X vezes" só faz sentido pra quem repete.
        if (recorrencia === 'nenhuma') {
            terminoTipo = 'nunca';
        } else {
            terminoOcorrencias = Number(payload.terminoOcorrencias);
            if (!terminoOcorrencias || terminoOcorrencias < 1) throw new Error('Informe depois de quantas vezes parar.');
        }
    }
    return { terminoTipo, terminoData, terminoOcorrencias };
}

function ultimoDiaDoMes(ano, mesIndex) {
    return new Date(ano, mesIndex + 1, 0).getDate();
}

// "manter" (padrão) deixa cair no fim de semana mesmo — faz sentido pra
// WhatsApp (dá pra ler/resolver num sábado); "adiar"/"antecipar" existem
// pra quem só quer ser cobrado em dia útil de verdade.
function ajustarFimDeSemana(data, modo) {
    if (!modo || modo === 'manter') return data;
    const dia = data.getDay();
    if (dia !== 0 && dia !== 6) return data;
    const d = new Date(data);
    if (modo === 'adiar') d.setDate(d.getDate() + (dia === 0 ? 1 : 2));
    else if (modo === 'antecipar') d.setDate(d.getDate() - (dia === 0 ? 2 : 1));
    return d;
}

// A partir da data da ocorrência ATUAL (nunca da data em que foi concluído
// — senão, concluir com 5 dias de atraso atrasaria a série inteira),
// calcula quando é a próxima. Trata mês/ano com dia que não existe no mês
// seguinte (ex.: 31/01 -> 28 ou 29/02, não "03/03" que o JS daria de graça).
function calcularProximaData(dataAtual, recorrencia, config) {
    config = config || {};
    let proxima;
    if (recorrencia === 'diaria') {
        proxima = new Date(dataAtual);
        proxima.setDate(proxima.getDate() + 1);
        if (config.apenasUteis) {
            while (proxima.getDay() === 0 || proxima.getDay() === 6) proxima.setDate(proxima.getDate() + 1);
        }
    } else if (recorrencia === 'semanal') {
        const dias = Array.isArray(config.dias) && config.dias.length ? config.dias : [dataAtual.getDay()];
        proxima = new Date(dataAtual);
        for (let i = 0; i < 14; i++) {
            proxima.setDate(proxima.getDate() + 1);
            if (dias.includes(proxima.getDay())) break;
        }
    } else if (recorrencia === 'mensal') {
        const diaAlvo = dataAtual.getDate();
        const mesSeguinte = dataAtual.getMonth() + 1;
        const ano = dataAtual.getFullYear() + Math.floor(mesSeguinte / 12);
        const mes = mesSeguinte % 12;
        proxima = new Date(ano, mes, Math.min(diaAlvo, ultimoDiaDoMes(ano, mes)));
    } else if (recorrencia === 'anual') {
        const ano = dataAtual.getFullYear() + 1;
        // 29/fev num ano não bissexto vira 28/fev, não "01/03".
        const diaMax = ultimoDiaDoMes(ano, dataAtual.getMonth());
        proxima = new Date(ano, dataAtual.getMonth(), Math.min(dataAtual.getDate(), diaMax));
    } else if (recorrencia === 'personalizada') {
        const n = Number(config.intervalo) || 1;
        proxima = new Date(dataAtual);
        if (config.unidade === 'semanas') {
            proxima.setDate(proxima.getDate() + n * 7);
        } else if (config.unidade === 'meses') {
            const mesSeguinte = dataAtual.getMonth() + n;
            const ano = dataAtual.getFullYear() + Math.floor(mesSeguinte / 12);
            const mes = ((mesSeguinte % 12) + 12) % 12;
            proxima = new Date(ano, mes, Math.min(dataAtual.getDate(), ultimoDiaDoMes(ano, mes)));
        } else {
            proxima.setDate(proxima.getDate() + n);
        }
    } else {
        return null;
    }
    return ajustarFimDeSemana(proxima, config.ajusteFimDeSemana);
}

// Respeita Término (data ou nº de ocorrências) antes de gerar a próxima —
// sem isso, uma série com "até 26/11" continuaria gerando mês/semana que
// vem pra sempre.
function podeGerarProxima(current, proximaData) {
    const terminoTipo = current.TerminoTipo || 'nunca';
    if (terminoTipo === 'data') {
        const term = parseDate(current.TerminoData);
        if (term && proximaData > term) return false;
    } else if (terminoTipo === 'ocorrencias') {
        const max = Number(current.TerminoOcorrencias) || 0;
        const atual = Number(current.OcorrenciaNumero) || 1;
        if (max && atual >= max) return false;
    }
    return true;
}

export async function handleCreateLembreteAdmin(payload) {
    const user = await ensureAdmin(payload.user);
    const texto = String(payload.texto || '').trim();
    if (!texto) throw new Error('Informe o lembrete.');
    ensureTextLength(texto, 'Lembrete');
    const destinatarios = (Array.isArray(payload.destinatarios) ? payload.destinatarios : [])
        .map((d) => String(d || '').trim()).filter(Boolean);
    if (!destinatarios.length) throw new Error('Escolha pelo menos um destinatário.');
    if (!payload.dataAlvo) throw new Error('Informe a data.');
    const { recorrencia, config } = normalizarRecorrencia(payload);
    const { terminoTipo, terminoData, terminoOcorrencias } = normalizarTermino(payload, recorrencia);

    await ensureSheet();
    const headers = await getHeaders(SHEET_NAME);
    const id = resolveCreateId(payload);
    if (payload._queueRetry) {
        const dup = (await getSheetObjects(SHEET_NAME)).find((r) => String(r.Id || '') === String(id));
        if (dup) return { status: 'success', lembrete: rowToObject(dup) };
    }

    const now = formatDate(new Date());
    const fields = {
        Id: id, Texto: texto, Destinatarios: destinatarios.join(','),
        CriadoPorEmail: user.email, CriadoPorNome: user.name, CriadoEm: now,
        DataAlvo: formatDateFromInput(payload.dataAlvo),
        Recorrencia: recorrencia, RecorrenciaConfig: JSON.stringify(config),
        TerminoTipo: terminoTipo, TerminoData: terminoData, TerminoOcorrencias: terminoOcorrencias || '',
        OcorrenciaNumero: 1,
        Status: 'Pendente', AtualizadoEm: now
    };
    await appendRow(SHEET_NAME, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    clearCacheByPrefix(['lembretes_admin_']);
    await logAudit(user, 'criou', 'lembrete-admin', id, texto);
    return { status: 'success', lembrete: rowToObject(fields) };
}

async function criarProximaOcorrencia(current, headers) {
    const dataAtual = parseDate(current.DataAlvo);
    if (!dataAtual) return null;
    let config = {};
    try { config = JSON.parse(current.RecorrenciaConfig || '{}') || {}; } catch (e) { config = {}; }
    const proximaData = calcularProximaData(dataAtual, current.Recorrencia, config);
    if (!proximaData) return null;
    if (!podeGerarProxima(current, proximaData)) return null;

    const now = formatDate(new Date());
    const fields = {
        Id: Date.now(), Texto: current.Texto, Destinatarios: current.Destinatarios,
        CriadoPorEmail: current.CriadoPorEmail, CriadoPorNome: current.CriadoPorNome, CriadoEm: now,
        DataAlvo: formatDate(proximaData),
        Recorrencia: current.Recorrencia, RecorrenciaConfig: current.RecorrenciaConfig || '{}',
        TerminoTipo: current.TerminoTipo || 'nunca', TerminoData: current.TerminoData || '', TerminoOcorrencias: current.TerminoOcorrencias || '',
        OcorrenciaNumero: (Number(current.OcorrenciaNumero) || 1) + 1,
        Status: 'Pendente', AtualizadoEm: now
    };
    await appendRow(SHEET_NAME, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    return fields;
}

export async function handleUpdateLembreteAdmin(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    await ensureSheet();
    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Lembrete não encontrado.');
    const current = rows[rowIndex];

    const isAdmin = String(user.profile || '').trim().toLowerCase() === 'admin';
    const destinatarios = String(current.Destinatarios || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const isDestinatario = destinatarios.includes(String(user.name || '').trim().toLowerCase());
    if (!isAdmin && !isDestinatario) throw new Error('Você não tem permissão para mexer nesse lembrete.');

    const novoStatus = payload.status !== undefined ? String(payload.status).trim() : undefined;
    if (novoStatus !== undefined) {
        if (!['Pendente', 'Concluido', 'Cancelado'].includes(novoStatus)) throw new Error('Status inválido.');
        // Quem só é destinatário (não admin) pode concluir/cancelar, nunca
        // reabrir nem editar o conteúdo do lembrete.
        if (!isAdmin && novoStatus === 'Pendente') throw new Error('Você não tem permissão pra reabrir esse lembrete.');
        current.Status = novoStatus;
    }
    if (isAdmin) {
        if (payload.texto !== undefined) {
            const texto = String(payload.texto).trim();
            if (!texto) throw new Error('Informe o lembrete.');
            ensureTextLength(texto, 'Lembrete');
            current.Texto = texto;
        }
        if (payload.destinatarios !== undefined) {
            const list = (Array.isArray(payload.destinatarios) ? payload.destinatarios : [])
                .map((d) => String(d || '').trim()).filter(Boolean);
            if (!list.length) throw new Error('Escolha pelo menos um destinatário.');
            current.Destinatarios = list.join(',');
        }
        if (payload.dataAlvo !== undefined) current.DataAlvo = formatDateFromInput(payload.dataAlvo);
        if (payload.recorrencia !== undefined) {
            const { recorrencia, config } = normalizarRecorrencia(payload);
            current.Recorrencia = recorrencia;
            current.RecorrenciaConfig = JSON.stringify(config);
        }
        if (payload.terminoTipo !== undefined) {
            const { terminoTipo, terminoData, terminoOcorrencias } = normalizarTermino(payload, current.Recorrencia || 'nenhuma');
            current.TerminoTipo = terminoTipo;
            current.TerminoData = terminoData;
            current.TerminoOcorrencias = terminoOcorrencias || '';
        }
    }
    current.AtualizadoEm = formatDate(new Date());

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['lembretes_admin_']);
    await logAudit(
        user,
        novoStatus === 'Concluido' ? 'concluiu' : novoStatus === 'Cancelado' ? 'cancelou' : 'editou',
        'lembrete-admin', id, current.Texto
    );

    // Recorrência: concluir gera sozinho a próxima ocorrência (respeitando
    // Término) — cancelar NÃO gera, é assim que a série para na mão.
    let proximo = null;
    if (novoStatus === 'Concluido' && String(current.Recorrencia || 'nenhuma') !== 'nenhuma') {
        proximo = await criarProximaOcorrencia(current, headers);
    }

    return { status: 'success', lembrete: rowToObject(current), proximo: proximo ? rowToObject(proximo) : null };
}

export async function handleDeleteLembreteAdmin(payload) {
    const user = await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();

    await ensureSheet();
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Lembrete não encontrado.');
    const texto = rows[rowIndex].Texto || '';

    await deleteRow(SHEET_NAME, rowIndex + 2);
    clearCacheByPrefix(['lembretes_admin_']);
    await logAudit(user, 'apagou', 'lembrete-admin', id, texto);
    return { status: 'success', message: 'Lembrete apagado.' };
}

// Chamado periodicamente (ver api/pendencias-whatsapp.js, que já roda a
// cada checagem do robô de WhatsApp) — pedido explícito: "quando chegar a
// data que eu marquei, quero que esse lembrete encerre sozinho", sem
// precisar ninguém clicar em Concluir/Cancelar na mão. Só mexe em quem tem
// TerminoTipo 'data' e já chegou/passou dessa data, ainda Pendente.
export async function autoEncerrarLembretesVencidos() {
    await ensureSheet();
    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    let mudou = false;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (String(r.Status || '') !== 'Pendente') continue;
        if (String(r.TerminoTipo || '') !== 'data') continue;
        const term = parseDate(r.TerminoData);
        if (!term || term > hoje) continue;
        r.Status = 'Encerrado';
        r.AtualizadoEm = formatDate(new Date());
        await updateRow(SHEET_NAME, i + 2, headers.map((h) => (r[h] !== undefined ? r[h] : '')));
        mudou = true;
    }
    if (mudou) clearCacheByPrefix(['lembretes_admin_']);
}
