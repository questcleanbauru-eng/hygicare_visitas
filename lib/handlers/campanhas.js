import {
    getSheetObjects, getSheetWithHeaders, getHeaders, appendRow, updateRow, deleteRow, deleteRows,
    sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { verifyUser, formatDate, formatDateFromInput, resolveCreateId } from '../common.js';
import { logAudit } from '../audit.js';
import { handleUpdateProposal, normalizeProposalRow } from './proposals.js';
import { handleUpdateFunil, normalizeFunilRow } from './funil.js';
import { handleCreateVisit } from './visits.js';
import { sendPushToVendedor } from './push.js';
import { createAgendamentoInterno, readAgendamentoRows, closeAgendamentosByCampanha, updateAgendamentosDataByCampanha } from './agendamentos.js';
import { sendEmail } from '../email.js';
import { resolveAdminsAtivos } from './lembreteClientes.js';

// Campanha de atualização: o admin/gerente monta uma lista de Propostas OU
// de Funil, gera um link e manda pro vendedor. O vendedor abre (login normal
// do app), vê cada cliente com o status/comentário atual e um campo pra
// descrever a situação — cada "salvar" grava direto na Proposta/Funil de
// verdade (reaproveitando handleUpdateProposal/handleUpdateFunil, que já
// validam o dono) e marca o item como respondido.

const SHEET = 'Campanhas';
const HEADERS = [
    'Id', 'Titulo', 'Tipo', 'CriadaPor', 'CriadaPorEmail', 'CriadaEm', 'VendedorDestino', 'PrazoAte', 'Status', 'Itens',
    'PrimeiroAcessoEm', 'UltimoAcessoEm', 'EncerradaManualmente'
];

async function ensureSheet() {
    if (!(await sheetExists(SHEET))) {
        await createSheet(SHEET);
        await appendRow(SHEET, HEADERS);
        return;
    }
    await withCache('campanhas_headers_ensured', 600, async () => {
        const headers = await getHeaders(SHEET);
        const missing = HEADERS.filter((h) => !headers.includes(h));
        if (missing.length) await updateRow(SHEET, 1, [...headers, ...missing]);
        return true;
    });
}

function parseItens(value) {
    try { const v = JSON.parse(value || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
}

function rowToCampanha(row) {
    const itens = parseItens(row.Itens);
    return {
        id: String(row.Id || ''),
        titulo: row.Titulo || '',
        tipo: (row.Tipo || 'proposta'),
        criadaPor: row.CriadaPor || '',
        criadaEm: row.CriadaEm || '',
        vendedorDestino: row.VendedorDestino || '',
        prazoAte: row.PrazoAte || '',
        status: row.Status || 'aberta',
        itens,
        total: itens.length,
        respondidos: itens.filter((i) => i.respondidoEm).length,
        primeiroAcessoEm: row.PrimeiroAcessoEm || '',
        ultimoAcessoEm: row.UltimoAcessoEm || '',
        // Diferencia "encerrada na mão pelo admin/gerente" (ainda pode
        // faltar cliente pra atualizar) de "concluída de verdade" (todos
        // os itens respondidos) — os dois usam status:'concluida' (mesmo
        // efeito de bloquear o link pro vendedor), só a etiqueta exibida
        // no Admin muda.
        encerradaManualmente: String(row.EncerradaManualmente || '').trim().toLowerCase() === 'sim'
    };
}

function isAdminOrGerente(user) {
    const p = String(user.profile || '').trim().toLowerCase();
    return p === 'admin' || p === 'gerente';
}

const TIPO_LABEL = {
    proposta: 'atualizar', funil: 'atualizar', visita: 'completar um relatório de visita',
    manutencao: 'completar um relatório de aferição', relatoriotecnico: 'completar um relatório SPSP'
};

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Junta cliente + status final de cada item — sem cache (roda uma vez só,
// no instante em que a campanha inteira acaba de ser concluída, então quer
// o dado que acabou de ser gravado, não uma cópia de até 60s atrás).
async function buildCampanhaResumoItens(campanha) {
    if (campanha.tipo === 'visita' || campanha.tipo === 'manutencao' || campanha.tipo === 'relatoriotecnico') {
        return campanha.itens.map((it) => ({ cliente: it.cliente || '(sem nome)', status: '', comentario: it.relatorio || '' }));
    }
    const dataRows = campanha.tipo === 'funil' ? await getSheetObjects('Funil') : await getSheetObjects('Propostas');
    const byId = new Map(dataRows.map((r) => [String(r.Id || r.ID || ''), r]));
    return campanha.itens.map((it) => {
        const raw = byId.get(String(it.id));
        if (!raw) return { cliente: '(registro removido)', status: '', comentario: '' };
        if (campanha.tipo === 'funil') {
            const f = normalizeFunilRow(raw);
            return { cliente: f.cliente, status: f.status, comentario: f.comentarios || '' };
        }
        const p = normalizeProposalRow(raw);
        return { cliente: p.Cliente, status: p.Status, comentario: p['Atualizar/OBS'] || '' };
    });
}

function buildCampanhaConcluidaEmailHtml(campanha, itens, vendedorNome) {
    const linhas = itens.map((it) => `
        <tr><td style="padding:10px 0;border-bottom:1px solid #e2e8f0">
            <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a">${esc(it.cliente || '-')}${it.status ? ` <span style="font-weight:400;color:#1d4ed8">— ${esc(it.status)}</span>` : ''}</p>
            ${it.comentario ? `<p style="margin:4px 0 0;font-size:13px;color:#64748b">${esc(it.comentario)}</p>` : ''}
        </td></tr>`).join('');
    const appUrl = process.env.APP_URL || 'https://hygicare-visitas.vercel.app';
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
        <tr><td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;max-width:560px">
                <tr><td style="background:#1e3a8a;padding:20px 24px">
                    <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.08em;color:#c7d2fe;text-transform:uppercase">Hygicare</p>
                    <p style="margin:2px 0 0;font-size:19px;font-weight:700;color:#ffffff">${esc(vendedorNome)} concluiu "${esc(campanha.titulo)}"</p>
                </td></tr>
                <tr><td style="padding:18px 24px 4px">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.04em;color:#64748b;text-transform:uppercase">${itens.length} cliente${itens.length > 1 ? 's' : ''} atualizado${itens.length > 1 ? 's' : ''}</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${linhas}</table>
                </td></tr>
                <tr><td style="padding:20px 24px 24px">
                    <a href="${esc(appUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:10px 20px;border-radius:999px">Abrir o app →</a>
                </td></tr>
            </table>
        </td></tr>
    </table>`;
}

// ── Criar ───────────────────────────────────────────────────────────────
export async function handleCriarCampanha(payload) {
    const user = await verifyUser(payload.user);
    if (!isAdminOrGerente(user)) throw new Error('Só admin ou gerente pode criar campanhas.');

    const tipo = String(payload.tipo || '').trim().toLowerCase();
    if (!['proposta', 'funil', 'visita', 'manutencao', 'relatoriotecnico'].includes(tipo)) throw new Error('Tipo inválido (proposta, funil, visita, manutencao ou relatoriotecnico).');

    // "visita"/"manutencao"/"relatoriotecnico" não referenciam registro
    // existente (o vendedor é quem vai criar o registro de verdade ao
    // responder) — o item carrega os dados do rascunho (cliente, cidade...)
    // direto no Itens, em vez de só um Id.
    let itens;
    if (tipo === 'visita') {
        const drafts = Array.isArray(payload.itensVisita) ? payload.itensVisita : [];
        if (!drafts.length) throw new Error('Preencha ao menos um relatório.');
        itens = drafts.map((d, i) => ({
            id: 'd' + Date.now() + '_' + i,
            cliente: String(d.cliente || '').trim(),
            cidade: String(d.cidade || '').trim(),
            areaAtuacao: String(d.areaAtuacao || '').trim(),
            tipoVisita: String(d.tipoVisita || '').trim(),
            data: String(d.data || '').trim(),
            relatorio: String(d.relatorio || '').trim(),
            respondidoEm: '', respondidoPor: '', visitaId: ''
        }));
        if (itens.some((d) => !d.cliente)) throw new Error('Informe o cliente em cada relatório.');
    } else if (tipo === 'manutencao') {
        const drafts = Array.isArray(payload.itensManutencao) ? payload.itensManutencao : [];
        if (!drafts.length) throw new Error('Preencha ao menos um relatório.');
        itens = drafts.map((d, i) => ({
            id: 'd' + Date.now() + '_' + i,
            cliente: String(d.cliente || '').trim(),
            cidade: String(d.cidade || '').trim(),
            relatorio: String(d.relatorio || '').trim(),
            // 'geral' ou '' (Aferição) — mesma variante de manutencao.js,
            // pra abrir o formulário certo quando o vendedor for preencher
            // (ver RELATORIO_PREENCHER_CONFIG/wireCard, campanhas.js).
            tipoRelatorio: String(d.tipoRelatorio || '').trim(),
            respondidoEm: '', respondidoPor: ''
        }));
        if (itens.some((d) => !d.cliente)) throw new Error('Informe o cliente em cada relatório.');
    } else if (tipo === 'relatoriotecnico') {
        const drafts = Array.isArray(payload.itensRelatorioTecnico) ? payload.itensRelatorioTecnico : [];
        if (!drafts.length) throw new Error('Preencha ao menos um relatório.');
        itens = drafts.map((d, i) => ({
            id: 'd' + Date.now() + '_' + i,
            cliente: String(d.cliente || '').trim(),
            cidade: String(d.cidade || '').trim(),
            relatorio: String(d.relatorio || '').trim(),
            // 'paulo' ou '' (SPSP padrão) — mesma variante de
            // relatorioTecnico.js (ver RELATORIO_PREENCHER_CONFIG/wireCard).
            tipoRelatorio: String(d.tipoRelatorio || '').trim(),
            respondidoEm: '', respondidoPor: ''
        }));
        if (itens.some((d) => !d.cliente)) throw new Error('Informe o cliente em cada relatório.');
    } else {
        const ids = Array.from(new Set((payload.itemIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
        if (!ids.length) throw new Error('Selecione ao menos um cliente.');
        itens = ids.map((itemId) => ({ id: itemId, respondidoEm: '', respondidoPor: '' }));
    }
    const vendedor = String(payload.vendedorDestino || '').trim();
    if (!vendedor) throw new Error('Escolha o vendedor que vai preencher.');

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const id = String(resolveCreateId(payload));
    const now = new Date();
    const fields = {
        Id: id,
        Titulo: String(payload.titulo || '').trim() || `${tipo === 'visita' ? 'Relatório de visita' : 'Atualização'} ${formatDate(now)}`,
        Tipo: tipo,
        CriadaPor: user.name,
        CriadaPorEmail: user.email,
        CriadaEm: formatDate(now),
        VendedorDestino: vendedor,
        PrazoAte: payload.prazoAte ? String(payload.prazoAte) : '',
        Status: 'aberta',
        Itens: JSON.stringify(itens)
    };
    await appendRow(SHEET, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'criou', 'campanha', id, fields.Titulo);

    await sendPushToVendedor(vendedor, {
        title: '🔔 ' + user.name.split(' ')[0] + ' pediu uma atualização',
        body: `${itens.length} cliente${itens.length > 1 ? 's' : ''} pra você ${TIPO_LABEL[tipo] || 'atualizar'}.`,
        page: 'campanha-preencher', params: { id }, tag: 'campanha-' + id
    });

    // Prazo definido → gera um agendamento pro vendedor de destino, pra
    // aparecer na Agenda dele e entrar automaticamente no lembrete de "1
    // semana antes" (ver lembretesAgendamento.js). Best-effort: campanha
    // já foi criada e não pode falhar por causa disso.
    if (fields.PrazoAte) {
        await createAgendamentoInterno({
            vendedor,
            cliente: fields.Titulo,
            dataAgendadaFormatada: fields.PrazoAte,
            observacao: `Prazo da campanha — ${itens.length} cliente${itens.length > 1 ? 's' : ''} pra ${TIPO_LABEL[tipo] || 'atualizar'}.`,
            campanhaOrigemId: id
        });
    }

    return { status: 'success', campanha: rowToCampanha(fields), id };
}

// ── Ler uma campanha (pro vendedor preencher) ───────────────────────────
export async function handleGetCampanha(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();
    await ensureSheet();
    const headers = await getHeaders(SHEET);
    // Mesma chave de cache que readCampanhaRows usa (bem abaixo) — a
    // campanha de atualização é aberta 2x por visita (ver campanhas.js no
    // frontend), então sem isso cada abertura já custava 2 leituras cheias
    // da aba só pra achar 1 linha.
    const rows = await withCache('campanhas_all', 60, () => getSheetObjects(SHEET));
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Campanha não encontrada.');
    const row = rows[rowIndex];
    const campanha = rowToCampanha(row);

    const nome = String(user.name || '').trim().toLowerCase();
    const isDono = nome === String(campanha.vendedorDestino || '').trim().toLowerCase();
    const podeVer = isAdminOrGerente(user) || isDono;
    if (!podeVer) throw new Error('Esta campanha foi enviada para outro vendedor.');
    // Encerrada (manualmente pelo admin/gerente, ou automaticamente quando
    // todos os itens já foram respondidos) — o vendedor não acessa mais o
    // link; admin/gerente ainda pode abrir pra conferir.
    if (campanha.status === 'concluida' && !isAdminOrGerente(user)) {
        throw new Error('Esta campanha foi encerrada.');
    }

    // Registra o acesso — só quando é o vendedor de verdade (o
    // vendedorDestino) abrindo, não quando outro admin/gerente entra só pra
    // conferir. isDono já garante isso (bate o nome de quem abriu com o
    // destinatário) mesmo se esse vendedor também for admin/gerente — antes
    // isso ficava travado por engano quando a campanha era endereçada a um
    // admin/gerente, e o "acessou em" nunca era gravado pra esses casos.
    if (isDono) {
        const now = formatDate(new Date()) + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const primeiroKey = Object.keys(row).find((k) => k.toLowerCase() === 'primeiroacessoem') || 'PrimeiroAcessoEm';
        const ultimoKey = Object.keys(row).find((k) => k.toLowerCase() === 'ultimoacessoem') || 'UltimoAcessoEm';
        row[ultimoKey] = now;
        if (!row[primeiroKey]) row[primeiroKey] = now;
        try {
            await updateRow(SHEET, rowIndex + 2, headers.map((h) => (row[h] !== undefined ? row[h] : '')));
            clearCacheByPrefix(['campanhas_']);
        } catch (e) { /* não bloqueia o vendedor por causa disso */ }
        campanha.primeiroAcessoEm = row[primeiroKey];
        campanha.ultimoAcessoEm = row[ultimoKey];
    }

    // "visita"/"manutencao"/"relatoriotecnico" não referenciam registro
    // existente — o rascunho já carrega os dados de exibição direto no item
    // (ver handleCriarCampanha).
    if (campanha.tipo === 'visita' || campanha.tipo === 'manutencao' || campanha.tipo === 'relatoriotecnico') {
        const itensDraft = campanha.itens.map((it) => ({ ...it, tipo: campanha.tipo }));
        return { status: 'success', campanha: { ...campanha, itens: undefined }, itens: itensDraft };
    }

    // Junta os dados atuais de cada item. Cache compartilhado com
    // proposals.js (mesma chave/formato) pro caso de Propostas; Funil não
    // tinha uma chave "getSheetObjects puro" existente pra reaproveitar
    // (funil_sheet_raw usa getSheetWithHeaders, formato diferente), então
    // ganhou uma própria.
    const dataRows = campanha.tipo === 'funil'
        ? await withCache('funil_sheet_objects_raw', 60, () => getSheetObjects('Funil'))
        : await withCache('propostas_sheet_raw', 60, () => getSheetObjects('Propostas'));
    const byId = new Map(dataRows.map((r) => [String(r.Id || r.ID || ''), r]));

    const itens = campanha.itens.map((it) => {
        const raw = byId.get(String(it.id));
        if (!raw) return { id: it.id, respondidoEm: it.respondidoEm, respondidoPor: it.respondidoPor, ausente: true };
        if (campanha.tipo === 'funil') {
            const f = normalizeFunilRow(raw);
            return {
                id: it.id, tipo: 'funil', respondidoEm: it.respondidoEm, respondidoPor: it.respondidoPor,
                cliente: f.cliente, cidade: f.cidade, foco: f.foco, atuacao: f.atuacao, aplicacao: f.aplicacao,
                valor: f.vlMensal, vendedor: f.vendedor, status: f.status, atualizacao: f.atualizacao || f.data,
                comentarios: f.comentarios, motivoPerda: f.motivoPerda, funilDiversey: f.funilDiversey === 'Sim'
            };
        }
        const p = normalizeProposalRow(raw);
        return {
            id: it.id, tipo: 'proposta', respondidoEm: it.respondidoEm, respondidoPor: it.respondidoPor,
            cliente: p.Cliente, cidade: p.Cidade, foco: p.Foco, produtos: p.Produtos,
            vendedor: p.Vendedor, status: p.Status, atualizacao: p['Atualização'],
            comentarios: p['Atualizar/OBS'],
            resumo: p.Resumo || ''
        };
    });

    return { status: 'success', campanha: { ...campanha, itens: undefined }, itens };
}

// ── Responder um item ──────────────────────────────────────────────────
export async function handleResponderCampanhaItem(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.campanhaId || '').trim();
    const itemId = String(payload.itemId || '').trim();

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Campanha não encontrada.');
    const current = rows[rowIndex];
    const campanha = rowToCampanha(current);

    const nome = String(user.name || '').trim().toLowerCase();
    const podeResponder = isAdminOrGerente(user) || nome === String(campanha.vendedorDestino || '').trim().toLowerCase();
    if (!podeResponder) throw new Error('Esta campanha foi enviada para outro vendedor.');
    if (campanha.status === 'concluida' && !isAdminOrGerente(user)) {
        throw new Error('Esta campanha foi encerrada.');
    }

    const itens = campanha.itens;
    const it = itens.find((x) => String(x.id) === itemId);
    if (!it) throw new Error('Item não faz parte desta campanha.');

    // "visita" não tem registro pra atualizar — o vendedor está CRIANDO a
    // Visita agora, com os dados do rascunho como ponto de partida (todos
    // editáveis: payload manda o valor final de cada campo).
    if (campanha.tipo === 'visita') {
        const createRes = await handleCreateVisit({
            dataVisita: payload.dataVisita || it.data,
            horario: payload.horario,
            cliente: payload.cliente || it.cliente,
            cidade: payload.cidade || it.cidade,
            areaAtuacao: payload.areaAtuacao || it.areaAtuacao,
            tipoVisita: payload.tipoVisita || it.tipoVisita,
            potencialCliente: payload.potencialCliente || '',
            contato: payload.contato || '',
            veiculo: payload.veiculo || '',
            observacao: payload.comentario,
            user: payload.user
        });
        const createdVisit = createRes && (createRes.visit || (createRes.visits && createRes.visits[0]));
        it.visitaId = createdVisit ? String(createdVisit.ID || createdVisit.id || '') : '';
    } else if (campanha.tipo === 'manutencao') {
        // "manutencao" também não tem registro pra atualizar — mas o
        // formulário de Manutenção é complexo demais (itens, fotos,
        // assinaturas) pra recriar aqui. O vendedor é levado pro formulário
        // real já preenchido (ver manutencao.js) e SÓ DEPOIS de salvar por lá
        // esta chamada acontece, só pra confirmar a resposta e guardar o Id
        // criado por referência.
        it.manutencaoId = payload.manutencaoId || '';
    } else if (campanha.tipo === 'relatoriotecnico') {
        // Mesmo caso de "manutencao" acima: formulário complexo demais (várias
        // seções de checklist) pra recriar aqui — só confirma a resposta
        // depois que o vendedor salvou de verdade em relatorioTecnico.js.
        it.relatorioTecnicoId = payload.relatorioTecnicoId || '';
    } else if (campanha.tipo === 'funil') {
        // Grava na Proposta/Funil real — reaproveita o handler existente, que
        // já valida se o vendedor é dono da linha.
        await handleUpdateFunil({
            id: itemId, status: payload.status, comentarios: payload.comentario,
            motivoPerda: payload.motivoPerda, user: payload.user
        });
    } else {
        await handleUpdateProposal({
            id: itemId, status: payload.status, obs: payload.comentario, user: payload.user
        });
    }

    it.respondidoEm = formatDate(new Date());
    it.respondidoPor = user.name;
    const todosOk = itens.every((x) => x.respondidoEm);
    const itensKey = Object.keys(current).find((k) => k.toLowerCase() === 'itens') || 'Itens';
    const statusKey = Object.keys(current).find((k) => k.toLowerCase() === 'status') || 'Status';
    current[itensKey] = JSON.stringify(itens);
    if (todosOk) current[statusKey] = 'concluida';

    await updateRow(SHEET, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'respondeu', 'campanha', id, itemId);

    // Avisa por e-mail quem criou a campanha E todo admin ativo assim que
    // ela é concluída de verdade (todo item respondido) — não a cada item,
    // senão viraria spam numa campanha com vários clientes. Admin entra
    // sempre (pedido explícito: visibilidade mesmo quando quem criou foi um
    // gerente), deduplicado contra quem criou pra não mandar 2x pra mesma
    // pessoa. Best-effort: um problema no e-mail não pode fazer a resposta
    // do vendedor "falhar" pra ele.
    if (todosOk) {
        try {
            const admins = await resolveAdminsAtivos();
            const destinatarios = new Set();
            if (current.CriadaPorEmail) destinatarios.add(String(current.CriadaPorEmail).trim().toLowerCase());
            admins.forEach((a) => { if (a.EmailLogin) destinatarios.add(String(a.EmailLogin).trim().toLowerCase()); });
            if (destinatarios.size) {
                const resumoItens = await buildCampanhaResumoItens(campanha);
                const html = buildCampanhaConcluidaEmailHtml(campanha, resumoItens, user.name);
                await sendEmail({ to: Array.from(destinatarios).join(','), subject: `✅ ${user.name} concluiu "${campanha.titulo}"`, html });
            }
        } catch (e) { /* nunca derruba o fluxo principal */ }
    }

    return { status: 'success', respondidos: itens.filter((x) => x.respondidoEm).length, total: itens.length, concluida: todosOk };
}

// Corrige a data de resposta de um item já respondido — pedido do admin pra
// quando o vendedor atualizou em campo num dia e só sincronizou/salvou
// depois (respondidoEm fica com a data do salvamento, não da visita real).
// Só admin/gerente, e só em item que já tem resposta (não é um jeito de
// marcar como respondido sem responder).
export async function handleUpdateCampanhaItemRespondidoEm(payload) {
    const user = await verifyUser(payload.user);
    if (!isAdminOrGerente(user)) throw new Error('Só admin ou gerente pode editar a data de resposta.');
    const id = String(payload.campanhaId || '').trim();
    const itemId = String(payload.itemId || '').trim();
    const novaData = formatDateFromInput(payload.data);
    if (!novaData) throw new Error('Informe a nova data.');

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Campanha não encontrada.');
    const current = rows[rowIndex];
    const campanha = rowToCampanha(current);

    const it = campanha.itens.find((x) => String(x.id) === itemId);
    if (!it) throw new Error('Item não faz parte desta campanha.');
    if (!it.respondidoEm) throw new Error('Este cliente ainda não foi respondido.');
    it.respondidoEm = novaData;

    const itensKey = Object.keys(current).find((k) => k.toLowerCase() === 'itens') || 'Itens';
    current[itensKey] = JSON.stringify(campanha.itens);
    await updateRow(SHEET, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'editou data de resposta', 'campanha', id, itemId);

    return { status: 'success', respondidoEm: novaData };
}

// Lê as campanhas já escopadas (gerente só as que ele criou, admin todas)
// — reaproveitado pelo handler de listagem e pelo painel do Dashboard.
export async function readCampanhaRows(user) {
    await ensureSheet();
    let rows = await withCache('campanhas_all', 60, () => getSheetObjects(SHEET));
    if (String(user.profile || '').trim().toLowerCase() === 'gerente') {
        const e = String(user.email || '').trim().toLowerCase();
        rows = rows.filter((r) => String(r.CriadaPorEmail || '').trim().toLowerCase() === e);
    }
    return rows.map(rowToCampanha).sort((a, b) => Number(b.id) - Number(a.id));
}

// Usado por Manutencao/RelatorioTecnico antes de apagar um registro: um
// item de campanha de manutencao/relatoriotecnico só ganha manutencaoId/
// relatorioTecnicoId quando o vendedor responde (ver handleResponderCampanhaItem
// acima) — nesse momento o item já vira "respondido", mas a campanha inteira
// pode continuar aberta (outros itens ainda pendentes). Apagar o registro
// sem avisar deixaria esse item apontando pra um Id que não existe mais.
export async function findCampanhaAbertaVinculada(user, tipo, linkField, id) {
    const campanhas = await readCampanhaRows(user);
    return campanhas.find((c) => c.tipo === tipo && c.status !== 'concluida'
        && c.itens.some((it) => String(it[linkField] || '') === String(id))) || null;
}

// ── Lista pro admin acompanhar ─────────────────────────────────────────
export async function handleGetCampanhas(payload) {
    const user = await verifyUser(payload.user);
    if (!isAdminOrGerente(user)) throw new Error('Acesso restrito.');
    const campanhas = await readCampanhaRows(user);
    return { status: 'success', campanhas };
}

// Encerra a campanha na mão (independente de quantos itens já foram
// respondidos) — o vendedor perde acesso ao link (ver handleGetCampanha/
// handleResponderCampanhaItem) e o agendamento gerado pelo prazo (se
// houver) sai da Agenda junto.
export async function handleEncerrarCampanha(payload) {
    const user = await verifyUser(payload.user);
    if (!isAdminOrGerente(user)) throw new Error('Só admin ou gerente pode encerrar campanhas.');
    const id = String(payload.id || '').trim();

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Campanha não encontrada.');
    const current = rows[rowIndex];
    const statusKey = Object.keys(current).find((k) => k.toLowerCase() === 'status') || 'Status';
    const tituloKey = Object.keys(current).find((k) => k.toLowerCase() === 'titulo') || 'Titulo';
    const encerradaKey = Object.keys(current).find((k) => k.toLowerCase() === 'encerradamanualmente') || 'EncerradaManualmente';
    current[statusKey] = 'concluida';
    current[encerradaKey] = 'Sim';

    await updateRow(SHEET, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'encerrou', 'campanha', id, current[tituloKey] || '');
    await closeAgendamentosByCampanha(id, 'Concluido');

    return { status: 'success', message: 'Campanha encerrada.' };
}

// Prorroga (ou antecipa) o prazo de uma campanha já criada, sem precisar
// apagar e gerar outra — pedido do admin pra campanha vencida que só
// precisa de mais tempo, não de recomeçar do zero. Move junto a data do
// agendamento gerado pelo prazo original (se houver), senão a Agenda
// continuaria mostrando o compromisso na data antiga/vencida.
export async function handleUpdateCampanhaPrazo(payload) {
    const user = await verifyUser(payload.user);
    if (!isAdminOrGerente(user)) throw new Error('Só admin ou gerente pode alterar o prazo.');
    const id = String(payload.id || '').trim();
    const novoPrazo = formatDateFromInput(payload.prazoAte);
    if (!novoPrazo) throw new Error('Informe o novo prazo.');

    await ensureSheet();
    const headers = await getHeaders(SHEET);
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Campanha não encontrada.');
    const current = rows[rowIndex];
    const campanha = rowToCampanha(current);
    if (campanha.status === 'concluida') throw new Error('Essa campanha já foi encerrada/concluída.');

    const prazoKey = Object.keys(current).find((k) => k.toLowerCase() === 'prazoate') || 'PrazoAte';
    current[prazoKey] = novoPrazo;

    await updateRow(SHEET, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'alterou prazo', 'campanha', id, novoPrazo);
    await updateAgendamentosDataByCampanha(id, novoPrazo);

    return { status: 'success', prazoAte: novoPrazo };
}

// Backfill — cobre campanhas com prazo criadas ANTES do agendamento
// automático existir (ver commit que adicionou createAgendamentoInterno
// em handleCriarCampanha). Idempotente: pula qualquer campanha que já
// tenha um agendamento com esse CampanhaOrigemId, então rodar de novo não
// duplica nada.
export async function handleBackfillAgendamentosCampanha(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') {
        throw new Error('Só administradores podem rodar esse backfill.');
    }
    const SYSTEM_USER = { profile: 'admin', name: '', email: '', gerencia: '' };
    const [campanhas, agendamentos] = await Promise.all([
        readCampanhaRows(SYSTEM_USER),
        readAgendamentoRows(SYSTEM_USER)
    ]);
    const jaCobertas = new Set(agendamentos.map((a) => a.campanhaOrigemId).filter(Boolean));

    const elegiveis = campanhas.filter((c) => c.status !== 'concluida' && c.prazoAte && !jaCobertas.has(c.id));

    let criadas = 0;
    for (const c of elegiveis) {
        const r = await createAgendamentoInterno({
            vendedor: c.vendedorDestino,
            cliente: c.titulo,
            dataAgendadaFormatada: c.prazoAte,
            observacao: `Prazo da campanha — ${c.total} cliente${c.total > 1 ? 's' : ''} pra ${TIPO_LABEL[c.tipo] || 'atualizar'}.`,
            campanhaOrigemId: c.id
        });
        if (r) criadas++;
    }

    return {
        status: 'success',
        encontradas: campanhas.filter((c) => c.status !== 'concluida' && c.prazoAte).length,
        jaExistiam: jaCobertas.size,
        criadas,
        message: `${criadas} agendamento(s) criado(s) a partir de campanhas já abertas com prazo.`
    };
}

export async function handleDeleteCampanha(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') throw new Error('Só admin pode apagar campanhas.');
    const id = String(payload.id || '').trim();
    await ensureSheet();
    const rows = await getSheetObjects(SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Campanha não encontrada.');
    await deleteRow(SHEET, rowIndex + 2);
    clearCacheByPrefix(['campanhas_']);
    await logAudit(user, 'apagou', 'campanha', id, rows[rowIndex].Titulo || '');
    return { status: 'success', message: 'Campanha apagada.' };
}

// Apaga várias de uma vez. Lê a aba uma vez, resolve todas as linhas e manda
// um único batchUpdate — apagar uma por uma em paralelo embaralharia os
// índices (cada delete desloca as linhas de baixo), e em série gastaria 3
// chamadas por registro.
export async function handleDeleteCampanhaBatch(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') throw new Error('Só admin pode apagar campanhas.');
    const ids = new Set((payload.ids || []).map((x) => String(x || '').trim()).filter(Boolean));
    if (!ids.size) throw new Error('Nenhuma campanha selecionada.');
    if (ids.size > 200) throw new Error('Selecione no máximo 200 campanhas por vez.');

    await ensureSheet();
    const rows = await getSheetObjects(SHEET);
    const targets = [];
    rows.forEach((r, i) => {
        const id = String(r.Id || '');
        if (!ids.has(id)) return;
        targets.push({ id, rowNumber: i + 2, titulo: r.Titulo || '' });
    });
    if (!targets.length) throw new Error('Nenhuma das campanhas foi encontrada (já apagadas?).');

    await deleteRows(SHEET, targets.map((t) => t.rowNumber));
    clearCacheByPrefix(['campanhas_']);
    for (const t of targets) await logAudit(user, 'apagou', 'campanha', t.id, t.titulo);
    return { status: 'success', deleted: targets.map((t) => t.id), message: `${targets.length} campanha(s) apagada(s).` };
}
