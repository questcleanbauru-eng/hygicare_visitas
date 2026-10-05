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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const INTERVALO_CHECAGEM_MIN = Number(process.env.INTERVALO_CHECAGEM_MIN || 5);
const DELAY_ENTRE_ENVIOS_MS = Number(process.env.DELAY_ENTRE_ENVIOS_MS || 8000);
const PORTA_PAINEL = Number(process.env.PORTA_PAINEL || 3344);

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
    ultimaChecagem: null,
    proximaChecagemPrevista: null,
    intervaloChecagemMin: INTERVALO_CHECAGEM_MIN,
    ultimoEnvio: null,
    ultimoErro: null,
    schedule: null,
    pausadoNoApp: false,
    enviadoHoje: false,
    // Prévia: quem receberia SE o envio acontecesse agora — atualizado a
    // cada checagem (ou no botão "Verificar agora"), nunca dispara envio
    // de verdade sozinho.
    destinatariosPrevia: [],
    // Quem tem pendência mas não tem WhatsApp cadastrado — não recebe
    // nada, só aparece como aviso pro admin cadastrar o telefone.
    semTelefonePrevia: [],
    dentroDaJanelaAgora: false,
    historico: [],
    enviosHoje: 0,
    enviosSemana: 0
};

function lerEstado() {
    if (!existsSync(STATE_FILE)) return { ultimoEnvio: '', historico: [] };
    try {
        const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        if (!Array.isArray(parsed.historico)) parsed.historico = [];
        return parsed;
    } catch { return { ultimoEnvio: '', historico: [] }; }
}
function salvarEstado(estado) {
    writeFileSync(STATE_FILE, JSON.stringify(estado, null, 2));
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

// schedule vem da API (Admin > Configurações no app) — ver buscarPendencias.
// O "fim" da janela não é um limite rígido — é só a referência "normal"
// mostrada no painel. Se o computador ficar desligado durante toda a
// janela, o robô manda assim que ligar (mesmo depois do horário de fim),
// contanto que ainda seja hoje e já tenha passado do horário de início —
// sem isso, um dia inteiro passava sem avisar ninguém só porque o PC
// ligou às 19h num dia configurado até 18h.
function dentroDaJanela(schedule) {
    if (!schedule.diasSemana.includes(diaDaSemanaLocal())) return false;
    return horaAgoraLocal() >= schedule.horaInicio;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Monta uma lista "• item (até 10, com '…e mais N.' se passar disso)".
function listaComLimite(itens, formatar, limite = 10) {
    const linhas = itens.slice(0, limite).map((i) => `• ${formatar(i)}`).join('\n');
    const extra = itens.length > limite ? `\n…e mais ${itens.length - limite}.` : '';
    return linhas + extra;
}

function totalPendencias(dest) {
    return dest.agendamentos.length + dest.propostas.length + dest.funil.length + dest.campanhas.length + (dest.diasSemAtividade ? 1 : 0);
}

// Uma mensagem só, com uma seção por tipo de pendência — só entram as
// seções que o destinatário realmente tem.
function montarMensagem(dest) {
    const partes = [`📋 *Pendências de hoje* — ${dest.nome}`];
    if (dest.agendamentos.length) {
        partes.push(`🔴 Agendamentos vencidos (${dest.agendamentos.length}):\n` + listaComLimite(dest.agendamentos, (p) => `${p.cliente} — venceu ${p.dataAgendada} (${p.diasAtraso}d atrás)`));
    }
    if (dest.propostas.length) {
        partes.push(`📄 Propostas paradas (${dest.propostas.length}):\n` + listaComLimite(dest.propostas, (p) => `${p.cliente} — sem atualização há ${p.diasParada}d`));
    }
    if (dest.funil.length) {
        partes.push(`📊 Funil parado (${dest.funil.length}):\n` + listaComLimite(dest.funil, (f) => `${f.cliente} — sem atualização há ${f.diasParado}d`));
    }
    if (dest.campanhas.length) {
        partes.push(`📣 Campanhas aguardando resposta (${dest.campanhas.length}):\n` + listaComLimite(dest.campanhas, (c) => `${c.titulo} — ${c.pendentes} cliente(s) pendente(s)`));
    }
    if (dest.diasSemAtividade) {
        partes.push(`⏰ Já fazem ${dest.diasSemAtividade} dias desde sua última visita/prospecção registrada — *favor atualizar o aplicativo!*`);
    }
    partes.push('Bom trabalho! 💪\n_App de Visitas_');
    return partes.join('\n\n');
}

async function buscarPendencias() {
    const res = await fetch(API_URL, { headers: { Authorization: `Bearer ${API_SECRET}` } });
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || 'Erro desconhecido na API.');
    // schedule sempre vem preenchido (mesmo pausado) — default aqui é só
    // uma rede de segurança caso a API esteja numa versão antiga.
    const schedule = json.schedule || { horaInicio: '08:00', horaLimite: '18:00', diasSemana: [1, 2, 3, 4, 5] };
    return { destinatarios: json.data || [], semTelefone: json.semTelefone || [], schedule, pausado: !!json.pausado, teste: json.teste || null };
}

// Conexão ativa, pra funções fora de iniciar() (tipo /verificar-agora via
// HTTP) conseguirem mandar o teste sem precisar passar sock por todo lado.
let sockAtual = null;
let ultimoTesteProcessado = 0;

// Botão "🧪 Enviar teste" em Admin > Configurações grava um pedido na
// planilha; o robô vê isso em toda checagem e manda na hora, IGNORANDO
// pausa/janela (o objetivo é só confirmar que a mensagem chega). Controla
// localmente qual pedido já processou (por timestamp) pra não reenviar o
// mesmo teste a cada checagem.
async function processarTesteSeNecessario(teste) {
    if (!teste || !teste.quando || teste.quando <= ultimoTesteProcessado) return;
    ultimoTesteProcessado = teste.quando;
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

async function enviarPendenciasDoDia(sock, destinatarios) {
    if (!destinatarios.length) {
        console.log('Ninguém com pendência agora — nada a enviar.');
        return;
    }
    console.log(`Enviando para ${destinatarios.length} pessoa(s)...`);
    let sucessos = 0;
    let falhas = 0;
    for (const dest of destinatarios) {
        const jid = `${dest.telefone}@s.whatsapp.net`;
        const texto = montarMensagem(dest);
        try {
            await sock.sendMessage(jid, { text: texto });
            console.log(`  ✓ ${dest.nome} (${dest.telefone})`);
            sucessos++;
            registrarHistorico({ nome: dest.nome, telefone: dest.telefone, status: 'ok', pendencias: totalPendencias(dest), quando: new Date().toISOString() });
        } catch (err) {
            console.error(`  ✗ ${dest.nome} (${dest.telefone}):`, err.message);
            falhas++;
            registrarHistorico({ nome: dest.nome, telefone: dest.telefone, status: 'erro', detalhe: err.message, quando: new Date().toISOString() });
        }
        // Espera entre envios + variação aleatória, pra não parecer disparo
        // em massa (gatilho comum de bloqueio).
        const jitter = DELAY_ENTRE_ENVIOS_MS * 0.5 * Math.random();
        await sleep(DELAY_ENTRE_ENVIOS_MS + jitter);
    }
    // Só marca o dia como "enviado" se pelo menos uma mensagem realmente
    // saiu — antes marcava sempre, então uma falha total (ex.: conexão
    // ainda instabilizando logo após parear) travava o dia inteiro sem
    // nunca re-tentar, com o painel mostrando "já enviado" mesmo sem ter
    // enviado nada de verdade.
    if (sucessos > 0) {
        const estado = lerEstado();
        estado.ultimoEnvio = hojeChaveLocal();
        salvarEstado(estado);
        painelStatus.ultimoEnvio = new Date().toISOString();
        painelStatus.enviadoHoje = true;
    }
    if (falhas > 0) {
        painelStatus.ultimoErro = `${falhas} de ${destinatarios.length} mensagem(ns) falharam ao enviar — vai tentar de novo na próxima checagem.`;
    }
    console.log(`Envio concluído: ${sucessos} ok, ${falhas} falha(s).`);
}

// Busca pendências e atualiza o painel (prévia), sem nunca mandar nada —
// usado tanto pela checagem automática quanto pelo botão "Verificar agora".
async function atualizarPrevia() {
    const agora = Date.now();
    painelStatus.ultimaChecagem = new Date(agora).toISOString();
    painelStatus.proximaChecagemPrevista = new Date(agora + INTERVALO_CHECAGEM_MIN * 60 * 1000).toISOString();
    painelStatus.enviadoHoje = lerEstado().ultimoEnvio === hojeChaveLocal();
    const { destinatarios, semTelefone, schedule, pausado, teste } = await buscarPendencias();
    painelStatus.schedule = schedule;
    painelStatus.pausadoNoApp = pausado;
    painelStatus.destinatariosPrevia = destinatarios;
    painelStatus.semTelefonePrevia = semTelefone;
    painelStatus.dentroDaJanelaAgora = dentroDaJanela(schedule);
    painelStatus.ultimoErro = null;
    atualizarContadoresHistorico();
    await processarTesteSeNecessario(teste);
    return { destinatarios, schedule, pausado };
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
    max-width: 980px; margin: 0 auto; padding: 2rem 1.3rem 3rem;
    background: #f6f7fa; color: #0f172a; min-height: 100vh;
  }
  header { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1.4rem; }
  header .icon-box {
    width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    font-size: 1.3rem; background: #dcfce7;
  }
  header h1 { font-size: 1.25rem; margin: 0; font-weight: 800; letter-spacing: -0.01em; }
  header p { margin: 0.1rem 0 0; font-size: 0.82rem; color: #64748b; }

  .hero {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
    background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 16px;
    padding: 1.1rem 1.4rem; margin-bottom: 1.1rem;
  }
  .hero-left { display: flex; align-items: center; gap: 0.8rem; }
  .hero-dot { width: 12px; height: 12px; border-radius: 999px; background: #22c55e; flex-shrink: 0; box-shadow: 0 0 0 4px rgba(34,197,94,0.18); }
  .hero-dot.off { background: #ef4444; box-shadow: 0 0 0 4px rgba(239,68,68,0.15); }
  .hero-title { font-size: 1.1rem; font-weight: 800; color: #065f46; margin: 0; }
  .hero-sub { font-size: 0.82rem; color: #047857; margin: 0.1rem 0 0; }
  .hero-right { text-align: right; }
  .hero-num { font-size: 1.6rem; font-weight: 800; color: #065f46; line-height: 1; }
  .hero-num-label { font-size: 0.74rem; color: #047857; margin-top: 0.15rem; }

  .grid { display: grid; grid-template-columns: 1fr; gap: 1.1rem; }
  @media (min-width: 860px) { .grid { grid-template-columns: 1fr 1fr; } }
  .col { display: flex; flex-direction: column; gap: 1.1rem; }

  .card {
    background: #ffffff; border: 1px solid #e5e9f0; border-radius: 16px; padding: 1.25rem 1.3rem;
    box-shadow: 0 1px 3px rgba(15,23,42,0.04);
  }
  .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 0.5rem; flex-wrap: wrap; }
  .card-title { display: flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }

  .badge { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.65rem; border-radius: 999px; font-size: 0.76rem; font-weight: 700; }
  .badge.on { background: #dcfce7; color: #15803d; }
  .badge.off { background: #fee2e2; color: #b91c1c; }
  .badge.warn { background: #fef3c7; color: #92400e; }
  .badge.muted { background: #f1f5f9; color: #475569; }
  .dot-sm { width: 7px; height: 7px; border-radius: 999px; background: currentColor; }

  .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  .stat { background: #f8fafc; border: 1px solid #eef2f7; border-radius: 10px; padding: 0.65rem 0.8rem; }
  .stat .k { font-size: 0.72rem; color: #64748b; margin-bottom: 0.2rem; }
  .stat .v { font-size: 0.9rem; font-weight: 700; color: #0f172a; }
  .stat .v.ok { color: #16a34a; }
  .stat .v.err { color: #dc2626; font-weight: 600; font-size: 0.78rem; }

  button {
    width: 100%; padding: 0.85rem; border-radius: 12px; font-size: 0.9rem; font-weight: 700;
    cursor: pointer; transition: transform 0.1s, opacity 0.15s, background 0.15s;
  }
  button:active { transform: scale(0.98); }
  button:disabled { opacity: 0.55; cursor: default; }
  .btn-primario { background: #2563eb; color: #fff; border: none; }
  .btn-primario:hover:not(:disabled) { background: #1d4ed8; }
  .btn-perigo-outline { background: #fff; color: #dc2626; border: 1.5px solid #fecaca; margin-top: 0.7rem; }
  .btn-perigo-outline:hover:not(:disabled) { background: #fef2f2; }
  .feedback-ok { font-size: 0.82rem; color: #16a34a; font-weight: 600; text-align: center; margin: 0.6rem 0 0; }
  .hint { font-size: 0.76rem; color: #94a3b8; margin-top: 0.5rem; text-align: center; line-height: 1.5; }

  .avatar { width: 36px; height: 36px; border-radius: 999px; background: #dbeafe; color: #1d4ed8; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 0.82rem; flex-shrink: 0; }
  .dest-item { padding: 0.9rem 0; border-bottom: 1px solid #eef2f7; }
  .dest-item:first-child { padding-top: 0; }
  .dest-item:last-child { border-bottom: none; padding-bottom: 0; }
  .dest-head { display: flex; align-items: center; gap: 0.65rem; margin-bottom: 0.6rem; }
  .dest-nome { font-weight: 700; font-size: 0.9rem; color: #0f172a; }
  .dest-tel { font-size: 0.76rem; color: #64748b; margin-top: 0.1rem; }
  .pend-row {
    display: flex; justify-content: space-between; align-items: center; gap: 0.6rem;
    background: #f8fafc; border: 1px solid #eef2f7; border-radius: 10px; padding: 0.55rem 0.75rem; margin-top: 0.45rem;
  }
  .pend-cliente { font-size: 0.84rem; font-weight: 600; color: #0f172a; }
  .pend-venceu { font-size: 0.74rem; color: #64748b; margin-top: 0.1rem; }
  .pend-atraso { flex-shrink: 0; font-size: 0.74rem; font-weight: 700; padding: 0.2rem 0.55rem; border-radius: 999px; background: #fef3c7; color: #92400e; white-space: nowrap; }
  .cat-label { font-size: 0.72rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.02em; margin: 0.7rem 0 0; }
  .cat-label:first-of-type { margin-top: 0.1rem; }

  .kanban-wrap { display: flex; gap: 0.8rem; overflow-x: auto; padding-bottom: 0.3rem; margin: 0 -0.1rem; }
  .kanban-col { flex: 0 0 230px; background: #f8fafc; border: 1px solid #eef2f7; border-radius: 12px; padding: 0.7rem; display: flex; flex-direction: column; gap: 0.5rem; max-height: 440px; }
  .kanban-col-head { display: flex; justify-content: space-between; align-items: center; gap: 0.4rem; font-size: 0.78rem; font-weight: 800; color: #475569; padding: 0 0.1rem; }
  .kanban-count { flex-shrink: 0; background: #e2e8f0; color: #475569; font-size: 0.7rem; font-weight: 800; padding: 0.1rem 0.5rem; border-radius: 999px; }
  .kanban-cards { display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto; }
  .kanban-card { background: #fff; border: 1px solid #e5e9f0; border-radius: 10px; padding: 0.6rem 0.7rem; }
  .kanban-card-top { display: flex; justify-content: space-between; align-items: center; gap: 0.4rem; }
  .kanban-card-nome { font-size: 0.82rem; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kanban-card-badge { flex-shrink: 0; font-size: 0.72rem; font-weight: 800; background: #dbeafe; color: #1d4ed8; padding: 0.1rem 0.5rem; border-radius: 999px; }
  .kanban-card-badge.warn { background: #fef3c7; color: #92400e; }
  .kanban-card-detalhe { font-size: 0.74rem; color: #64748b; margin-top: 0.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kanban-card-flag { font-size: 0.68rem; color: #b45309; margin-top: 0.3rem; font-weight: 700; }
  .kanban-vazio { font-size: 0.78rem; color: #94a3b8; text-align: center; padding: 1rem 0; }

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
  </header>

  <div class="hero" id="hero">Carregando...</div>

  <div class="card" id="qr-card" style="display:none;text-align:center;margin-bottom:1.1rem">
    <span class="card-title" style="justify-content:center">📷 Escaneie pra conectar</span>
    <p class="hint">WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho</p>
    <img id="qr-img" alt="QR code de pareamento">
  </div>

  <div class="card" style="margin-bottom:1.1rem">
    <div class="card-head">
      <span class="card-title">📋 Pendências por tipo</span>
      <span class="badge muted" id="badge-proximo-envio">—</span>
    </div>
    <div class="kanban-wrap" id="kanban-board">—</div>
  </div>

  <div class="grid">
    <div class="col">
      <div class="card">
        <div class="card-head">
          <span class="card-title">⚡ Status</span>
          <span class="badge" id="badge-conexao">—</span>
        </div>
        <div class="stats-grid" id="status-stats">—</div>
      </div>

      <div class="card">
        <button class="btn-primario" id="btn-verificar">🔍 Verificar agora</button>
        <p class="feedback-ok" id="feedback-verificar" style="display:none"></p>
        <p class="hint">"Verificar agora" só confere as pendências — nenhuma mensagem é enviada. O envio de verdade só acontece dentro da janela configurada no Admin.</p>
        <button class="btn-perigo-outline" id="btn-parar">⏹ Parar robô</button>
      </div>
    </div>

    <div class="col">
      <div class="card">
        <div class="card-head">
          <span class="card-title">🕒 Últimos envios</span>
        </div>
        <div id="historico-lista"></div>
      </div>
    </div>
  </div>

<script>
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

function proximoEnvioLabel(s) {
  if (!s.schedule) return '—';
  if (s.pausadoNoApp) return 'pausado';
  const agora = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  if (s.enviadoHoje) return 'amanhã, ' + s.schedule.horaInicio;
  if (agora < s.schedule.horaInicio) return 'hoje, ' + s.schedule.horaInicio;
  if (agora > s.schedule.horaLimite) return 'amanhã, ' + s.schedule.horaInicio;
  return 'em instantes';
}

function renderHero(s) {
  const funcionando = s.conectado && !s.pausadoNoApp;
  const titulo = s.pausadoNoApp ? '⏸️ Pausado' : (s.conectado ? 'Funcionando' : 'Desconectado');
  const enviouTxt = s.ultimoEnvio ? ('Enviou hoje às ' + formatHora(s.ultimoEnvio)) : 'Ainda não enviou hoje';
  document.getElementById('hero').innerHTML = \`
    <div class="hero-left">
      <span class="hero-dot \${funcionando ? '' : 'off'}"></span>
      <div>
        <p class="hero-title">\${titulo}</p>
        <p class="hero-sub">\${enviouTxt} · Próximo envio \${proximoEnvioLabel(s)}</p>
      </div>
    </div>
    <div class="hero-right">
      <div class="hero-num">\${s.enviosHoje || 0}</div>
      <div class="hero-num-label">mensagem\${s.enviosHoje === 1 ? '' : 's'} hoje · \${s.enviosSemana || 0} na semana</div>
    </div>
  \`;
}

function renderStatus(s) {
  const dot = s.conectado ? 'on' : (s.aguardandoQr ? 'warn' : 'off');
  const linhaConexao = s.aguardandoQr ? 'Aguardando pareamento' : (s.conectado ? 'Conectado' : 'Desconectado');
  document.getElementById('badge-conexao').className = 'badge ' + dot;
  document.getElementById('badge-conexao').innerHTML = '<span class="dot-sm"></span>' + linhaConexao;

  document.getElementById('status-stats').innerHTML = \`
    <div class="stat"><div class="k">Envio no app</div><div class="v \${s.pausadoNoApp ? '' : 'ok'}">\${s.pausadoNoApp ? '⏸️ Pausado' : '✅ Ativo'}</div></div>
    <div class="stat"><div class="k">Janela de envio</div><div class="v">\${s.schedule ? s.schedule.horaInicio + ' – ' + s.schedule.horaLimite : '—'}</div></div>
    <div class="stat"><div class="k">Última checagem</div><div class="v">\${s.ultimaChecagem ? formatHora(s.ultimaChecagem) : '—'}</div></div>
    <div class="stat"><div class="k">Próxima checagem em</div><div class="v" id="countdown-num">--:--</div></div>
    \${s.ultimoErro ? '<div class="stat" style="grid-column:1/-1"><div class="k">Último erro</div><div class="v err">' + s.ultimoErro + '</div></div>' : ''}
  \`;
}

// Pendências organizadas em colunas por TIPO (estilo kanban) em vez de
// agrupadas por pessoa — com números grandes (uma pessoa pode acumular
// várias dezenas), fica muito mais fácil ver de relance onde está o
// maior volume do que rolando uma lista comprida por pessoa.
const KANBAN_DEFS = [
  { key: 'agendamentos', label: '🔴 Agendamentos', getItens: (d) => d.agendamentos, detalhe: (p) => p.cliente },
  { key: 'propostas', label: '📄 Propostas', getItens: (d) => d.propostas, detalhe: (p) => p.cliente },
  { key: 'funil', label: '📊 Funil', getItens: (d) => d.funil, detalhe: (f) => f.cliente },
  { key: 'campanhas', label: '📣 Campanhas', getItens: (d) => d.campanhas, detalhe: (c) => c.titulo }
];

function montarColunasKanban(s) {
  const todos = [
    ...(s.destinatariosPrevia || []).map((d) => Object.assign({ temTelefone: true }, d)),
    ...(s.semTelefonePrevia || []).map((d) => Object.assign({ temTelefone: false }, d))
  ];
  const cols = KANBAN_DEFS.map(({ key, label, getItens, detalhe }) => ({
    key, label,
    cards: todos
      .filter((d) => getItens(d) && getItens(d).length)
      .map((d) => ({ nome: d.nome, temTelefone: d.temTelefone, count: getItens(d).length, detalhe: detalhe(getItens(d)[0]) + (getItens(d).length > 1 ? ' +' + (getItens(d).length - 1) : '') }))
      .sort((a, b) => b.count - a.count)
  }));
  cols.push({
    key: 'inatividade', label: '⏰ Inatividade',
    cards: todos.filter((d) => d.diasSemAtividade)
      .map((d) => ({ nome: d.nome, temTelefone: d.temTelefone, count: 1, detalhe: 'há ' + d.diasSemAtividade + ' dias' }))
      .sort((a, b) => b.count - a.count)
  });
  return cols;
}

function renderKanban(s) {
  const badge = document.getElementById('badge-proximo-envio');
  badge.textContent = 'Próximo envio: ' + proximoEnvioLabel(s);
  const board = document.getElementById('kanban-board');
  if (s.pausadoNoApp) { board.innerHTML = '<p class="vazio">⏸️ Pausado em Admin &gt; Configurações — ninguém recebe enquanto isso.</p>'; return; }
  const semTelCount = (s.semTelefonePrevia || []).length;
  const cols = montarColunasKanban(s);
  if (!cols.some((c) => c.cards.length)) {
    board.innerHTML = s.enviadoHoje
      ? '<p class="vazio">✅ Já enviado hoje. Nada de novo desde então.</p>'
      : '<p class="vazio">Ninguém com pendência no momento.</p>';
    return;
  }
  board.innerHTML = cols.map((c) => \`
    <div class="kanban-col">
      <div class="kanban-col-head"><span>\${c.label}</span><span class="kanban-count">\${c.cards.length}</span></div>
      <div class="kanban-cards">
        \${c.cards.length ? c.cards.map((card) => \`
          <div class="kanban-card">
            <div class="kanban-card-top">
              <span class="kanban-card-nome">\${card.nome}</span>
              <span class="kanban-card-badge \${card.temTelefone ? '' : 'warn'}">\${card.count}</span>
            </div>
            <div class="kanban-card-detalhe">\${card.detalhe}</div>
            \${!card.temTelefone ? '<div class="kanban-card-flag">📵 sem WhatsApp</div>' : ''}
          </div>
        \`).join('') : '<p class="kanban-vazio">Nada aqui</p>'}
      </div>
    </div>
  \`).join('') + (semTelCount ? \`
    <div class="kanban-col" style="background:#fffbeb;border-color:#fde68a">
      <div class="kanban-col-head"><span>⚠️ Sem WhatsApp</span><span class="kanban-count" style="background:#fef3c7;color:#92400e">\${semTelCount}</span></div>
      <p class="hint" style="margin:0;text-align:left">Cadastre o WhatsApp dessas pessoas em Admin &gt; Usuários pra elas passarem a receber.</p>
      <div class="kanban-cards">
        \${(s.semTelefonePrevia || []).map((d) => {
          const total = (d.agendamentos?.length || 0) + (d.propostas?.length || 0) + (d.funil?.length || 0) + (d.campanhas?.length || 0) + (d.diasSemAtividade ? 1 : 0);
          return \`<div class="kanban-card"><div class="kanban-card-top"><span class="kanban-card-nome">\${d.nome}</span><span class="kanban-card-badge warn">\${total}</span></div></div>\`;
        }).join('')}
      </div>
    </div>
  \` : '');
}

function renderHistorico(s) {
  const el = document.getElementById('historico-lista');
  const hist = s.historico || [];
  if (!hist.length) { el.innerHTML = '<p class="vazio">Nenhum envio ainda.</p>'; return; }
  el.innerHTML = hist.map((h) => \`
    <div class="hist-item">
      <div class="hist-left">
        <span class="hist-icon \${h.status}">\${h.status === 'ok' ? '✓' : '✕'}</span>
        <span class="hist-nome">\${h.nome} <span class="det \${h.status === 'erro' ? 'err' : ''}">· \${h.status === 'ok' ? (h.pendencias + ' pendência' + (h.pendencias === 1 ? '' : 's')) : ('falhou (' + (h.detalhe || 'erro') + ')')}</span></span>
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

    renderHero(s);
    renderStatus(s);
    tickCountdown();
    renderKanban(s);
    renderHistorico(s);
  } catch (e) {
    document.getElementById('hero').innerHTML = '<span style="color:#dc2626">Não consegui falar com o robô — ele ainda está rodando?</span>';
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
document.getElementById('btn-parar').addEventListener('click', async () => {
  if (!confirm('Parar o robô agora? Pra ligar de novo, use o atalho na Área de Trabalho.')) return;
  await fetch('/parar', { method: 'POST' }).catch(() => {});
  document.getElementById('hero').innerHTML = 'Robô parado. Pode fechar esta aba.';
});
atualizar();
setInterval(atualizar, 4000);
</script>
</body>
</html>`;
}

function iniciarPainel() {
    const server = createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(paginaPainel());
            return;
        }
        if (req.method === 'GET' && req.url === '/status') {
            painelStatus.enviadoHoje = lerEstado().ultimoEnvio === hojeChaveLocal();
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

async function iniciar() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            painelStatus.aguardandoQr = true;
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
            if (deveReconectar) iniciar();
        } else if (connection === 'open') {
            sockAtual = sock;
            painelStatus.conectado = true;
            painelStatus.aguardandoQr = false;
            painelStatus.qrDataUrl = null;
            console.log('Conectado ao WhatsApp. Robô rodando — verificando a cada', INTERVALO_CHECAGEM_MIN, 'minuto(s).');
        }
    });

    const checar = async () => {
        const estado = lerEstado();
        if (estado.ultimoEnvio === hojeChaveLocal()) {
            // Já mandou hoje — ainda atualiza a prévia pro painel mostrar o
            // que ESTARIA pendente agora, só não envia de novo.
            try { await atualizarPrevia(); } catch (err) { painelStatus.ultimoErro = err.message; }
            return;
        }
        try {
            const { destinatarios, schedule, pausado } = await atualizarPrevia();
            if (pausado) return; // pausado em Admin > Configurações
            if (!dentroDaJanela(schedule)) return; // fora do horário/dias configurados
            await enviarPendenciasDoDia(sock, destinatarios);
        } catch (err) {
            painelStatus.ultimoErro = err.message;
            console.error('Falha ao buscar/enviar pendências:', err.message);
        }
    };

    checar(); // primeira checagem já na subida, sem esperar o 1º intervalo
    setInterval(checar, INTERVALO_CHECAGEM_MIN * 60 * 1000);
}

iniciarPainel();
iniciar();
