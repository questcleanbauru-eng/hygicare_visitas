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
    dentroDaJanelaAgora: false
};

function lerEstado() {
    if (!existsSync(STATE_FILE)) return { ultimoEnvio: '' };
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return { ultimoEnvio: '' }; }
}
function salvarEstado(estado) {
    writeFileSync(STATE_FILE, JSON.stringify(estado, null, 2));
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
function dentroDaJanela(schedule) {
    if (!schedule.diasSemana.includes(diaDaSemanaLocal())) return false;
    const agora = horaAgoraLocal();
    return agora >= schedule.horaInicio && agora <= schedule.horaLimite;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function montarMensagem(nome, pendencias) {
    const linhas = pendencias
        .slice(0, 15)
        .map((p) => `• ${p.cliente} — venceu ${p.dataAgendada} (${p.diasAtraso}d atrás)`)
        .join('\n');
    const extra = pendencias.length > 15 ? `\n…e mais ${pendencias.length - 15}.` : '';
    return `📋 *Pendências de hoje* — ${nome}\n\n🔴 Agendamentos vencidos (${pendencias.length}):\n${linhas}${extra}\n\nBom trabalho! 💪\n_App de Visitas_`;
}

async function buscarPendencias() {
    const res = await fetch(API_URL, { headers: { Authorization: `Bearer ${API_SECRET}` } });
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || 'Erro desconhecido na API.');
    // schedule sempre vem preenchido (mesmo pausado) — default aqui é só
    // uma rede de segurança caso a API esteja numa versão antiga.
    const schedule = json.schedule || { horaInicio: '08:00', horaLimite: '18:00', diasSemana: [1, 2, 3, 4, 5] };
    return { destinatarios: json.data || [], schedule, pausado: !!json.pausado };
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
        const texto = montarMensagem(dest.nome, dest.pendencias);
        try {
            await sock.sendMessage(jid, { text: texto });
            console.log(`  ✓ ${dest.nome} (${dest.telefone})`);
            sucessos++;
        } catch (err) {
            console.error(`  ✗ ${dest.nome} (${dest.telefone}):`, err.message);
            falhas++;
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
    const { destinatarios, schedule, pausado } = await buscarPendencias();
    painelStatus.schedule = schedule;
    painelStatus.pausadoNoApp = pausado;
    painelStatus.destinatariosPrevia = destinatarios;
    painelStatus.dentroDaJanelaAgora = dentroDaJanela(schedule);
    painelStatus.ultimoErro = null;
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
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif;
    max-width: 520px; margin: 0 auto; padding: 2rem 1.2rem 3rem;
    background: radial-gradient(1200px 600px at 50% -10%, #152036 0%, #0a0f1c 55%, #080c16 100%);
    color: #e7eaf2; min-height: 100vh;
  }
  header { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 1.4rem; }
  header .icon { font-size: 1.6rem; }
  header h1 { font-size: 1.15rem; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
  header p { margin: 0.1rem 0 0; font-size: 0.78rem; color: #7c8aad; }

  .badge-conexao {
    display: inline-flex; align-items: center; gap: 0.4rem;
    padding: 0.3rem 0.7rem; border-radius: 999px; font-size: 0.78rem; font-weight: 700;
    letter-spacing: 0.02em; text-transform: uppercase;
  }
  .badge-conexao.on { background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); }
  .badge-conexao.off { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
  .badge-conexao.warn { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; background: currentColor; }

  .card {
    background: linear-gradient(180deg, #131b2c 0%, #101726 100%);
    border: 1px solid #22304a; border-radius: 16px; padding: 1.25rem 1.3rem;
    margin-bottom: 1rem; box-shadow: 0 8px 24px -12px rgba(0,0,0,0.5);
  }
  .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.9rem; }
  .card-title { font-size: 0.82rem; font-weight: 700; color: #c3cbdd; text-transform: uppercase; letter-spacing: 0.04em; }

  .countdown { text-align: center; padding: 0.4rem 0 1rem; }
  .countdown .num { font-size: 2rem; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .countdown .label { font-size: 0.76rem; color: #7c8aad; margin-top: 0.15rem; }

  .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  .stat { background: #0d1522; border: 1px solid #1d2a40; border-radius: 10px; padding: 0.6rem 0.75rem; }
  .stat .k { font-size: 0.7rem; color: #7c8aad; margin-bottom: 0.2rem; }
  .stat .v { font-size: 0.85rem; font-weight: 600; }
  .stat .v.err { color: #f87171; font-weight: 500; font-size: 0.76rem; }

  .pill { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.74rem; font-weight: 700; padding: 0.2rem 0.55rem; border-radius: 999px; }
  .pill.on { background: rgba(34,197,94,0.15); color: #4ade80; }
  .pill.off { background: rgba(245,158,11,0.15); color: #fbbf24; }

  .previa-item { padding: 0.6rem 0; border-bottom: 1px solid #1d2a40; }
  .previa-item:last-child { border-bottom: none; }
  .previa-nome { font-weight: 700; font-size: 0.88rem; }
  .previa-tel { color: #7c8aad; font-weight: 400; font-size: 0.78rem; }
  .previa-lista { margin: 0.3rem 0 0; padding-left: 1.1rem; font-size: 0.78rem; color: #a5afc9; line-height: 1.5; }
  .vazio { font-size: 0.85rem; color: #7c8aad; text-align: center; padding: 0.6rem 0; }

  button {
    width: 100%; padding: 0.8rem; border: none; border-radius: 12px;
    font-size: 0.9rem; font-weight: 700; cursor: pointer; transition: transform 0.1s, opacity 0.15s;
  }
  button:active { transform: scale(0.98); }
  button:disabled { opacity: 0.6; cursor: default; }
  .btn-primario { background: linear-gradient(180deg, #3b82f6, #2563eb); color: #fff; margin-bottom: 0.6rem; }
  .btn-perigo { background: linear-gradient(180deg, #ef4444, #dc2626); color: #fff; }
  button:hover:not(:disabled) { opacity: 0.92; }
  .hint { font-size: 0.74rem; color: #64719396; color: #6b7a99; margin-top: 0.7rem; text-align: center; line-height: 1.5; }
</style>
</head>
<body>
  <header>
    <span class="icon">📱</span>
    <div>
      <h1>Robô de WhatsApp</h1>
      <p>Avisos de pendência — App de Visitas</p>
    </div>
  </header>

  <div class="card" id="status-card">Carregando...</div>

  <div class="card" id="qr-card" style="display:none;text-align:center">
    <span class="card-title">📷 Escaneie pra conectar</span>
    <p class="hint" style="margin-top:0.3rem">WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho</p>
    <img id="qr-img" style="width:100%;max-width:280px;border-radius:10px;margin-top:0.6rem" alt="QR code de pareamento">
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">📋 Quem receberia agora</span>
      <span id="previa-janela"></span>
    </div>
    <div id="previa-lista"></div>
  </div>

  <div class="card">
    <button class="btn-primario" id="btn-verificar">🔍 Verificar agora</button>
    <button class="btn-perigo" id="btn-parar">⏹ Parar robô</button>
    <p class="hint">"Verificar agora" só confere e mostra — não manda nada. O envio de verdade só acontece dentro da janela configurada no Admin. Pra ligar de novo depois de parar, use o atalho na Área de Trabalho.</p>
  </div>

<script>
let proximaChecagemMs = null;

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
  if (proximaChecagemMs === null) { el.textContent = '--:--'; return; }
  el.textContent = formatCountdown(proximaChecagemMs - Date.now());
}
setInterval(tickCountdown, 1000);

function renderPrevia(s) {
  const janelaCls = s.dentroDaJanelaAgora ? 'on' : 'off';
  const janelaTxt = s.dentroDaJanelaAgora ? '🟢 dentro da janela' : '🟡 fora da janela';
  document.getElementById('previa-janela').innerHTML = '<span class="pill ' + janelaCls + '">' + janelaTxt + '</span>';
  const lista = s.destinatariosPrevia || [];
  if (s.pausadoNoApp) {
    document.getElementById('previa-lista').innerHTML = '<p class="vazio">⏸️ Pausado em Admin &gt; Configurações — ninguém recebe enquanto isso.</p>';
    return;
  }
  if (!lista.length) {
    document.getElementById('previa-lista').innerHTML = '<p class="vazio">Ninguém com pendência no momento.</p>';
    return;
  }
  document.getElementById('previa-lista').innerHTML = lista.map((d) => \`
    <div class="previa-item">
      <div class="previa-nome">\${d.nome} <span class="previa-tel">(\${d.telefone})</span></div>
      <ul class="previa-lista">\${d.pendencias.slice(0, 5).map((p) => \`<li>\${p.cliente} — venceu \${p.dataAgendada} (\${p.diasAtraso}d)</li>\`).join('')}\${d.pendencias.length > 5 ? '<li>…e mais ' + (d.pendencias.length - 5) + '</li>' : ''}</ul>
    </div>
  \`).join('');
}

async function atualizar() {
  try {
    const r = await fetch('/status');
    const s = await r.json();
    const dot = s.conectado ? 'on' : (s.aguardandoQr ? 'warn' : 'off');
    const linhaConexao = s.aguardandoQr ? 'Aguardando pareamento' : (s.conectado ? 'Conectado' : 'Desconectado');
    proximaChecagemMs = s.proximaChecagemPrevista ? new Date(s.proximaChecagemPrevista).getTime() : null;

    const qrCard = document.getElementById('qr-card');
    if (s.aguardandoQr && s.qrDataUrl) {
      qrCard.style.display = 'block';
      document.getElementById('qr-img').src = s.qrDataUrl;
    } else {
      qrCard.style.display = 'none';
    }

    const subtitulo = s.enviadoHoje
      ? '✅ Já enviado hoje'
      : (s.pausadoNoApp ? '⏸️ Pausado' : (s.dentroDaJanelaAgora ? 'Próxima checagem em' : 'Fora da janela — próxima checagem em'));

    document.getElementById('status-card').innerHTML = \`
      <div class="card-head" style="margin-bottom:0.2rem">
        <span class="card-title">Status</span>
        <span class="badge-conexao \${dot}"><span class="dot"></span>\${linhaConexao}</span>
      </div>
      <div class="countdown">
        <div class="num" id="countdown-num">--:--</div>
        <div class="label">\${subtitulo}</div>
      </div>
      <div class="stats-grid">
        <div class="stat"><div class="k">Janela de envio</div><div class="v">\${s.schedule ? s.schedule.horaInicio + '–' + s.schedule.horaLimite : '—'}</div></div>
        <div class="stat"><div class="k">Pausado no app</div><div class="v">\${s.pausadoNoApp ? '⏸️ Sim' : '✅ Não'}</div></div>
        <div class="stat"><div class="k">Última checagem</div><div class="v">\${s.ultimaChecagem ? new Date(s.ultimaChecagem).toLocaleTimeString('pt-BR') : '—'}</div></div>
        <div class="stat"><div class="k">Último envio</div><div class="v">\${s.ultimoEnvio ? new Date(s.ultimoEnvio).toLocaleString('pt-BR') : 'Nenhum ainda'}</div></div>
        \${s.ultimoErro ? '<div class="stat" style="grid-column:1/-1"><div class="k">Último erro</div><div class="v err">' + s.ultimoErro + '</div></div>' : ''}
      </div>
    \`;
    tickCountdown();
    renderPrevia(s);
  } catch (e) {
    document.getElementById('status-card').innerHTML = '<span style="color:#f87171">Não consegui falar com o robô — ele ainda está rodando?</span>';
  }
}
document.getElementById('btn-verificar').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  ev.target.textContent = 'Verificando...';
  await fetch('/verificar-agora', { method: 'POST' }).catch(() => {});
  await atualizar();
  ev.target.disabled = false;
  ev.target.textContent = '🔍 Verificar agora';
});
document.getElementById('btn-parar').addEventListener('click', async () => {
  if (!confirm('Parar o robô agora? Pra ligar de novo, use o atalho na Área de Trabalho.')) return;
  await fetch('/parar', { method: 'POST' }).catch(() => {});
  document.getElementById('status-card').innerHTML = 'Robô parado. Pode fechar esta aba.';
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
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const deveReconectar = statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão caiu.', deveReconectar ? 'Reconectando...' : 'Sessão encerrada — apague a pasta auth_info/ e rode de novo pra reparear.');
            if (deveReconectar) iniciar();
        } else if (connection === 'open') {
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
