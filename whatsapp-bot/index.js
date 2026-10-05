// Robô local de avisos por WhatsApp — roda no seu computador (não na
// Vercel, que não mantém conexão viva o suficiente pra isso), de segunda a
// sexta, dentro da janela de horário configurada em .env. Busca as
// pendências (agendamentos vencidos) de cada vendedor no App de Visitas e
// manda uma mensagem pra cada um que tiver telefone cadastrado.
//
// Usa um número de WhatsApp separado (não o pessoal) — ver README.md pra
// como configurar. Primeira vez: escaneia o QR code que aparece aqui no
// terminal (Configurações > Aparelhos conectados > Conectar um aparelho).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'estado-envio.json');
const AUTH_DIR = join(__dirname, 'auth_info');

const API_URL = process.env.API_URL;
const API_SECRET = process.env.API_SECRET;
const HORA_INICIO = process.env.HORA_INICIO || '08:00';
const HORA_LIMITE = process.env.HORA_LIMITE || '18:00';
const INTERVALO_CHECAGEM_MIN = Number(process.env.INTERVALO_CHECAGEM_MIN || 5);
const DELAY_ENTRE_ENVIOS_MS = Number(process.env.DELAY_ENTRE_ENVIOS_MS || 8000);

if (!API_URL || !API_SECRET) {
    console.error('Faltou configurar API_URL/API_SECRET no .env — copie .env.example para .env e preencha.');
    process.exit(1);
}

const logger = pino({ level: 'warn' });

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
    // 0 = domingo ... 6 = sábado
    const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[s];
}

function dentroDaJanela() {
    const dia = diaDaSemanaLocal();
    if (dia === 0 || dia === 6) return false; // fim de semana, não manda
    const agora = horaAgoraLocal();
    return agora >= HORA_INICIO && agora <= HORA_LIMITE;
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
    return json.data;
}

async function enviarPendenciasDoDia(sock) {
    console.log('Buscando pendências...');
    const destinatarios = await buscarPendencias();
    if (!destinatarios.length) {
        console.log('Ninguém com pendência hoje — nada a enviar.');
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
    console.log('Envio do dia concluído.');
}

async function iniciar() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\nEscaneie este QR code no WhatsApp (Aparelhos conectados > Conectar um aparelho):\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const deveReconectar = statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão caiu.', deveReconectar ? 'Reconectando...' : 'Sessão encerrada — apague a pasta auth_info/ e rode de novo pra reparear.');
            if (deveReconectar) iniciar();
        } else if (connection === 'open') {
            console.log('Conectado ao WhatsApp. Robô rodando — verificando a cada', INTERVALO_CHECAGEM_MIN, 'minuto(s).');
        }
    });

    setInterval(async () => {
        if (!dentroDaJanela()) return;
        const estado = lerEstado();
        if (estado.ultimoEnvio === hojeChaveLocal()) return; // já mandou hoje
        try {
            await enviarPendenciasDoDia(sock);
        } catch (err) {
            console.error('Falha ao buscar/enviar pendências:', err.message);
        }
    }, INTERVALO_CHECAGEM_MIN * 60 * 1000);
}

iniciar();
