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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'estado-envio.json');
const AUTH_DIR = join(__dirname, 'auth_info');

const API_URL = process.env.API_URL;
const API_SECRET = process.env.API_SECRET;
const INTERVALO_CHECAGEM_MIN = Number(process.env.INTERVALO_CHECAGEM_MIN || 5);
const DELAY_ENTRE_ENVIOS_MS = Number(process.env.DELAY_ENTRE_ENVIOS_MS || 8000);
const PORTA_PAINEL = Number(process.env.PORTA_PAINEL || 3344);

if (!API_URL || !API_SECRET) {
    console.error('Faltou configurar API_URL/API_SECRET no .env — copie env.example para .env e preencha.');
    process.exit(1);
}

const logger = pino({ level: 'warn' });

// Status ao vivo pro painel (http://localhost:PORTA_PAINEL) — tela local
// simples com status + botão de parar, pra não precisar ficar lendo o
// terminal. O "iniciar" fica mesmo com o iniciar.bat (abre o processo); o
// painel só reflete o que já está rodando e permite encerrar.
const painelStatus = {
    conectado: false,
    aguardandoQr: false,
    ultimaChecagem: null,
    ultimoEnvio: null,
    ultimoErro: null,
    schedule: null,
    pausadoNoApp: false,
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
    for (const dest of destinatarios) {
        const jid = `${dest.telefone}@s.whatsapp.net`;
        const texto = montarMensagem(dest.nome, dest.pendencias);
        try {
            await sock.sendMessage(jid, { text: texto });
            console.log(`  ✓ ${dest.nome} (${dest.telefone})`);
        } catch (err) {
            console.error(`  ✗ ${dest.nome} (${dest.telefone}):`, err.message);
        }
        // Espera entre envios + variação aleatória, pra não parecer disparo
        // em massa (gatilho comum de bloqueio).
        const jitter = DELAY_ENTRE_ENVIOS_MS * 0.5 * Math.random();
        await sleep(DELAY_ENTRE_ENVIOS_MS + jitter);
    }
    const estado = lerEstado();
    estado.ultimoEnvio = hojeChaveLocal();
    salvarEstado(estado);
    painelStatus.ultimoEnvio = new Date().toISOString();
    console.log('Envio do dia concluído.');
}

// Busca pendências e atualiza o painel (prévia), sem nunca mandar nada —
// usado tanto pela checagem automática quanto pelo botão "Verificar agora".
async function atualizarPrevia() {
    painelStatus.ultimaChecagem = new Date().toISOString();
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
<title>Robô de WhatsApp — App de Visitas</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; max-width: 480px; margin: 2.5rem auto; padding: 0 1.2rem; background: #0b1220; color: #e6e9ef; }
  h1 { font-size: 1.2rem; margin: 0 0 1.2rem; }
  .card { background: #131c2e; border: 1px solid #253249; border-radius: 12px; padding: 1.1rem 1.2rem; margin-bottom: 1rem; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0; border-bottom: 1px solid #1d2a40; font-size: 0.88rem; }
  .row:last-child { border-bottom: none; }
  .row span:first-child { color: #93a1bb; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 999px; margin-right: 6px; }
  .on { background: #22c55e; } .off { background: #ef4444; } .warn { background: #f59e0b; }
  button { width: 100%; padding: 0.75rem; border: none; border-radius: 10px; font-size: 0.9rem; font-weight: 600; cursor: pointer; background: #ef4444; color: #fff; }
  button:hover { opacity: 0.9; }
  button.secundario { background: #2563eb; margin-bottom: 0.6rem; }
  .hint { font-size: 0.78rem; color: #6b7a99; margin-top: 0.6rem; text-align: center; }
  .previa-item { padding: 0.55rem 0; border-bottom: 1px solid #1d2a40; }
  .previa-item:last-child { border-bottom: none; }
  .previa-nome { font-weight: 600; font-size: 0.88rem; }
  .previa-lista { margin: 0.25rem 0 0; padding-left: 1.1rem; font-size: 0.78rem; color: #93a1bb; }
  .vazio { font-size: 0.85rem; color: #6b7a99; text-align: center; padding: 0.4rem 0; }
</style>
</head>
<body>
  <h1>📱 Robô de WhatsApp — App de Visitas</h1>
  <div class="card" id="status-card">Carregando...</div>
  <div class="card">
    <div class="row" style="border:none;padding-bottom:0.6rem">
      <span>📋 Quem receberia agora</span>
      <span id="previa-janela"></span>
    </div>
    <div id="previa-lista"></div>
  </div>
  <div class="card">
    <button class="secundario" id="btn-verificar">🔍 Verificar agora</button>
    <button id="btn-parar">⏹ Parar robô</button>
    <p class="hint">"Verificar agora" só confere e mostra — não manda nada. O envio de verdade só acontece dentro da janela configurada no Admin.</p>
  </div>
<script>
function renderPrevia(s) {
  const janelaOk = s.dentroDaJanelaAgora ? '🟢 dentro da janela agora' : '🟡 fora da janela agora';
  document.getElementById('previa-janela').textContent = janelaOk;
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
      <div class="previa-nome">\${d.nome} <span style="color:#6b7a99;font-weight:400">(\${d.telefone})</span></div>
      <ul class="previa-lista">\${d.pendencias.slice(0, 5).map((p) => \`<li>\${p.cliente} — venceu \${p.dataAgendada} (\${p.diasAtraso}d)</li>\`).join('')}\${d.pendencias.length > 5 ? '<li>…e mais ' + (d.pendencias.length - 5) + '</li>' : ''}</ul>
    </div>
  \`).join('');
}

async function atualizar() {
  try {
    const r = await fetch('/status');
    const s = await r.json();
    const dot = s.conectado ? 'on' : (s.aguardandoQr ? 'warn' : 'off');
    const linhaConexao = s.aguardandoQr
      ? 'Aguardando escanear QR code (veja o terminal)'
      : (s.conectado ? 'Conectado' : 'Desconectado');
    document.getElementById('status-card').innerHTML = \`
      <div class="row"><span>Conexão</span><span><span class="dot \${dot}"></span>\${linhaConexao}</span></div>
      <div class="row"><span>Pausado no app</span><span>\${s.pausadoNoApp ? '⏸️ Sim' : 'Não'}</span></div>
      <div class="row"><span>Janela de envio</span><span>\${s.schedule ? s.schedule.horaInicio + '–' + s.schedule.horaLimite : '—'}</span></div>
      <div class="row"><span>Última checagem</span><span>\${s.ultimaChecagem ? new Date(s.ultimaChecagem).toLocaleTimeString('pt-BR') : '—'}</span></div>
      <div class="row"><span>Último envio</span><span>\${s.ultimoEnvio ? new Date(s.ultimoEnvio).toLocaleString('pt-BR') : 'Nenhum ainda'}</span></div>
      \${s.ultimoErro ? '<div class="row"><span>Último erro</span><span style="color:#f87171">' + s.ultimoErro + '</span></div>' : ''}
    \`;
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
  if (!confirm('Parar o robô agora? Pra ligar de novo, roda o iniciar.bat.')) return;
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
            console.log('\nEscaneie este QR code no WhatsApp (Aparelhos conectados > Conectar um aparelho):\n');
            qrcode.generate(qr, { small: true });
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
            console.log('Conectado ao WhatsApp. Robô rodando — verificando a cada', INTERVALO_CHECAGEM_MIN, 'minuto(s).');
        }
    });

    setInterval(async () => {
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
    }, INTERVALO_CHECAGEM_MIN * 60 * 1000);
}

iniciarPainel();
iniciar();
