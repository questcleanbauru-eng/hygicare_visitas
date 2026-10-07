// Robô local de avisos por WhatsApp — roda no seu computador (não na
// Vercel, que não mantém conexão viva o suficiente pra isso). Busca as
// pendências (agendamentos vencidos) de cada vendedor no App de Visitas e
// manda uma mensagem pra cada um que tiver telefone cadastrado.
//
// Horário/dias da semana NÃO ficam fixos aqui — vêm da resposta da API
// (schedule), que por sua vez lê o que foi configurado em Admin >
// Configurações no app. Isso deixa ajustar o agendamento sem mexer neste
// computador. O .env só guarda o que é mesmo "deste computador": URL/chave
// da API, porta do painel e intervalo/ritmo técnico do robô.
//
// Usa um número de WhatsApp separado (não o pessoal) — ver README.md pra
// como configurar. Primeira vez: escaneia o QR code que aparece aqui no
// terminal (Configurações > Aparelhos conectados > Conectar um aparelho).
// Depois de pareado, roda escondido (ver iniciar.bat) — acompanhe tudo
// pelo painel em http://localhost:3344, não precisa mais olhar terminal.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'estado-envio.json');
const AUTH_DIR = join(__dirname, 'auth_info');
const PID_FILE = join(__dirname, 'bot.pid');

const API_URL = process.env.API_URL;
const API_SECRET = process.env.API_SECRET;
// Pro botão "Cadastrar no Admin" do painel abrir o app de verdade — deriva
// da própria API_URL (tira o /api/pendencias-whatsapp do final) em vez de
// precisar de mais uma variável no .env.
const APP_URL = API_URL ? API_URL.replace(/\/api\/.*$/, '/') : '';
// Endpoint do resumo diário (gerente por time + manutenção Open/Close) —
// mesmo domínio/secret de API_URL, só troca o nome do endpoint.
const RESUMO_API_URL = API_URL ? API_URL.replace(/\/api\/.*$/, '/api/resumo-whatsapp') : '';
const INTERVALO_CHECAGEM_MIN = Number(process.env.INTERVALO_CHECAGEM_MIN || 5);
const DELAY_ENTRE_ENVIOS_MS = Number(process.env.DELAY_ENTRE_ENVIOS_MS || 60000);
const PORTA_PAINEL = Number(process.env.PORTA_PAINEL || 3344);
// Opcional: número que recebe um alerta por WhatsApp quando o robô fica com
// erro persistente (ex.: API fora do ar por várias checagens seguidas) —
// não ajuda quando o problema é a PRÓPRIA conexão do WhatsApp cair (não dá
// pra avisar pelo canal que caiu), mas cobre os outros casos, onde a
// conexão continua de pé. Fica de fora do Admin de propósito — é uma
// preferência de QUEM RODA ESSE COMPUTADOR, não do app.
const ALERTA_TELEFONE = process.env.ALERTA_TELEFONE || '';

if (!API_URL || !API_SECRET) {
    console.error('Faltou configurar API_URL/API_SECRET no .env — copie env.example para .env e preencha.');
    process.exit(1);
}

// Pra parar.bat conseguir encerrar o processo certo mesmo rodando
// escondido (sem janela com título pra mirar) — ver iniciar.bat/parar.bat.
try { writeFileSync(PID_FILE, String(process.pid)); } catch { /* não crítico */ }

const logger = pino({ level: 'warn' });

// Status ao vivo pro painel (http://localhost:PORTA_PAINEL) — tela local
// simples com status + botão de parar, pra não precisar ficar lendo o
// terminal (que agora nem abre — ver iniciar.bat). O "iniciar" fica mesmo
// com o iniciar.bat (abre o processo); o painel só reflete o que já está
// rodando e permite encerrar.
const painelStatus = {
    conectado: false,
    aguardandoQr: false,
    qrDataUrl: null,
    // true quando o WhatsApp encerrou a sessão de verdade (ex.: aparelho
    // removido pelo celular, ou erro 401) — nesses casos o robô NÃO tenta
    // reconectar sozinho (reconectar usaria a mesma credencial já inválida
    // pra sempre), e sem isso visível em algum lugar o robô ficava parado
    // pra sempre sem ninguém saber que precisava de um QR novo.
    sessaoEncerrada: false,
    ultimaChecagem: null,
    proximaChecagemPrevista: null,
    intervaloChecagemMin: INTERVALO_CHECAGEM_MIN,
    ultimoEnvio: null,
    ultimoErro: null,
    schedule: null,
    pausadoNoApp: false,
    // Modo aprovação manual (Admin > Configurações) — enquanto true, a
    // checagem automática NUNCA chama enviarCategoriaDoDia sozinha; só
    // atualiza a prévia (igual sempre fez) pro admin mandar à mão pelos
    // botões "Agora" de cada card.
    aprovacaoManual: false,
    enviadoHoje: false,
    // Prévia: quem receberia SE o envio acontecesse agora — atualizado a
    // cada checagem (ou no botão "Verificar agora"), nunca dispara envio
    // de verdade sozinho.
    destinatariosPrevia: [],
    // Quem tem pendência mas não tem WhatsApp cadastrado — não recebe
    // nada, só aparece como aviso pro admin cadastrar o telefone.
    semTelefonePrevia: [],
    historico: [],
    enviosHoje: 0,
    enviosSemana: 0
};

// As 5 categorias de pendência (cada uma com horário próprio — ver
// CATEGORIA_DEFS mais abaixo) — "inatividade" não tem uma lista de itens
// (é um fato só, "há N dias sem visita"), mas entra na mesma mecânica de
// agendamento/envio/dedup que as outras.
const CATEGORIAS_PENDENCIA = ['agendamentos', 'propostas', 'funil', 'campanhas', 'inatividade', 'contratos'];

function estadoVazio() {
    return {
        enviadosHoje: { data: '', categorias: {} },
        resumosEnviadosHoje: { data: '', telefones: [] },
        pausasIndividuais: {},
        ultimoTesteProcessado: 0,
        ultimoAlertaErro: null,
        ultimoAlertaAprovacao: null,
        historico: []
    };
}
function lerEstado() {
    if (!existsSync(STATE_FILE)) return estadoVazio();
    try {
        const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        let migrado = false;
        if (!Array.isArray(parsed.historico)) { parsed.historico = []; migrado = true; }
        // enviadosHoje virou por CATEGORIA (antes era "pendência" como um
        // bloco só, uma mensagem por pessoa) — formato antigo (telefones
        // soltos, sem categorias) é descartado na migração de propósito: o
        // pior caso é reenviar pra quem já tinha recebido no formato
        // antigo, só na primeira checagem após essa atualização.
        if (!parsed.enviadosHoje || typeof parsed.enviadosHoje !== 'object' || typeof parsed.enviadosHoje.categorias !== 'object' || Array.isArray(parsed.enviadosHoje.categorias)) {
            parsed.enviadosHoje = { data: '', categorias: {} };
            migrado = true;
        }
        if (!parsed.resumosEnviadosHoje || typeof parsed.resumosEnviadosHoje !== 'object' || !Array.isArray(parsed.resumosEnviadosHoje.telefones)) {
            parsed.resumosEnviadosHoje = { data: '', telefones: [] };
            migrado = true;
        }
        if (!parsed.pausasIndividuais || typeof parsed.pausasIndividuais !== 'object') { parsed.pausasIndividuais = {}; migrado = true; }
        // Campo novo (antes o controle só vivia em memória, por isso
        // reenviava teste velho — ex.: de admin Kadu — a cada reinício do
        // robô). Na primeira leitura depois dessa atualização, Date.now()
        // (não 0) marca qualquer pedido de teste JÁ EXISTENTE como coisa do
        // passado, pra não disparar de novo um teste antigo só por causa da
        // migração — um pedido de teste de verdade, clicado depois disso,
        // sempre tem "quando" no futuro em relação a esse marco. Grava na
        // hora (migrado=true) pra esse marco ficar fixo — senão, sem nunca
        // salvar, toda leitura recalculava um "agora" novo e podia, por
        // coincidência de milissegundos, deixar passar um teste de verdade.
        if (typeof parsed.ultimoTesteProcessado !== 'number') { parsed.ultimoTesteProcessado = Date.now(); migrado = true; }
        if (parsed.ultimoAlertaErro === undefined) { parsed.ultimoAlertaErro = null; migrado = true; }
        if (parsed.ultimoAlertaAprovacao === undefined) { parsed.ultimoAlertaAprovacao = null; migrado = true; }
        if (migrado) salvarEstado(parsed);
        return parsed;
    } catch { return estadoVazio(); }
}
function salvarEstado(estado) {
    writeFileSync(STATE_FILE, JSON.stringify(estado, null, 2));
}

// Quem já recebeu cada CATEGORIA de pendência hoje — por pessoa E por
// categoria agora (antes era só por pessoa, com tudo numa mensagem só).
// Resumo diário continua com bucket PRÓPRIO (resumosEnviadosHoje) — é uma
// mensagem diferente, a mesma pessoa pode legitimamente receber pendência(s)
// e resumo no mesmo dia sem um bloquear o outro.
function estaEnviadoHoje(estado, categoria, telefone) {
    return estado.enviadosHoje.data === hojeChaveLocal() && (estado.enviadosHoje.categorias[categoria] || []).includes(telefone);
}
function marcarEnviadosHoje(categoria, telefones) {
    if (!telefones.length) return;
    const estado = lerEstado();
    if (estado.enviadosHoje.data !== hojeChaveLocal()) estado.enviadosHoje = { data: hojeChaveLocal(), categorias: {} };
    if (!estado.enviadosHoje.categorias[categoria]) estado.enviadosHoje.categorias[categoria] = [];
    telefones.forEach((t) => { if (!estado.enviadosHoje.categorias[categoria].includes(t)) estado.enviadosHoje.categorias[categoria].push(t); });
    salvarEstado(estado);
}
function estaResumoEnviadoHoje(estado, telefone) {
    return estado.resumosEnviadosHoje.data === hojeChaveLocal() && estado.resumosEnviadosHoje.telefones.includes(telefone);
}
function marcarResumosEnviadosHoje(telefones) {
    if (!telefones.length) return;
    const estado = lerEstado();
    if (estado.resumosEnviadosHoje.data !== hojeChaveLocal()) estado.resumosEnviadosHoje = { data: hojeChaveLocal(), telefones: [] };
    telefones.forEach((t) => { if (!estado.resumosEnviadosHoje.telefones.includes(t)) estado.resumosEnviadosHoje.telefones.push(t); });
    salvarEstado(estado);
}

// Pausa manual por pessoa (botão "⏸️ 24h" no card) — fica de fora do envio
// AUTOMÁTICO enquanto durar, mas "📤 Agora" sempre ignora isso (é uma ação
// explícita do admin). Expira sozinha depois de "horas" — evita o risco de
// alguém ficar pausado pra sempre só porque esqueceram de reativar.
function estaPausadoIndividualmente(estado, telefone) {
    const p = estado.pausasIndividuais[telefone];
    return !!(p && new Date(p.ate).getTime() > Date.now());
}
function pausarPessoa(telefone, nome, horas) {
    const estado = lerEstado();
    estado.pausasIndividuais[telefone] = { nome: nome || '', ate: new Date(Date.now() + horas * 3600000).toISOString() };
    salvarEstado(estado);
}
function reativarPessoa(telefone) {
    const estado = lerEstado();
    delete estado.pausasIndividuais[telefone];
    salvarEstado(estado);
}

