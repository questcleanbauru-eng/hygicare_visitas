# Robô de avisos por WhatsApp

Roda **local, no seu computador** — não faz parte do deploy na Vercel (não
dá pra manter uma conexão de WhatsApp viva numa função serverless). Nos
dias e horário configurados **dentro do próprio app** (Admin >
Configurações), busca quem tem agendamento vencido e manda um aviso por
WhatsApp pra cada um.

Usa um número de WhatsApp **separado** (não o seu pessoal) — ver aviso de
risco mais abaixo.

## 1. Preparar o número

1. Tenha um chip/número que ainda não tenha WhatsApp nele (pode ser aquele
   "só de dados" que você mencionou, desde que receba SMS/ligação).
2. Não precisa instalar o WhatsApp nesse celular — a conexão é feita
   escaneando o QR code que este robô mostra no terminal.

## 2. Instalar

Precisa de **Node.js 20 ou mais novo** instalado no computador.

```
cd whatsapp-bot
npm install
cp env.example .env
```

Abra o `.env` e preencha:
- `API_URL` — a URL do endpoint no App de Visitas (ex.:
  `https://SEU-DOMINIO.vercel.app/api/pendencias-whatsapp`)
- `API_SECRET` — precisa ser **o mesmo valor** cadastrado na env var
  `WHATSAPP_PENDENCIAS_SECRET` do projeto na Vercel (peça pra quem tem
  acesso ao painel da Vercel gerar uma chave aleatória e configurar lá)

O intervalo de checagem e o ritmo de envio (`INTERVALO_CHECAGEM_MIN`,
`DELAY_ENTRE_ENVIOS_MS`) já vêm com um padrão razoável — ajuste se quiser.
**Horário e dias da semana não ficam aqui**: são configurados dentro do
app, em Admin > Configurações > "Avisos de pendência por WhatsApp" — o
robô lê isso a cada checagem, então mudar lá já vale na próxima.

## 3. Primeira execução (parear o número)

Use o `iniciar.bat` (duplo clique, ou `npm start` direto se preferir pelo
terminal):

```
npm start
```

Vai aparecer um **QR code no terminal**. No celular com o número separado:
WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho →
escaneie o QR. Depois disso o robô fica conectado sozinho — não precisa
repetir esse passo (a menos que fique muito tempo sem rodar).

## 4. Deixar rodando

O robô fica checando a cada alguns minutos (`INTERVALO_CHECAGEM_MIN`) se,
segundo o que está configurado no Admin:
- hoje é um dos dias marcados pra envio
- está dentro da janela de horário
- ainda não enviou hoje
- o envio não está pausado

Se tudo bater, busca as pendências e manda, com um intervalo entre cada
mensagem (pra não parecer disparo em massa). Se o computador estiver
desligado na hora programada, ele manda assim que for ligado de novo,
contanto que ainda esteja dentro da janela do mesmo dia.

Pra iniciar/parar fácil (sem abrir terminal), use `iniciar.bat` e
`parar.bat` nesta pasta — dois cliques e pronto. Pra deixar sempre ativo,
é só deixar a janela que o `iniciar.bat` abre aberta (ou configurar pra
iniciar com o Windows, se quiser — não obrigatório).

## ⚠️ Sobre o risco

Isso usa uma biblioteca (Baileys) que conecta como um "aparelho vinculado"
comum — não é a API oficial da Meta. Funciona bem pra uso interno, baixo
volume (seu time), mas tecnicamente não é um método endossado pelo
WhatsApp, e existe risco (pequeno, nesse volume) de o número levar alguma
restrição. Por isso: **número separado**, nunca o pessoal nem o de
contato com cliente.

## Arquivos que este robô cria (e não deve subir pro Git)

- `auth_info/` — guarda a sessão conectada (tão sensível quanto uma senha)
- `estado-envio.json` — só controla se já mandou hoje
- `.env` — sua chave de API

Todos já estão no `.gitignore` desta pasta.