// Registro de cada tentativa de envio (sucesso ou falha), pro painel
// mostrar "Últimos envios" — mantém só os 30 mais recentes.
function registrarHistorico(entry) {
    const estado = lerEstado();
    estado.historico = [entry, ...estado.historico].slice(0, 30);
    salvarEstado(estado);
}

function atualizarContadoresHistorico() {
    const historico = lerEstado().historico;
    const hoje = hojeChaveLocal();
    const seteDiasAtras = Date.now() - 7 * 86400000;
    painelStatus.historico = historico.slice(0, 8);
    painelStatus.enviosHoje = historico.filter((h) => h.status === 'ok' && String(h.quando || '').startsWith(hoje)).length;
    painelStatus.enviosSemana = historico.filter((h) => h.status === 'ok' && new Date(h.quando).getTime() >= seteDiasAtras).length;
}

function hojeChaveLocal() {
    // yyyy-mm-dd no fuso de Brasília — evita duplicar envio se o processo
    // reiniciar no mesmo dia, e evita pular o dia errado por causa de UTC.
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function horaAgoraLocal() {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

function diaDaSemanaLocal() {
    // 0 = domingo ... 6 = sábado (mesmo índice de Date.getDay())
    const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[s];
}

// diasSemana vem da API (Admin > Configurações no app) — compartilhado por
// TODA categoria (só o horário varia por categoria, ver CATEGORIA_DEFS).
function diaConfiguradoHoje(diasSemana) {
    return diasSemana.includes(diaDaSemanaLocal());
}

// Não é um limite rígido — "hora" é só quando a categoria PASSA a poder
// sair, sem teto. Se o computador ficar desligado durante o horário
// configurado, o robô manda assim que ligar (mesmo depois), contanto que
// ainda seja hoje e já tenha passado da hora — sem isso, um dia inteiro
// passava sem avisar ninguém só porque o PC ligou depois do horário normal.
function passouDoHorario(hora) {
    return !!hora && horaAgoraLocal() >= hora;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cada item vira um bloco de 2-3 linhas — nome em negrito, detalhe embaixo
// com uma seta — em vez de uma linha só "Cliente — detalhe bem comprido".
// No celular essa linha única quebrava no meio do texto de um jeito
// confuso (ficava sem dar pra saber onde um item terminava e outro
// começava); com o detalhe na linha de baixo + espaço em branco entre
// blocos, cada pendência fica visualmente separada mesmo quando o texto
// quebra em 2-3 linhas de tela. "formatar" devolve {titulo, detalhe,
// extra?} — "extra" é opcional (ex.: a observação do relatório) e só
// aparece quando o item realmente tem esse texto.
function listaComLimite(itens, formatar, limite = 10) {
    const linhas = itens.slice(0, limite).map((i) => {
        const { titulo, detalhe, extra, link } = formatar(i);
        let bloco = `• *${titulo}*\n   ↳ ${detalhe}`;
        if (extra) bloco += `\n   💬 _${extra}_`;
        // Sem itálico (ao contrário de "extra") — WhatsApp às vezes não
        // detecta/pré-visualiza corretamente um link formatado como itálico.
        if (link) bloco += `\n   🔗 ${link}`;
        return bloco;
    }).join('\n\n');
    const resto = itens.length > limite ? `\n\n…e mais ${itens.length - limite}.` : '';
    return linhas + resto;
}

// "BRUNO RODRIGUES" -> "Bruno" — só pro cumprimento ficar natural; o resto
// da mensagem mantém o nome como está cadastrado.
function primeiroNome(nomeCompleto) {
    const primeiro = String(nomeCompleto || '').trim().split(/\s+/)[0] || '';
    return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

// Uma categoria = uma mensagem separada agora (antes era tudo junto numa
// mensagem só por pessoa). Cada entrada descreve como extrair os itens de
// "dest", formatar cada um ({titulo, detalhe}) e o limite de itens na
// mensagem — Funil entra com limite menor por já ter acumulado 17+ itens
// num caso real (alguns com mais de 800 dias parados).
const CATEGORIA_DEFS = {
    agendamentos: { label: '🔴 Agendamentos vencidos', itens: (d) => d.agendamentos, formatar: (p) => ({ titulo: p.cliente, detalhe: `venceu ${p.dataAgendada} (${p.diasAtraso}d atrás)` }), limite: 10 },
    propostas: { label: '📄 Propostas paradas', itens: (d) => d.propostas, formatar: (p) => ({ titulo: p.cliente, detalhe: `sem atualização há ${p.diasParada}d` }), limite: 10 },
    funil: { label: '📊 Funil parado', itens: (d) => d.funil, formatar: (f) => ({ titulo: f.cliente, detalhe: `sem atualização há ${f.diasParado}d` }), limite: 5 },
    campanhas: { label: '📣 Campanhas aguardando resposta', itens: (d) => d.campanhas, formatar: (c) => ({ titulo: c.titulo, detalhe: `${c.pendentes} cliente(s) pendente(s)`, link: c.link }), limite: 10 },
    contratos: { label: '📑 Contratos vencendo', itens: (d) => d.contratos, formatar: (c) => ({ titulo: c.cliente, detalhe: c.diasRestantes < 0 ? `venceu há ${-c.diasRestantes}d` : (c.diasRestantes === 0 ? 'vence hoje' : `vence em ${c.diasRestantes}d (${c.fim})`) }), limite: 10 }
};

function contarItensCategoria(dest, categoria) {
    if (categoria === 'inatividade') return dest.diasSemAtividade ? 1 : 0;
    const def = CATEGORIA_DEFS[categoria];
    return def ? (def.itens(dest) || []).length : 0;
}

const RODAPE_ACESSO = `🔗 Acesse o app: ${APP_URL}\nLogin: seu e-mail cadastrado (ou seu nome de usuário)\nSenha: os 4 últimos dígitos do seu celular`;

// Uma mensagem com UMA seção (a categoria pedida). "inatividade" não tem
// lista de itens — é um fato só ("há N dias sem visita").
function montarMensagemCategoria(dest, categoria) {
    const saudacao = `Olá, *${primeiroNome(dest.nome)}*! 👋`;
    let corpo;
    if (categoria === 'inatividade') {
        corpo = `⏰ *Inatividade*\n\nJá fazem *${dest.diasSemAtividade} dias* desde sua última visita/prospecção registrada — favor atualizar o aplicativo!`;
    } else {
        const def = CATEGORIA_DEFS[categoria];
        const itens = def.itens(dest) || [];
        corpo = `${def.label} (${itens.length})\n` + listaComLimite(itens, def.formatar, def.limite);
    }
    const dicaPausar = '_Responda "pausar" pra não receber avisos por 24h._';
    return [saudacao, corpo, RODAPE_ACESSO, dicaPausar, 'Bom trabalho! 💪\n_App de Visitas_'].join('\n\n');
}

async function buscarPendencias() {
    const res = await fetch(API_URL, { headers: { Authorization: `Bearer ${API_SECRET}` } });
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || 'Erro desconhecido na API.');
    // schedule sempre vem preenchido (mesmo pausado) — default aqui é só
    // uma rede de segurança caso a API esteja numa versão antiga.
    const schedule = json.schedule || { horarios: {}, diasSemana: [1, 2, 3, 4, 5] };
    return { destinatarios: json.data || [], semTelefone: json.semTelefone || [], schedule, pausado: !!json.pausado, teste: json.teste || null, aprovacaoManual: !!json.aprovacaoManual };
}

async function buscarResumos() {
    const res = await fetch(RESUMO_API_URL, { headers: { Authorization: `Bearer ${API_SECRET}` } });
    if (!res.ok) throw new Error(`API de resumo respondeu ${res.status}`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || 'Erro desconhecido na API de resumo.');
    const schedule = json.schedule || { hora: '07:30', diasSemana: [1, 2, 3, 4, 5] };
    return { gerentes: json.gerentes || [], manutencao: json.manutencao || [], pausado: !!json.pausado, schedule };
}

// Resumo do time do gerente — mesmas seções do resumo por e-mail (Início/
// cron), só que condensado pra WhatsApp e sem link por item. "metas" (meta
// mensal x visitas feitas) e "semanal" (ranking da semana passada, só às
// segundas) são opcionais — vêm preenchidos pela API só quando fazem
// sentido (ver api/resumo-whatsapp.js).
function montarMensagemResumoGerente(g) {
    const r = g.resumo;
    const partes = [`Olá, *${primeiroNome(g.nome)}*! 👋\n\n📋 *Resumo da sua equipe* — ${r.dataResumo}`];

    // Contagem por vendedor é só "Nome — N", cabe numa linha só (o bloco de
    // 2 linhas do listaComLimite é pra item com detalhe mais longo).
    const visitasTxt = r.visitas.total
        ? r.visitas.porVendedor.slice(0, 10).map((v) => `• ${v.nome} — ${v.total}`).join('\n')
        : 'Nenhuma visita registrada.';
    partes.push(`📍 *Visitas* (${r.visitas.total})\n${visitasTxt}`);

    const agLinhas = [];
    if (r.agendamentos.vencidosTotal) {
        agLinhas.push(`🔴 ${r.agendamentos.vencidosTotal} vencido(s):\n` + listaComLimite(r.agendamentos.vencidos, (a) => ({ titulo: a.cliente, detalhe: `venceu ${a.dataAgendada}` })));
    }
    if (r.agendamentos.proximosTotal) agLinhas.push(`📅 ${r.agendamentos.proximosTotal} nos próximos 7 dias`);
    partes.push(`📌 *Agendamentos*\n${agLinhas.length ? agLinhas.join('\n') : 'Nenhum vencido ou próximo.'}`);

    if (r.relatorios.total) {
        partes.push(`🔧 *Relatórios criados* (${r.relatorios.total})\nAferição: ${r.relatorios['aferição']} · SPSP: ${r.relatorios.spsp} · Geral: ${r.relatorios.geral}`);
    }

    if (g.metas && g.metas.length) {
        const metaTxt = g.metas.map((m) => `• ${m.nome} — ${m.feitas}/${m.meta}${m.feitas >= m.meta ? ' ✅' : ''}`).join('\n');
        partes.push(`🎯 *Meta mensal*\n${metaTxt}`);
    }

    if (g.semanal) {
        const rankTxt = g.semanal.ranking.slice(0, 10).map((v, i) => `${i + 1}º ${v.nome} — ${v.total}`).join('\n');
        partes.push(`📅 *Semana passada* (${g.semanal.total} visitas)\n${rankTxt}`);
    }

    partes.push(`🔗 Acesse o app: ${APP_URL}`);
    partes.push('Bom trabalho! 💪\n_App de Visitas_');
    return partes.join('\n\n');
}

// Resumo de manutenção (Open/Close) — empresa inteira, só pra quem está
// marcado em Admin > Configurações pra receber isso (ex.: Kadu).
function montarMensagemResumoManutencao(m) {
    const partes = [`Olá, *${primeiroNome(m.nome)}*! 👋\n\n🛠️ *Resumo de Manutenção (Open/Close)* — ${m.dataResumo}`];
    partes.push(listaComLimite(m.manutencao, (v) => ({
        titulo: v.cliente,
        detalhe: v.tipo + (v.vendedor ? ' — ' + v.vendedor : ''),
        extra: v.observacao || undefined
    }), 20));
    partes.push(`🔗 Acesse o app: ${APP_URL}`);
    partes.push('_App de Visitas_');
    return partes.join('\n\n');
}

// Conexão ativa, pra funções fora de iniciar() (tipo /verificar-agora via
// HTTP) conseguirem mandar o teste sem precisar passar sock por todo lado.
let sockAtual = null;

// Botão "🧪 Enviar teste" em Admin > Configurações grava um pedido na
// planilha e NUNCA é apagado de lá depois de enviado (fica só guardado como
// "o último teste pedido"). Controla localmente qual pedido já processou
// (por timestamp) pra não reenviar o mesmo teste a cada checagem — isso
// precisa estar salvo em disco (não só em memória): como o robô é
// reiniciado com frequência (a cada atualização), uma variável em memória
// resetava pra 0 a cada reinício e reenviava o MESMO teste antigo de novo
// (ex.: o de admin Kadu de dias atrás) assim que o robô voltava a conectar.
async function processarTesteSeNecessario(teste) {
    const estado = lerEstado();
    if (!teste || !teste.quando || teste.quando <= estado.ultimoTesteProcessado) return;
    estado.ultimoTesteProcessado = teste.quando;
    salvarEstado(estado);
    if (!sockAtual) {
        console.log('Teste pedido, mas o robô ainda não está conectado ao WhatsApp.');
        return;
    }
    const texto = `✅ *Teste do robô de avisos*\n\nSe você recebeu essa mensagem, está tudo funcionando certinho!\n_App de Visitas_`;
    try {
        await sockAtual.sendMessage(`${teste.telefone}@s.whatsapp.net`, { text: texto });
        console.log(`Teste enviado para ${teste.nome} (${teste.telefone}).`);
    } catch (err) {
        console.error('Falha ao enviar teste:', err.message);
        painelStatus.ultimoErro = `Falha ao enviar teste: ${err.message}`;
    }
}

// Uma categoria por vez agora (antes mandava tudo junto numa mensagem só
// por pessoa) — chamada uma vez pra cada categoria que já passou do
// próprio horário (ver checar()).
async function enviarCategoriaDoDia(sock, categoria, destinatarios) {
    if (!destinatarios.length) return;
    console.log(`Enviando ${categoria} para ${destinatarios.length} pessoa(s)...`);
    const telefonesOk = [];
    let falhas = 0;
    for (const dest of destinatarios) {
        const jid = `${dest.telefone}@s.whatsapp.net`;
        const texto = montarMensagemCategoria(dest, categoria);
        try {
            await sock.sendMessage(jid, { text: texto });
            console.log(`  ✓ [${categoria}] ${dest.nome} (${dest.telefone})`);
            telefonesOk.push(dest.telefone);
            registrarHistorico({ nome: dest.nome, telefone: dest.telefone, status: 'ok', categoria, pendencias: contarItensCategoria(dest, categoria), quando: new Date().toISOString() });
        } catch (err) {
            console.error(`  ✗ [${categoria}] ${dest.nome} (${dest.telefone}):`, err.message);
            falhas++;
            registrarHistorico({ nome: dest.nome, telefone: dest.telefone, status: 'erro', categoria, detalhe: err.message, quando: new Date().toISOString() });
        }
        // Espera entre envios + variação aleatória, pra não parecer disparo
        // em massa (gatilho comum de bloqueio).
        const jitter = DELAY_ENTRE_ENVIOS_MS * 0.5 * Math.random();
        await sleep(DELAY_ENTRE_ENVIOS_MS + jitter);
    }
    // Marca como "enviado hoje" (nessa categoria) só quem realmente recebeu
    // — quem falhou (ex.: conexão ainda instabilizando logo após parear)
    // continua fora da lista e entra de novo na próxima checagem, em vez de
    // ficar esquecido até o dia seguinte.
    if (telefonesOk.length) {
        marcarEnviadosHoje(categoria, telefonesOk);
        painelStatus.ultimoEnvio = new Date().toISOString();
    }
    if (falhas > 0) {
        const label = CATEGORIA_DEFS[categoria]?.label || categoria;
        painelStatus.ultimoErro = `${falhas} de ${destinatarios.length} mensagem(ns) de "${label}" falharam ao enviar — vai tentar de novo na próxima checagem.`;
    }
    console.log(`[${categoria}] concluído: ${telefonesOk.length} ok, ${falhas} falha(s).`);
}

// Resumo diário (gerente por time + manutenção pra quem está marcado em
// Admin > Configurações) — horário PRÓPRIO (separado das categorias de
// pendência, checado aqui dentro já que só esta função usa esse schedule),
// com dedup PRÓPRIO (resumosEnviadosHoje): a pessoa pode já ter recebido
// pendência hoje e ainda faltar o resumo, ou vice-versa.
async function enviarResumosDoDia(sock) {
    let gerentes = [];
    let manutencao = [];
    try {
        const r = await buscarResumos();
        if (r.pausado) return;
        if (!diaConfiguradoHoje(r.schedule.diasSemana) || !passouDoHorario(r.schedule.hora)) return;
        gerentes = r.gerentes;
        manutencao = r.manutencao;
    } catch (err) {
        console.error('Falha ao buscar resumos:', err.message);
        return;
    }
    const estado = lerEstado();
    const destinatarios = [
        ...gerentes.filter((g) => !estaResumoEnviadoHoje(estado, g.telefone)).map((g) => ({ nome: g.nome, telefone: g.telefone, texto: montarMensagemResumoGerente(g) })),
        ...manutencao.filter((m) => !estaResumoEnviadoHoje(estado, m.telefone)).map((m) => ({ nome: m.nome, telefone: m.telefone, texto: montarMensagemResumoManutencao(m) }))
    ];
    if (!destinatarios.length) return;

    console.log(`Enviando resumo diário pra ${destinatarios.length} pessoa(s)...`);
    const telefonesOk = [];
    for (const dest of destinatarios) {
        try {
            await sock.sendMessage(`${dest.telefone}@s.whatsapp.net`, { text: dest.texto });
            console.log(`  ✓ resumo: ${dest.nome} (${dest.telefone})`);
            telefonesOk.push(dest.telefone);
            registrarHistorico({ nome: dest.nome, telefone: dest.telefone, status: 'ok', tipo: 'resumo', quando: new Date().toISOString() });
        } catch (err) {
            console.error(`  ✗ resumo: ${dest.nome} (${dest.telefone}):`, err.message);
            registrarHistorico({ nome: dest.nome, telefone: dest.telefone, status: 'erro', tipo: 'resumo', detalhe: err.message, quando: new Date().toISOString() });
        }
        const jitter = DELAY_ENTRE_ENVIOS_MS * 0.5 * Math.random();
        await sleep(DELAY_ENTRE_ENVIOS_MS + jitter);
    }
    if (telefonesOk.length) marcarResumosEnviadosHoje(telefonesOk);
    console.log(`Resumo concluído: ${telefonesOk.length} ok, ${destinatarios.length - telefonesOk.length} falha(s).`);
}

// Busca pendências e atualiza o painel (prévia), sem nunca mandar nada —
// usado tanto pela checagem automática quanto pelo botão "Verificar agora".
// Devolve pendentesPorCategoria (quem ainda falta receber em CADA
// categoria, já descontando quem já recebeu hoje ou está pausado) pra
// checar() decidir, categoria por categoria, o que mandar.
async function atualizarPrevia() {
    const agora = Date.now();
    painelStatus.ultimaChecagem = new Date(agora).toISOString();
    painelStatus.proximaChecagemPrevista = new Date(agora + INTERVALO_CHECAGEM_MIN * 60 * 1000).toISOString();
    const { destinatarios, semTelefone, schedule, pausado, teste, aprovacaoManual } = await buscarPendencias();
    painelStatus.schedule = schedule;
    painelStatus.pausadoNoApp = pausado;
    painelStatus.aprovacaoManual = aprovacaoManual;
    const estado = lerEstado();
    // pausadoAte/enviadosPorCategoria vão junto na prévia pra cada card
    // (que já é por categoria) refletir o estado real daquela categoria
    // especificamente: "⏸️ pausado até Xh" (+ botão vira "▶️ Reativar"), ou
    // "✓ já enviado hoje" em vez do normal "✓ vai receber" — uma pessoa
    // pode ter Agendamentos já mandado e Funil ainda não, por exemplo.
    painelStatus.destinatariosPrevia = destinatarios.map((d) => {
        const p = estado.pausasIndividuais[d.telefone];
        const enviadosPorCategoria = {};
        CATEGORIAS_PENDENCIA.forEach((cat) => { enviadosPorCategoria[cat] = estaEnviadoHoje(estado, cat, d.telefone); });
        return {
            ...d,
            pausadoAte: (p && new Date(p.ate).getTime() > Date.now()) ? p.ate : null,
            enviadosPorCategoria
        };
    });
    painelStatus.semTelefonePrevia = semTelefone;
    painelStatus.ultimoErro = null;

    // Quem ainda falta receber em cada categoria — ignora pausado
    // individual (não é "faltando", é intencional) e quem já recebeu hoje
    // naquela categoria específica. O FILTRO POR HORÁRIO (categoria já
    // passou da própria hora?) fica a cargo de quem chama isso (checar()),
    // não aqui — a prévia do painel precisa mostrar tudo que falta, mesmo
    // o que ainda não chegou a hora de mandar.
    const pendentesPorCategoria = {};
    CATEGORIAS_PENDENCIA.forEach((cat) => {
        pendentesPorCategoria[cat] = destinatarios.filter((d) =>
            contarItensCategoria(d, cat) > 0 &&
            !estaEnviadoHoje(estado, cat, d.telefone) &&
            !estaPausadoIndividualmente(estado, d.telefone)
        );
    });
    const totalPendente = Object.values(pendentesPorCategoria).reduce((soma, lista) => soma + lista.length, 0);
    painelStatus.enviadoHoje = destinatarios.length > 0 && totalPendente === 0;

    atualizarContadoresHistorico();
    await processarTesteSeNecessario(teste);
    return { destinatarios, pendentesPorCategoria, schedule, pausado, aprovacaoManual };
}

// ── Painel local (http://localhost:PORTA_PAINEL) ────────────────────────
function paginaPainel() {
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Robô de WhatsApp</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif;
    max-width: 1800px; margin: 0 auto; padding: 2rem 2rem 3rem;
    background: #f6f7fa; color: #0f172a; min-height: 100vh;
  }
  header { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1.4rem; flex-wrap: wrap; }
  header .icon-box {
    width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    font-size: 1.3rem; background: #dcfce7;
  }
  header h1 { font-size: 1.25rem; margin: 0; font-weight: 800; letter-spacing: -0.01em; }
  header p { margin: 0.1rem 0 0; font-size: 0.82rem; color: #64748b; }
  .header-actions { display: flex; gap: 0.6rem; margin-left: auto; align-items: center; flex-wrap: wrap; }

  .banner {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
    border: 1px solid transparent; border-radius: 16px;
    padding: 1.1rem 1.4rem; margin-bottom: 1.1rem;
  }
  .banner.ok { background: #ecfdf5; border-color: #a7f3d0; }
  .banner.warn { background: #fffbeb; border-color: #fde68a; }
  .banner.off { background: #fef2f2; border-color: #fecaca; }
  .banner.paused { background: #f1f5f9; border-color: #e2e8f0; }
  .banner.manual { background: #eef2ff; border-color: #c7d2fe; }
  .banner-left { display: flex; align-items: flex-start; gap: 0.8rem; min-width: 0; }
  .banner-icon { font-size: 1.3rem; flex-shrink: 0; line-height: 1.35; }
  .banner-title { font-size: 1.05rem; font-weight: 800; margin: 0; }
  .banner-sub { font-size: 0.82rem; margin: 0.2rem 0 0; line-height: 1.45; }
  .banner.ok .banner-title, .banner.ok .banner-sub { color: #065f46; }
  .banner.warn .banner-title, .banner.warn .banner-sub { color: #92400e; }
  .banner.off .banner-title, .banner.off .banner-sub { color: #991b1b; }
  .banner.paused .banner-title, .banner.paused .banner-sub { color: #475569; }
  .banner.manual .banner-title, .banner.manual .banner-sub { color: #3730a3; }
  .banner-cta {
    flex-shrink: 0; width: auto; padding: 0.6rem 1.1rem; border-radius: 10px; font-size: 0.82rem; font-weight: 700;
    white-space: nowrap; background: #b45309; color: #fff; border: none; text-decoration: none; display: inline-flex; align-items: center;
  }
  .banner-cta:hover { background: #92400e; }
  .banner-cta.danger { background: #dc2626; }
  .banner-cta.danger:hover { background: #b91c1c; }

  .status-strip {
    display: flex; flex-wrap: wrap; align-items: center; row-gap: 0.4rem; column-gap: 0.9rem;
    background: #ffffff; border: 1px solid #e5e9f0; border-radius: 12px; padding: 0.7rem 1.1rem;
    margin-bottom: 1.1rem; font-size: 0.82rem; color: #475569;
  }
  .status-strip .sep { color: #cbd5e1; }
  .status-strip b { color: #0f172a; font-weight: 700; }
  .status-strip .err-line { flex-basis: 100%; color: #dc2626; font-size: 0.78rem; font-weight: 600; }
  .status-dot { width: 8px; height: 8px; border-radius: 999px; background: #22c55e; display: inline-block; margin-right: 0.35rem; }
  .status-dot.off { background: #ef4444; }
  .status-dot.warn { background: #f59e0b; }

  .card {
    background: #ffffff; border: 1px solid #e5e9f0; border-radius: 16px; padding: 1.25rem 1.3rem;
    box-shadow: 0 1px 3px rgba(15,23,42,0.04);
  }
  .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 0.5rem; flex-wrap: wrap; }
  .card-title { display: flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }
  .card-collapse-btn { width: auto; background: transparent; border: none; padding: 0.1rem 0.3rem; font-size: 0.85rem; color: #94a3b8; cursor: pointer; transition: transform 0.15s; }
  .card-collapse-btn:hover { color: #475569; }
  .card-collapse-btn.collapsed { transform: rotate(-90deg); }

  button {
    width: 100%; padding: 0.85rem; border-radius: 12px; font-size: 0.9rem; font-weight: 700;
    cursor: pointer; transition: transform 0.1s, opacity 0.15s, background 0.15s;
  }
  button:active { transform: scale(0.98); }
  button:disabled { opacity: 0.55; cursor: default; }
  .btn-primario { background: #2563eb; color: #fff; border: none; }
  .btn-primario:hover:not(:disabled) { background: #1d4ed8; }
  .btn-perigo-outline { background: #fff; color: #dc2626; border: 1.5px solid #fecaca; }
  .btn-perigo-outline:hover:not(:disabled) { background: #fef2f2; }
  .btn-neutro-outline { background: #fff; color: #475569; border: 1.5px solid #e2e8f0; }
  .btn-neutro-outline:hover:not(:disabled) { background: #f8fafc; }
  .btn-sm { width: auto; padding: 0.55rem 0.95rem; border-radius: 10px; font-size: 0.82rem; }
  .feedback-ok { font-size: 0.82rem; color: #16a34a; font-weight: 600; text-align: right; margin: -0.7rem 0 1rem; }
  .hint { font-size: 0.76rem; color: #94a3b8; margin-top: 0.5rem; text-align: center; line-height: 1.5; }

  .kanban-head-row { display: flex; justify-content: space-between; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .kanban-legend { display: flex; gap: 1rem; font-size: 0.74rem; color: #64748b; font-weight: 600; }
  .kanban-legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
  .legend-dot { width: 9px; height: 9px; border-radius: 999px; display: inline-block; }
  .legend-dot.on { background: #22c55e; }
  .legend-dot.off { background: #cbd5e1; }

  .kanban-wrap { display: flex; gap: 0.8rem; overflow-x: auto; padding-bottom: 0.3rem; margin: 0 -0.1rem; }
  .kanban-col { flex: 1 1 260px; min-width: 260px; background: #f8fafc; border: 1px solid #eef2f7; border-left: 4px solid #cbd5e1; border-radius: 12px; padding: 0.7rem; display: flex; flex-direction: column; gap: 0.5rem; max-height: 560px; }
  .kanban-col.c-agendamentos { border-left-color: #ef4444; }
  .kanban-col.c-propostas { border-left-color: #a855f7; }
  .kanban-col.c-funil { border-left-color: #3b82f6; }
  .kanban-col.c-campanhas { border-left-color: #f97316; }
  .kanban-col.c-contratos { border-left-color: #0d9488; }
  .kanban-col.desligada { opacity: 0.55; }
  .kanban-desligada-tag { font-size: 0.64rem; font-weight: 800; text-transform: uppercase; color: #94a3b8; background: #f1f5f9; padding: 0.05rem 0.4rem; border-radius: 999px; margin-left: 0.3rem; }
  .kanban-col-head { display: flex; justify-content: space-between; align-items: center; gap: 0.4rem; font-size: 0.78rem; font-weight: 800; color: #475569; padding: 0 0.1rem; }
  .kanban-count { flex-shrink: 0; background: #e2e8f0; color: #475569; font-size: 0.7rem; font-weight: 800; padding: 0.1rem 0.5rem; border-radius: 999px; }
  .kanban-cards { display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto; }
  .kanban-card { background: #fff; border: 1px solid #e5e9f0; border-radius: 10px; padding: 0.6rem 0.7rem; }
  .kanban-card.recebe { border-color: #86efac; background: #f0fdf4; }
  .kanban-card.ja-enviado { border-color: #bfdbfe; background: #eff6ff; }
  .kanban-card-top { display: flex; justify-content: space-between; align-items: center; gap: 0.4rem; }
  .kanban-card-nome { font-size: 0.82rem; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kanban-card-badge { flex-shrink: 0; font-size: 0.72rem; font-weight: 800; background: #dbeafe; color: #1d4ed8; padding: 0.1rem 0.5rem; border-radius: 999px; white-space: nowrap; }
  .kanban-card-badge.warn { background: #fef3c7; color: #92400e; }
  .kanban-card-detalhe { font-size: 0.74rem; color: #64748b; margin-top: 0.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kanban-card-status { display: flex; justify-content: space-between; align-items: center; gap: 0.4rem; margin-top: 0.35rem; }
  .kanban-card-status .ok { color: #16a34a; font-weight: 700; font-size: 0.7rem; }
  .kanban-card-status .no { color: #94a3b8; font-weight: 600; font-size: 0.7rem; }
  .kanban-card-status .enviado { color: #2563eb; font-weight: 700; font-size: 0.7rem; }
  .kanban-card-dias { flex-shrink: 0; font-size: 0.68rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 999px; background: #fef3c7; color: #92400e; white-space: nowrap; }
  .kanban-card-actions { display: flex; gap: 0.35rem; margin-top: 0.45rem; }
  .kanban-card-actions button { width: auto; flex: 1; padding: 0.3rem 0.3rem; font-size: 0.66rem; font-weight: 700; border-radius: 7px; border: 1px solid #e5e9f0; background: #f8fafc; color: #475569; cursor: pointer; }
  .kanban-card-actions button:hover:not(:disabled) { background: #eef2f7; }
  .kanban-card-actions button.pausado { background: #fef3c7; color: #92400e; border-color: #fde68a; }
  .kanban-mais { width: auto; background: transparent; border: none; font-size: 0.74rem; color: #2563eb; font-weight: 700; text-align: center; padding: 0.3rem 0; cursor: pointer; }
  .kanban-mais:hover { text-decoration: underline; }
  .kanban-vazio { font-size: 0.78rem; color: #94a3b8; text-align: center; padding: 1rem 0; }

  .semwhats-intro { font-size: 0.76rem; color: #92400e; margin: 0 0 0.5rem; line-height: 1.4; }
  .semwhats-rows { display: flex; flex-direction: column; }
  @media (min-width: 1400px) { .semwhats-rows { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.3rem; } }
  .inatividade-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.6rem; }
  .semwhats-row { display: flex; justify-content: space-between; align-items: center; gap: 0.6rem; padding: 0.5rem 0; border-bottom: 1px solid #fde68a; }
  .semwhats-row:last-child { border-bottom: none; }
  .semwhats-nome { font-weight: 700; font-size: 0.82rem; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .semwhats-right { display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; }
  .semwhats-pend { font-size: 0.74rem; color: #92400e; white-space: nowrap; }
  .semwhats-cadastrar { font-size: 0.76rem; color: #2563eb; font-weight: 700; text-decoration: none; }
  .semwhats-cadastrar:hover { text-decoration: underline; }

  #historico-lista { display: flex; flex-direction: column; }
  @media (min-width: 1400px) { #historico-lista { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.3rem; } }
  .hist-item { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.65rem 0; border-bottom: 1px solid #eef2f7; }
  .hist-item:last-child { border-bottom: none; padding-bottom: 0; }
  .hist-item:first-child { padding-top: 0; }
  .hist-left { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
  .hist-icon { flex-shrink: 0; width: 20px; height: 20px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800; }
  .hist-icon.ok { background: #dcfce7; color: #16a34a; }
  .hist-icon.erro { background: #fee2e2; color: #dc2626; }
  .hist-nome { font-size: 0.85rem; font-weight: 600; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hist-nome .det { color: #64748b; font-weight: 400; }
  .hist-nome .det.err { color: #dc2626; }
  .hist-quando { flex-shrink: 0; font-size: 0.76rem; color: #94a3b8; }

  .vazio { font-size: 0.85rem; color: #94a3b8; text-align: center; padding: 1rem 0; }

  #qr-card img { width: 100%; max-width: 260px; border-radius: 10px; margin: 0.6rem auto 0; display: block; border: 1px solid #e5e9f0; }
</style>
</head>
<body>
  <header>
    <span class="icon-box">📱</span>
    <div>
      <h1>Robô de WhatsApp</h1>
      <p>Avisos de pendência · App de Visitas</p>
    </div>
    <div class="header-actions">
      <button class="btn-primario btn-sm" id="btn-verificar" title="Só confere as pendências — nenhuma mensagem é enviada.">🔍 Verificar agora</button>
      <button class="btn-neutro-outline btn-sm" id="btn-desconectar" title="Encerra a sessão do WhatsApp (precisa escanear o QR de novo pra reconectar) — o robô e o painel continuam rodando.">🔌 Desconectar</button>
      <button class="btn-perigo-outline btn-sm" id="btn-parar">⏹ Parar robô</button>
    </div>
  </header>
  <p class="feedback-ok" id="feedback-verificar" style="display:none"></p>

  <div class="banner" id="banner">Carregando...</div>
  <div class="status-strip" id="status-strip"></div>

  <div class="card" id="qr-card" style="display:none;text-align:center;margin-bottom:1.1rem">
    <span class="card-title" style="justify-content:center">📷 Escaneie pra conectar</span>
    <p class="hint">WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho</p>
    <img id="qr-img" alt="QR code de pareamento">
  </div>

  <div class="card" style="margin-bottom:1.1rem">
    <div class="kanban-head-row">
      <span class="card-title">📋 Pendências por tipo</span>
      <div class="kanban-legend">
        <span><span class="legend-dot on"></span>Vai receber</span>
        <span><span class="legend-dot off"></span>Sem WhatsApp</span>
      </div>
    </div>
    <div class="kanban-wrap" id="kanban-board">—</div>
  </div>

  <div class="card" style="margin-bottom:1.1rem">
    <div class="card-head">
      <span class="card-title">🕒 Últimos envios</span>
      <button type="button" class="card-collapse-btn" id="btn-toggle-historico" aria-label="Mostrar/esconder últimos envios">▾</button>
    </div>
    <div id="historico-lista"></div>
  </div>

  <div class="card" id="inatividade-card" style="display:none;margin-bottom:1.1rem">
    <div class="card-head">
      <span class="card-title">⏰ Inatividade</span>
      <span class="kanban-count" id="inatividade-card-count">0</span>
    </div>
    <div class="inatividade-grid" id="inatividade-board"></div>
  </div>

  <div class="card" id="semwhats-card" style="display:none">
    <div class="card-head">
      <span class="card-title">⚠️ Sem WhatsApp cadastrado</span>
      <span class="kanban-count" id="semwhats-card-count" style="background:#fef3c7;color:#92400e">0</span>
    </div>
    <div id="sem-whatsapp-board"></div>
  </div>

<script>
const APP_URL = ${JSON.stringify(APP_URL)};
let proximaChecagemMs = null;

function iniciais(nome) {
  const partes = String(nome || '?').trim().split(/\\s+/);
  const primeiras = (partes[0]?.[0] || '') + (partes.length > 1 ? partes[partes.length - 1][0] : '');
  return primeiras.toUpperCase() || '?';
}

function formatHora(iso) {
  return iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
}

function formatRelativo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const hoje = new Date();
  const mesmodia = d.toDateString() === hoje.toDateString();
  if (mesmodia) return 'hoje, ' + formatHora(iso);
  const ontem = new Date(hoje); ontem.setDate(ontem.getDate() - 1);
  if (d.toDateString() === ontem.toDateString()) return 'ontem, ' + formatHora(iso);
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  return dias[d.getDay()] + ', ' + formatHora(iso);
}

// Cada categoria tem seu próprio horário agora — "próximo envio" vira "a
// mais cedo das que ainda não passaram hoje" (ou a mais cedo de amanhã, se
// todas já passaram). Só uma aproximação pro banner, não uma promessa exata
// (afinal pode já ter passado da hora de uma categoria mas ela não ter
// ninguém pendente agora).
function horaMaisCedoPendente(s) {
  if (!s.schedule || !s.schedule.horarios) return null;
  const horas = Object.values(s.schedule.horarios).filter(Boolean).sort();
  if (!horas.length) return null;
  const agora = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return horas.find((h) => h > agora) || horas[0];
}
function proximoEnvioLabel(s) {
  if (!s.schedule) return '—';
  if (s.pausadoNoApp) return 'pausado';
  const proxima = horaMaisCedoPendente(s);
  if (!proxima) return '—';
  if (s.enviadoHoje) return 'amanhã, ' + proxima;
  const agora = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  if (agora < proxima) return 'hoje, ' + proxima;
  return 'em instantes';
}

function listaNomes(nomes) {
  if (!nomes.length) return '';
  if (nomes.length === 1) return nomes[0];
  if (nomes.length === 2) return nomes[0] + ' e ' + nomes[1];
  return nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1];
}

function renderBanner(s) {
  const el = document.getElementById('banner');
  const comTel = (s.destinatariosPrevia || []).length;
  const semTel = (s.semTelefonePrevia || []).length;
  const total = comTel + semTel;
  const quando = proximoEnvioLabel(s);
  let classe = 'ok';
  let icone = '✅';
  let titulo = 'Funcionando';
  let sub = '';
  let cta = '';

  if (s.sessaoEncerrada) {
    // Caso mais sério: o WhatsApp encerrou a sessão de verdade (ex.:
    // aparelho removido pelo celular) — reconectar sozinho repetiria o
    // mesmo erro pra sempre, então precisa de um "Reparear" explícito.
    classe = 'off'; icone = '🔌';
    titulo = 'Sessão do WhatsApp encerrada';
    sub = 'O aparelho foi desconectado do WhatsApp (ex.: removido pelo celular, ou excesso de aparelhos conectados). O robô NÃO tenta reconectar sozinho nesse caso — clique abaixo pra gerar um novo QR code.';
    cta = '<button type="button" class="banner-cta danger" data-action="reparear">🔄 Reparear agora</button>';
  } else if (s.pausadoNoApp) {
    classe = 'paused'; icone = '⏸️'; titulo = 'Pausado';
    sub = 'Envio desligado em Admin &gt; Configurações — ninguém recebe enquanto isso.';
  } else if (!s.conectado) {
    classe = 'off'; icone = s.aguardandoQr ? '📷' : '🔴'; titulo = s.aguardandoQr ? 'Aguardando pareamento' : 'Desconectado';
    sub = s.aguardandoQr ? 'Escaneie o QR code abaixo pra conectar.' : 'O WhatsApp caiu — o robô tenta reconectar sozinho.';
  } else if (s.aprovacaoManual) {
    classe = 'manual'; icone = '🔒';
    titulo = 'Modo aprovação manual';
    sub = 'Nada sai sozinho — os cards abaixo continuam mostrando tudo, clique em "Agora" em cada um pra aprovar e enviar. Desligue em Admin &gt; Configurações quando confiar no envio automático.';
  } else if (total > 0 && semTel > 0) {
    classe = 'warn'; icone = '⚠️';
    titulo = 'Funcionando, mas ' + semTel + ' de ' + total + (total === 1 ? ' pessoa está' : ' pessoas estão') + ' sem WhatsApp';
    const nomes = (s.destinatariosPrevia || []).map((d) => d.nome);
    sub = nomes.length
      ? ('Só ' + listaNomes(nomes) + (nomes.length === 1 ? ' vai receber' : ' vão receber') + ' o aviso ' + quando + '. Os cards cinza não serão avisados.')
      : ('Ninguém vai receber aviso ' + quando + ' — nenhuma das ' + total + ' pessoas com pendência tem WhatsApp cadastrado.');
    cta = '<a class="banner-cta" href="' + APP_URL + '?goto=admin" target="_blank" rel="noopener">Cadastrar no Admin →</a>';
  } else {
    const enviouTxt = s.ultimoEnvio ? ('Enviou hoje às ' + formatHora(s.ultimoEnvio)) : 'Ainda não enviou hoje';
    sub = enviouTxt + ' · Próximo envio ' + quando;
  }

  el.className = 'banner ' + classe;
  el.innerHTML = \`
    <div class="banner-left">
      <span class="banner-icon">\${icone}</span>
      <div>
        <p class="banner-title">\${titulo}</p>
        <p class="banner-sub">\${sub}</p>
      </div>
    </div>
    \${cta}
  \`;
}

const CATEGORIA_LABEL_CURTO = { agendamentos: 'Agend', propostas: 'Prop', funil: 'Funil', campanhas: 'Camp', inatividade: 'Inativ', contratos: 'Contr' };
const CATEGORIA_LABEL_COMPLETO = { agendamentos: 'Agendamentos', propostas: 'Propostas', funil: 'Funil', campanhas: 'Campanhas', inatividade: 'Inatividade', contratos: 'Contratos' };

function renderStatusStrip(s) {
  const dotClasse = s.conectado ? '' : (s.aguardandoQr ? 'warn' : 'off');
  const linhaConexao = s.aguardandoQr ? 'Aguardando pareamento' : (s.conectado ? 'Conectado' : 'Desconectado');
  let janela = '—';
  let janelaTitle = 'Horário de cada categoria';
  if (s.schedule && s.schedule.horarios) {
    const entradas = Object.entries(s.schedule.horarios).filter(([, h]) => h);
    if (entradas.length) {
      const horas = entradas.map(([, h]) => h).sort();
      janela = horas[0] + '–' + horas[horas.length - 1];
      janelaTitle = entradas.map(([cat, h]) => (CATEGORIA_LABEL_CURTO[cat] || cat) + ' ' + h).join(' · ');
    }
  }
  const checagem = s.ultimaChecagem ? formatHora(s.ultimaChecagem) : '—';
  document.getElementById('status-strip').innerHTML = \`
    <span><span class="status-dot \${dotClasse}"></span>\${linhaConexao}</span>
    <span class="sep">·</span>
    <span title="\${janelaTitle}">Horários <b>\${janela}</b></span>
    <span class="sep">·</span>
    <span>Última checagem <b>\${checagem}</b></span>
    <span class="sep">·</span>
    <span>Próxima em <b id="countdown-num">--:--</b></span>
    <span class="sep">·</span>
    <span>Enviadas hoje <b>\${s.enviosHoje || 0}</b> · semana <b>\${s.enviosSemana || 0}</b></span>
    \${s.ultimoErro ? '<span class="err-line">⚠️ ' + s.ultimoErro + '</span>' : ''}
  \`;
}

// Pendências organizadas em colunas por TIPO (estilo kanban) em vez de
// agrupadas por pessoa — com números grandes (uma pessoa pode acumular
// várias dezenas), fica muito mais fácil ver de relance onde está o
// maior volume do que rolando uma lista comprida por pessoa.
const KANBAN_DEFS = [
  { key: 'agendamentos', classe: 'c-agendamentos', label: '🔴 Agendamentos', getItens: (d) => d.agendamentos, detalhe: (p) => p.cliente, contagem: (n) => n + (n === 1 ? ' item' : ' itens'), dias: (p) => p.diasAtraso },
  { key: 'propostas', classe: 'c-propostas', label: '📄 Propostas', getItens: (d) => d.propostas, detalhe: (p) => p.cliente, contagem: (n) => n + (n === 1 ? ' proposta' : ' propostas') },
  { key: 'funil', classe: 'c-funil', label: '📊 Funil', getItens: (d) => d.funil, detalhe: (f) => f.cliente, contagem: (n) => n + (n === 1 ? ' cliente' : ' clientes') },
  { key: 'campanhas', classe: 'c-campanhas', label: '📣 Campanhas', getItens: (d) => d.campanhas, detalhe: (c) => c.titulo, contagem: (n) => n + (n === 1 ? ' campanha' : ' campanhas') },
  { key: 'contratos', classe: 'c-contratos', label: '📑 Contratos', getItens: (d) => d.contratos, detalhe: (c) => c.cliente, contagem: (n) => n + (n === 1 ? ' contrato' : ' contratos') }
];
const LIMITE_CARDS_COLUNA = 5;
const LIMITE_LINHAS_SEM_WHATSAPP = 7;
// Quais colunas o usuário já clicou "+N mais" pra ver tudo — guardado aqui
// (não no servidor) só pra lembrar entre atualizações automáticas do painel.
const colunasExpandidas = new Set();
let ultimoStatusParaKanban = null;

function adminLink(email) {
  return APP_URL + (email ? ('?editUser=' + encodeURIComponent(email)) : '?goto=admin');
}

function montarColunasKanban(s) {
  const todos = [
    ...(s.destinatariosPrevia || []).map((d) => Object.assign({ temTelefone: true }, d)),
    ...(s.semTelefonePrevia || []).map((d) => Object.assign({ temTelefone: false }, d))
  ];
  const cols = KANBAN_DEFS.map(({ key, classe, label, getItens, detalhe, contagem, dias }) => ({
    key, classe, label,
    cards: todos
      .filter((d) => getItens(d) && getItens(d).length)
      .map((d) => {
        const itens = getItens(d);
        const diasValor = dias ? dias(itens[0]) : null;
        return {
          categoria: key, nome: d.nome, temTelefone: d.temTelefone, telefone: d.telefone, pausadoAte: d.pausadoAte || null,
          jaEnviadoHoje: !!(d.enviadosPorCategoria && d.enviadosPorCategoria[key]),
          count: itens.length, badge: contagem(itens.length),
          detalhe: detalhe(itens[0]) + (itens.length > 1 ? ' +' + (itens.length - 1) : ''),
          dias: diasValor
        };
      })
      .sort((a, b) => b.count - a.count)
  }));
  return cols;
}

// Inatividade saiu do kanban (virou seção própria abaixo de "Últimos
// envios", igual "Sem WhatsApp") — mesmos dados, só não entra mais em
// montarColunasKanban/renderKanban.
function montarCardsInatividade(s) {
  const todos = [
    ...(s.destinatariosPrevia || []).map((d) => Object.assign({ temTelefone: true }, d)),
    ...(s.semTelefonePrevia || []).map((d) => Object.assign({ temTelefone: false }, d))
  ];
  return todos.filter((d) => d.diasSemAtividade)
    .map((d) => ({
      categoria: 'inatividade', nome: d.nome, temTelefone: d.temTelefone, telefone: d.telefone, pausadoAte: d.pausadoAte || null,
      jaEnviadoHoje: !!(d.enviadosPorCategoria && d.enviadosPorCategoria.inatividade),
      count: d.diasSemAtividade, badge: 'há ' + d.diasSemAtividade + ' dias', detalhe: '', dias: null
    }))
    .sort((a, b) => b.count - a.count);
}

function kanbanCardHtml(card) {
  const acoes = card.temTelefone ? \`
    <div class="kanban-card-actions">
      <button type="button" data-action="disparar" data-categoria="\${card.categoria}" data-telefone="\${card.telefone}" data-nome="\${card.nome}">📤 \${card.jaEnviadoHoje ? 'Reenviar' : 'Agora'}</button>
      \${card.pausadoAte
        ? '<button type="button" class="pausado" data-action="reativar" data-telefone="' + card.telefone + '" data-nome="' + card.nome + '">▶️ Reativar</button>'
        : '<button type="button" data-action="pausar" data-telefone="' + card.telefone + '" data-nome="' + card.nome + '">⏸️ 24h</button>'}
    </div>
  \` : '';
  let statusHtml = '<span class="no">sem WhatsApp</span>';
  if (card.temTelefone) {
    if (card.pausadoAte) statusHtml = '<span class="no">⏸️ pausado até ' + formatHora(card.pausadoAte) + '</span>';
    else if (card.jaEnviadoHoje) statusHtml = '<span class="enviado">✓ já enviado hoje</span>';
    else statusHtml = '<span class="ok">✓ vai receber</span>';
  }
  return \`
    <div class="kanban-card \${card.temTelefone ? 'recebe' : ''} \${card.jaEnviadoHoje ? 'ja-enviado' : ''}">
      <div class="kanban-card-top">
        <span class="kanban-card-nome">\${card.nome}</span>
        <span class="kanban-card-badge \${card.temTelefone ? '' : 'warn'}">\${card.badge}</span>
      </div>
      \${card.detalhe ? '<div class="kanban-card-detalhe">' + card.detalhe + '</div>' : ''}
      <div class="kanban-card-status">
        \${statusHtml}
        \${card.dias ? '<span class="kanban-card-dias">há ' + card.dias + ' dias</span>' : ''}
      </div>
      \${acoes}
    </div>
  \`;
}

function maisBotaoHtml(key, resto, expandido, totalCount) {
  if (resto > 0) return '<button type="button" class="kanban-mais" data-col="' + key + '">+' + resto + ' mais</button>';
  if (expandido && totalCount > LIMITE_CARDS_COLUNA) return '<button type="button" class="kanban-mais" data-col="' + key + '">mostrar menos</button>';
  return '';
}

function renderKanban(s) {
  ultimoStatusParaKanban = s;
  const board = document.getElementById('kanban-board');
  if (s.pausadoNoApp) { board.innerHTML = '<p class="vazio">⏸️ Pausado em Admin &gt; Configurações — ninguém recebe enquanto isso.</p>'; return; }
  const cols = montarColunasKanban(s);
  if (!cols.some((c) => c.cards.length)) {
    board.innerHTML = s.enviadoHoje
      ? '<p class="vazio">✅ Já enviado hoje. Nada de novo desde então.</p>'
      : '<p class="vazio">Ninguém com pendência no momento.</p>';
    return;
  }
  const ativos = (s.schedule && s.schedule.ativos) || {};
  board.innerHTML = cols.map((c) => {
    const expandido = colunasExpandidas.has(c.key);
    const visiveis = expandido ? c.cards : c.cards.slice(0, LIMITE_CARDS_COLUNA);
    const resto = expandido ? 0 : c.cards.length - visiveis.length;
    const desligada = ativos[c.key] === false;
    return \`
    <div class="kanban-col \${c.classe} \${desligada ? 'desligada' : ''}">
      <div class="kanban-col-head"><span>\${c.label}\${desligada ? ' <span class="kanban-desligada-tag">desligada</span>' : ''}</span><span class="kanban-count">\${c.cards.length}</span></div>
      <div class="kanban-cards">
        \${visiveis.length ? visiveis.map(kanbanCardHtml).join('') : '<p class="kanban-vazio">Nenhuma pendência</p>'}
        \${maisBotaoHtml(c.key, resto, expandido, c.cards.length)}
      </div>
    </div>
  \`;
  }).join('');
}

// Compartilhado pelos cards de "Pendências por tipo" e "Inatividade" (os
// dois usam kanbanCardHtml, com os mesmos botões de ação) — evita duplicar
// o mesmo tratamento de clique em dois listeners quase iguais.
async function tratarAcaoCard(ev) {
  const btnDisparar = ev.target.closest('[data-action="disparar"]');
  if (btnDisparar) {
    const telefone = btnDisparar.dataset.telefone;
    const nome = btnDisparar.dataset.nome;
    const categoria = btnDisparar.dataset.categoria;
    const label = (CATEGORIA_LABEL_COMPLETO[categoria] || categoria);
    if (!confirm('Enviar a mensagem de "' + label + '" pra ' + nome + ' agora mesmo?')) return true;
    btnDisparar.disabled = true;
    btnDisparar.textContent = 'Enviando...';
    try {
      const r = await fetch('/disparar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefone, categoria }) });
      const s = await r.json();
      if (s.status === 'error') alert(s.message);
    } catch (e) { alert('Não consegui falar com o robô.'); }
    await atualizar();
    return true;
  }
  const btnPausa = ev.target.closest('[data-action="pausar"], [data-action="reativar"]');
  if (btnPausa) {
    const telefone = btnPausa.dataset.telefone;
    const nome = btnPausa.dataset.nome;
    const url = btnPausa.dataset.action === 'pausar' ? '/pausar-pessoa' : '/reativar-pessoa';
    btnPausa.disabled = true;
    try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefone, nome }) }); } catch (e) { /* atualizar() abaixo reflete o estado real */ }
    await atualizar();
    return true;
  }
  return false;
}

document.getElementById('kanban-board').addEventListener('click', async (ev) => {
  if (await tratarAcaoCard(ev)) return;
  const btn = ev.target.closest('.kanban-mais[data-col]');
  if (!btn) return;
  const key = btn.dataset.col;
  if (colunasExpandidas.has(key)) colunasExpandidas.delete(key); else colunasExpandidas.add(key);
  if (ultimoStatusParaKanban) renderKanban(ultimoStatusParaKanban);
});

function renderInatividade(s) {
  const card = document.getElementById('inatividade-card');
  const board = document.getElementById('inatividade-board');
  const cards = montarCardsInatividade(s);
  document.getElementById('inatividade-card-count').textContent = String(cards.length);
  card.style.display = cards.length ? '' : 'none';
  if (!cards.length) { board.innerHTML = ''; return; }

  const key = 'inatividade';
  const expandido = colunasExpandidas.has(key);
  const visiveis = expandido ? cards : cards.slice(0, LIMITE_CARDS_COLUNA);
  const resto = expandido ? 0 : cards.length - visiveis.length;
  board.innerHTML = visiveis.map(kanbanCardHtml).join('') + maisBotaoHtml(key, resto, expandido, cards.length);
}

document.getElementById('inatividade-board').addEventListener('click', async (ev) => {
  if (await tratarAcaoCard(ev)) return;
  const btn = ev.target.closest('.kanban-mais[data-col="inatividade"]');
  if (!btn) return;
  if (colunasExpandidas.has('inatividade')) colunasExpandidas.delete('inatividade'); else colunasExpandidas.add('inatividade');
  if (ultimoStatusParaKanban) renderInatividade(ultimoStatusParaKanban);
});

// "Sem WhatsApp" virou uma seção própria abaixo de "Últimos envios" (em vez
// de uma 6ª coluna espremendo as outras no kanban) — pedido explícito, fica
// mais fácil de ler tanto o kanban quanto essa lista.
function renderSemWhatsapp(s) {
  const card = document.getElementById('semwhats-card');
  const board = document.getElementById('sem-whatsapp-board');
  const semTelefone = s.semTelefonePrevia || [];
  document.getElementById('semwhats-card-count').textContent = String(semTelefone.length);
  card.style.display = semTelefone.length ? '' : 'none';
  if (!semTelefone.length) { board.innerHTML = ''; return; }

  const key = 'semwhats';
  const expandido = colunasExpandidas.has(key);
  const visiveis = expandido ? semTelefone : semTelefone.slice(0, LIMITE_LINHAS_SEM_WHATSAPP);
  const resto = expandido ? 0 : semTelefone.length - visiveis.length;
  board.innerHTML = \`
    <p class="semwhats-intro">Essas pessoas não recebem avisos até ter o WhatsApp cadastrado.</p>
    <button type="button" class="kanban-mais" style="text-align:left;padding:0 0 0.5rem" data-action="copiar-semwhats">📋 Copiar lista de nomes</button>
    <div class="semwhats-rows">
      \${visiveis.map((d) => {
        const totalPend = (d.agendamentos?.length || 0) + (d.propostas?.length || 0) + (d.funil?.length || 0) + (d.campanhas?.length || 0) + (d.diasSemAtividade ? 1 : 0);
        return \`
        <div class="semwhats-row">
          <span class="semwhats-nome">\${d.nome}</span>
          <span class="semwhats-right">
            <span class="semwhats-pend">\${totalPend} pend.</span>
            <a class="semwhats-cadastrar" href="\${adminLink(d.email)}" target="_blank" rel="noopener">Cadastrar</a>
          </span>
        </div>
      \`;
      }).join('')}
      \${maisBotaoHtml(key, resto, expandido, semTelefone.length)}
    </div>
  \`;
}

document.getElementById('semwhats-card').addEventListener('click', async (ev) => {
  const btnCopiar = ev.target.closest('[data-action="copiar-semwhats"]');
  if (btnCopiar) {
    const nomes = (ultimoStatusParaKanban?.semTelefonePrevia || []).map((d) => d.nome);
    const texto = nomes.join('\\n');
    const textoOriginal = btnCopiar.textContent;
    try {
      await navigator.clipboard.writeText(texto);
      btnCopiar.textContent = '✓ Copiado!';
    } catch (e) {
      btnCopiar.textContent = 'Não consegui copiar — copie manualmente';
    }
    setTimeout(() => { btnCopiar.textContent = textoOriginal; }, 2000);
    return;
  }
  const btn = ev.target.closest('.kanban-mais[data-col="semwhats"]');
  if (!btn) return;
  if (colunasExpandidas.has('semwhats')) colunasExpandidas.delete('semwhats'); else colunasExpandidas.add('semwhats');
  if (ultimoStatusParaKanban) renderSemWhatsapp(ultimoStatusParaKanban);
});

document.getElementById('banner').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action="reparear"]');
  if (!btn) return;
  if (!confirm('Isso apaga o pareamento atual e gera um QR code novo pra escanear. Confirma?')) return;
  btn.disabled = true;
  btn.textContent = 'Reparando...';
  try { await fetch('/reparear', { method: 'POST' }); } catch (e) { /* atualizar() abaixo já reflete o estado real */ }
  await atualizar();
});

// Colapsado por padrão fica salvo localmente (só preferência de tela,
// não precisa do servidor) — assim não volta a abrir sozinho a cada
// atualização automática do painel (a cada 4s).
const HISTORICO_COLAPSADO_KEY = 'wa-painel-historico-colapsado';
function aplicarColapsoHistorico(colapsado) {
  const lista = document.getElementById('historico-lista');
  const btn = document.getElementById('btn-toggle-historico');
  if (lista) lista.style.display = colapsado ? 'none' : '';
  if (btn) btn.classList.toggle('collapsed', colapsado);
}
(() => {
  let colapsado = false;
  try { colapsado = localStorage.getItem(HISTORICO_COLAPSADO_KEY) === '1'; } catch (e) { /* localStorage indisponível — fica expandido */ }
  aplicarColapsoHistorico(colapsado);
  const btn = document.getElementById('btn-toggle-historico');
  if (btn) btn.addEventListener('click', () => {
    const agora = document.getElementById('historico-lista').style.display !== 'none';
    aplicarColapsoHistorico(agora);
    try { localStorage.setItem(HISTORICO_COLAPSADO_KEY, agora ? '1' : '0'); } catch (e) { /* ignora */ }
  });
})();

function renderHistorico(s) {
  const el = document.getElementById('historico-lista');
  const hist = s.historico || [];
  if (!hist.length) { el.innerHTML = '<p class="vazio">Nenhum envio ainda.</p>'; return; }
  el.innerHTML = hist.map((h) => \`
    <div class="hist-item">
      <div class="hist-left">
        <span class="hist-icon \${h.status}">\${h.tipo === 'resumo' ? '📋' : (h.status === 'ok' ? '✓' : '✕')}</span>
        <span class="hist-nome">\${h.nome} <span class="det \${h.status === 'erro' ? 'err' : ''}">· \${h.status === 'erro' ? ('falhou (' + (h.detalhe || 'erro') + ')') : (h.tipo === 'resumo' ? 'resumo diário' : (h.pendencias + ' pendência' + (h.pendencias === 1 ? '' : 's')))}</span></span>
      </div>
      <span class="hist-quando">\${formatRelativo(h.quando)}</span>
    </div>
  \`).join('');
}

function formatCountdown(ms) {
  if (ms === null || ms < 0) return '--:--';
  const totalSeg = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSeg / 60)).padStart(2, '0');
  const s = String(totalSeg % 60).padStart(2, '0');
  return m + ':' + s;
}
function tickCountdown() {
  const el = document.getElementById('countdown-num');
  if (!el) return;
  el.textContent = proximaChecagemMs === null ? '--:--' : formatCountdown(proximaChecagemMs - Date.now());
}
setInterval(tickCountdown, 1000);

async function atualizar() {
  try {
    const r = await fetch('/status');
    const s = await r.json();
    proximaChecagemMs = s.proximaChecagemPrevista ? new Date(s.proximaChecagemPrevista).getTime() : null;

    const qrCard = document.getElementById('qr-card');
    if (s.aguardandoQr && s.qrDataUrl) {
      qrCard.style.display = 'block';
      document.getElementById('qr-img').src = s.qrDataUrl;
    } else {
      qrCard.style.display = 'none';
    }

    renderBanner(s);
    renderStatusStrip(s);
    tickCountdown();
    renderKanban(s);
    renderHistorico(s);
    renderInatividade(s);
    renderSemWhatsapp(s);
  } catch (e) {
    document.getElementById('banner').innerHTML = '<span style="color:#dc2626">Não consegui falar com o robô — ele ainda está rodando?</span>';
  }
}

document.getElementById('btn-verificar').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  ev.target.textContent = 'Verificando...';
  const fb = document.getElementById('feedback-verificar');
  fb.style.display = 'none';
  try {
    const r = await fetch('/verificar-agora', { method: 'POST' });
    const s = await r.json();
    const n = (s.destinatariosPrevia || []).length;
    const semTel = (s.semTelefonePrevia || []).length;
    fb.textContent = '✓ Verificado agora · ' + n + (n === 1 ? ' pendência encontrada' : ' pendências encontradas')
        + (semTel ? (' · ⚠️ ' + semTel + ' sem WhatsApp cadastrado') : '');
    fb.style.display = 'block';
  } catch (e) { /* status atualiza mesmo assim abaixo */ }
  await atualizar();
  ev.target.disabled = false;
  ev.target.textContent = '🔍 Verificar agora';
});
document.getElementById('btn-desconectar').addEventListener('click', async (ev) => {
  if (!confirm('Desconectar do WhatsApp agora? Ninguém recebe avisos até você escanear o QR code de novo (ex.: amanhã de manhã) — o robô e esse painel continuam rodando.')) return;
  ev.target.disabled = true;
  ev.target.textContent = 'Desconectando...';
  try {
    const r = await fetch('/desconectar', { method: 'POST' });
    const s = await r.json();
    if (s.status === 'error') alert(s.message);
  } catch (e) { alert('Não consegui falar com o robô.'); }
  ev.target.disabled = false;
  ev.target.textContent = '🔌 Desconectar';
  await atualizar();
});
document.getElementById('btn-parar').addEventListener('click', async () => {
  if (!confirm('Parar o robô agora? Pra ligar de novo, use o atalho na Área de Trabalho.')) return;
  await fetch('/parar', { method: 'POST' }).catch(() => {});
  document.getElementById('banner').innerHTML = 'Robô parado. Pode fechar esta aba.';
});
atualizar();
setInterval(atualizar, 4000);

// A pedido: fechar (ou recarregar) essa aba para o robô — não fica mais
// rodando escondido sem ninguém olhando. sendBeacon é o jeito confiável de
// disparar isso durante o fechamento da página; um fetch normal aqui pode
// ser cancelado pelo navegador antes de completar.
window.addEventListener('pagehide', () => {
  navigator.sendBeacon('/parar');
});
</script>
</body>
</html>`;
}

// Corpo JSON de um POST (telefone/nome) — o servidor é um http puro, sem
// body-parser. Nunca rejeita: corpo ausente/inválido vira {} e quem chamar
// trata o campo faltando.
function lerCorpoJson(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
        });
    });
}

function iniciarPainel() {
    const server = createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(paginaPainel());
            return;
        }
        if (req.method === 'GET' && req.url === '/status') {
            // enviadoHoje já vem calculado da última atualizarPrevia (a cada
            // checagem ou "Verificar agora") — recalcular aqui exigiria a
            // lista completa de destinatários, que o /status não busca.
            atualizarContadoresHistorico();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(painelStatus));
            return;
        }
        if (req.method === 'POST' && req.url === '/verificar-agora') {
            try {
                await atualizarPrevia();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(painelStatus));
            } catch (err) {
                painelStatus.ultimoErro = err.message;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...painelStatus, erroChecagem: err.message }));
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/reparear') {
            try {
                await reparear();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(painelStatus));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: err.message }));
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/desconectar') {
            try {
                await desconectar();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(painelStatus));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: err.message }));
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/disparar') {
            try {
                const { telefone, categoria } = await lerCorpoJson(req);
                if (!telefone) throw new Error('telefone obrigatório.');
                if (!categoria || !CATEGORIAS_PENDENCIA.includes(categoria)) throw new Error('categoria inválida.');
                if (!sockAtual) throw new Error('WhatsApp não está conectado agora.');
                const { destinatarios } = await buscarPendencias();
                const dest = destinatarios.find((d) => d.telefone === telefone);
                if (!dest || contarItensCategoria(dest, categoria) === 0) throw new Error('Essa pessoa não tem pendência nessa categoria agora (pode já ter sido resolvida).');
                await enviarCategoriaDoDia(sockAtual, categoria, [dest]);
                await atualizarPrevia();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(painelStatus));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: err.message }));
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/pausar-pessoa') {
            try {
                const { telefone, nome } = await lerCorpoJson(req);
                if (!telefone) throw new Error('telefone obrigatório.');
                pausarPessoa(telefone, nome, 24);
                await atualizarPrevia();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(painelStatus));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: err.message }));
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/reativar-pessoa') {
            try {
                const { telefone } = await lerCorpoJson(req);
                if (!telefone) throw new Error('telefone obrigatório.');
                reativarPessoa(telefone);
                await atualizarPrevia();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(painelStatus));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: err.message }));
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/parar') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            console.log('Parando a pedido do painel...');
            try { if (existsSync(PID_FILE)) writeFileSync(PID_FILE, ''); } catch { /* não crítico */ }
            setTimeout(() => process.exit(0), 300);
            return;
        }
        res.writeHead(404);
        res.end('Not found');
    });
    server.listen(PORTA_PAINEL, () => {
        console.log(`Painel disponível em http://localhost:${PORTA_PAINEL}`);
    });
}

// Só cuida da conexão com o WhatsApp — chamada de novo a cada reconexão
// (normal: cai e reconecta sozinho de vez em quando). NÃO mexe em
// checar()/setInterval: isso fica de fora, configurado uma única vez lá
// embaixo — senão cada reconexão criava mais um setInterval por cima dos
// anteriores (nunca limpos), e depois de algumas reconexões várias
// checagens passavam a rodar em paralelo, arriscando mandar a mesma
// mensagem duas vezes pra todo mundo.
// Vendedor manda "pausar" (ou "voltar"/"reativar") no privado do próprio
// robô pra se auto-servir, sem precisar pedir pro admin — reaproveita
// pausarPessoa/reativarPessoa, os mesmos usados pelo botão "⏸️ 24h" do
// painel. Só responde a quem JÁ aparece na prévia de pendências (número
// conhecido, achado via telefone) e só a esses comandos exatos — não tenta
// interpretar texto livre (evita mal-entendido) nem responde grupo/status.
async function processarComandoRecebido(sock, msg) {
    if (msg.key.fromMe) return;
    const jid = msg.key.remoteJid || '';
    if (!jid.endsWith('@s.whatsapp.net')) return; // ignora grupo (@g.us), status, etc.
    const texto = String(msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().toLowerCase();
    if (texto !== 'pausar' && texto !== 'voltar' && texto !== 'reativar') return;

    const telefone = jid.replace('@s.whatsapp.net', '');
    const conhecido = (painelStatus.destinatariosPrevia || []).find((d) => d.telefone === telefone);
    if (!conhecido) return; // número que o robô não reconhece — ignora, não responde pra qualquer um

    if (texto === 'pausar') {
        pausarPessoa(telefone, conhecido.nome, 24);
        await sock.sendMessage(jid, { text: `⏸️ Combinado, *${primeiroNome(conhecido.nome)}*! Você não recebe avisos de pendência pelas próximas 24h.\n\nPra voltar antes, é só mandar *voltar*.` });
    } else {
        reativarPessoa(telefone);
        await sock.sendMessage(jid, { text: `▶️ Prontinho, *${primeiroNome(conhecido.nome)}*! Avisos de pendência reativados.` });
    }
}

async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            processarComandoRecebido(sock, msg).catch((err) => console.error('Falha ao processar comando recebido:', err.message));
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            painelStatus.aguardandoQr = true;
            painelStatus.sessaoEncerrada = false;
            console.log('\nEscaneie este QR code no WhatsApp (Aparelhos conectados > Conectar um aparelho) — ou abra o painel em http://localhost:3344, o QR aparece lá também:\n');
            qrcodeTerminal.generate(qr, { small: true });
            QRCode.toDataURL(qr, { width: 280, margin: 1 })
                .then((dataUrl) => { painelStatus.qrDataUrl = dataUrl; })
                .catch((err) => console.error('Falha ao gerar QR pro painel:', err.message));
        }
        if (connection === 'close') {
            painelStatus.conectado = false;
            sockAtual = null;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const deveReconectar = statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão caiu.', deveReconectar ? 'Reconectando...' : 'Sessão encerrada — apague a pasta auth_info/ e rode de novo pra reparear.');
            if (deveReconectar) {
                conectar();
            } else {
                // Sessão encerrada de verdade (ex.: aparelho removido pelo
                // celular) — reconectar com a MESMA credencial só repetiria
                // o mesmo erro pra sempre. Fica parado e visível no painel
                // (banner + botão "Reparear agora") até alguém confirmar.
                painelStatus.sessaoEncerrada = true;
            }
        } else if (connection === 'open') {
            sockAtual = sock;
            painelStatus.conectado = true;
            painelStatus.aguardandoQr = false;
            painelStatus.sessaoEncerrada = false;
            painelStatus.qrDataUrl = null;
            console.log('Conectado ao WhatsApp. Robô rodando — verificando a cada', INTERVALO_CHECAGEM_MIN, 'minuto(s).');
        }
    });
}

// Desconecta de propósito (botão "🔌 Desconectar" no painel) — pra quem
// prefere logar de manhã e desconectar à noite em vez de deixar vinculado
// o tempo todo. Diferente de "Parar robô": o processo Node (e o painel)
// continuam de pé, só a sessão do WhatsApp é encerrada de verdade
// (sock.logout() avisa o WhatsApp, que remove o aparelho vinculado — igual
// tirar manualmente em Aparelhos Conectados no celular). Cai no mesmo
// tratamento que já existe pra "sessão encerrada" (o close handler detecta
// loggedOut e NÃO tenta reconectar sozinho); pra religar de manhã, é só
// usar o mesmo botão "Reparear agora" que aparece nesse estado.
async function desconectar() {
    if (!sockAtual) throw new Error('Já não está conectado ao WhatsApp.');
    await sockAtual.logout();
}

// Apaga as credenciais antigas (já inválidas) e começa um pareamento do
// zero — equivalente ao que o README sempre pediu pra fazer manualmente
// (apagar auth_info/) quando a sessão é encerrada, só que com um clique no
// painel em vez de mexer em pasta/terminal.
async function reparear() {
    try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (err) { console.error('Falha ao apagar auth_info/:', err.message); }
    painelStatus.sessaoEncerrada = false;
    painelStatus.conectado = false;
    painelStatus.aguardandoQr = false;
    painelStatus.qrDataUrl = null;
    sockAtual = null;
    await conectar();
}

// Avisa ALERTA_TELEFONE (.env, opcional) quando a checagem falha
// repetidamente — não ajuda se o problema é a PRÓPRIA conexão do WhatsApp
// (não dá pra avisar pelo canal que caiu nesse caso; aí o jeito é olhar o
// painel), mas cobre os outros casos (API fora do ar, erro de código,
// etc.), onde sockAtual continua de pé. Debounced por 1h (ultimoAlertaErro
// em disco) pra não mandar o mesmo alerta de novo a cada checagem enquanto
// o problema persiste.
const LIMIAR_FALHAS_PARA_ALERTA = 3;
let falhasConsecutivas = 0;
async function avisarErroPersistenteSeNecessario(mensagemErro) {
    if (!ALERTA_TELEFONE || !sockAtual) return;
    const estado = lerEstado();
    const agora = Date.now();
    if (estado.ultimoAlertaErro && (agora - estado.ultimoAlertaErro) < 3600000) return;
    try {
        await sockAtual.sendMessage(`${ALERTA_TELEFONE}@s.whatsapp.net`, {
            text: `⚠️ *Robô de WhatsApp com problema*\n\nFalhando há ${falhasConsecutivas}+ checagens seguidas:\n${mensagemErro}\n\nConfira o painel: http://localhost:${PORTA_PAINEL}`
        });
        estado.ultimoAlertaErro = agora;
        salvarEstado(estado);
    } catch (err) {
        console.error('Falha ao mandar alerta de erro persistente:', err.message);
    }
}

// Lembrete por WhatsApp (pro próprio ALERTA_TELEFONE) de que tem categoria(s)
// esperando aprovação manual — só dispara enquanto whatsapp_aprovacao_manual
// estiver ligado em Admin E tiver algo pendente. Debounced por 1h (mesmo
// esquema de avisarErroPersistenteSeNecessario) pra não insistir a cada
// checagem enquanto ninguém aprova.
async function avisarAprovacaoPendenteSeNecessario(fila) {
    if (!ALERTA_TELEFONE || !sockAtual || !fila.length) return;
    const estado = lerEstado();
    const agora = Date.now();
    if (estado.ultimoAlertaAprovacao && (agora - estado.ultimoAlertaAprovacao) < 3600000) return;
    const linhas = fila.map((f) => `• ${CATEGORIA_DEFS[f.categoria]?.label || '🌙 Inatividade'} — ${f.pessoas} pessoa(s)`).join('\n');
    try {
        await sockAtual.sendMessage(`${ALERTA_TELEFONE}@s.whatsapp.net`, {
            text: `🔔 *Lembrete — aprovação manual ativa*\n\nTem categoria(s) esperando sua aprovação no painel:\n${linhas}\n\nAbra o painel e clique em "Agora" em cada card pra enviar.\nhttp://localhost:${PORTA_PAINEL}\n\n_Pra voltar ao envio automático, desligue "Aprovação manual" em Admin > Configurações._`
        });
        estado.ultimoAlertaAprovacao = agora;
        salvarEstado(estado);
    } catch (err) {
        console.error('Falha ao mandar lembrete de aprovação pendente:', err.message);
    }
}

// Sempre usa sockAtual (mantido certinho por connection.update acima) em vez
// de fechar sobre um "sock" específico — assim, depois de uma reconexão,
// nunca manda mensagem usando uma conexão antiga/morta.
//
// checagemEmAndamento trava reentrância: setInterval dispara no relógio sem
// esperar a checagem anterior terminar — se o envio pra muita gente demorar
// mais que INTERVALO_CHECAGEM_MIN (improvável com poucas dezenas de
// pessoas, mas não impossível conforme a lista cresce), sem essa trava duas
// checagens rodariam juntas e mandariam a mesma pendência duas vezes.
let checagemEmAndamento = false;
const checar = async () => {
    if (checagemEmAndamento) { console.log('Checagem anterior ainda em andamento — pulando esta.'); return; }
    checagemEmAndamento = true;
    try {
        // atualizarPrevia devolve TODOS os destinatários (não filtrados) +
        // pendentesPorCategoria (quem ainda falta em CADA categoria) —
        // decide aqui, categoria por categoria, se já passou da própria
        // hora configurada pra ela.
        const { pendentesPorCategoria, schedule, pausado, aprovacaoManual } = await atualizarPrevia();
        if (sockAtual) {
            if (!diaConfiguradoHoje(schedule.diasSemana)) {
                // dia da semana não configurado — nem pendência nem resumo saem hoje
            } else if (!pausado) {
                // Com aprovação manual ligada, NADA sai sozinho daqui — só
                // acumula pra lembrar o admin (fila abaixo); enviarCategoriaDoDia
                // só é chamado de verdade pelo botão "Agora" (rota /disparar).
                const filaAprovacao = [];
                for (const categoria of CATEGORIAS_PENDENCIA) {
                    if (schedule.ativos && schedule.ativos[categoria] === false) continue; // categoria desligada em Admin
                    const hora = schedule.horarios[categoria];
                    if (!passouDoHorario(hora)) continue; // ainda não chegou a vez dessa categoria
                    const pendentes = pendentesPorCategoria[categoria];
                    if (!pendentes || !pendentes.length) continue;
                    if (aprovacaoManual) filaAprovacao.push({ categoria, pessoas: pendentes.length });
                    else await enviarCategoriaDoDia(sockAtual, categoria, pendentes);
                }
                if (aprovacaoManual && filaAprovacao.length) await avisarAprovacaoPendenteSeNecessario(filaAprovacao);
            }
            // Resumo diário tem horário/pausa PRÓPRIOS, checados dentro dele
            // (buscarResumos() tem seu próprio schedule) — independente da
            // pausa de pendências acima.
            await enviarResumosDoDia(sockAtual);
        } else {
            console.log('Checagem adiada: WhatsApp ainda não está conectado.');
        }
        falhasConsecutivas = 0;
    } catch (err) {
        painelStatus.ultimoErro = err.message;
        console.error('Falha ao buscar/enviar pendências:', err.message);
        falhasConsecutivas++;
        if (falhasConsecutivas >= LIMIAR_FALHAS_PARA_ALERTA) await avisarErroPersistenteSeNecessario(err.message);
    } finally {
        checagemEmAndamento = false;
    }
};

iniciarPainel();
conectar();
checar(); // primeira checagem já na subida, sem esperar o 1º intervalo
setInterval(checar, INTERVALO_CHECAGEM_MIN * 60 * 1000);
