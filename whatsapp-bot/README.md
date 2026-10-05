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
   escaneando um QR code, que aparece **no painel** (http://localhost:3344)
   assim que o robô precisar parear.

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

Dê duplo clique em `iniciar.bat` (ou no atalho "Robô WhatsApp - Iniciar"
na Área de Trabalho, se já tiver um). Ele instala as dependências na
primeira vez, sobe o robô **escondido** (sem janela de terminal) e abre
o painel sozinho.

No painel, assim que o robô precisar parear, aparece um card **"📷
Escaneie pra conectar"** com o QR code. No celular com o número separado:
WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho →
escaneie o QR ali na tela. Depois disso o robô fica conectado sozinho —
não precisa repetir esse passo (a menos que fique muito tempo sem rodar
ou a sessão seja desconectada no celular).

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

O robô roda sem janela de terminal visível — acompanhe tudo pelo painel
(`http://localhost:3344`): conexão, contagem regressiva pra próxima
checagem, janela de envio, se está pausado no app, e uma lista "Quem
receberia agora" (nome + telefone + pendências de cada um, atualizada a
cada checagem). O botão "🔍 Verificar agora" força uma checagem na hora,
só pra conferir — nunca manda nada sozinho. Se algo der errado, o log
técnico completo fica em `robo.log`, nesta pasta.

O painel tem um botão "⏹ Parar robô" — clicar nele encerra o processo por
completo; pra ligar de novo, use o atalho na Área de Trabalho (ou
`iniciar.bat`). `parar.bat` faz a mesma coisa, caso o painel não abra por
algum motivo.

Pra deixar sempre ativo, não precisa fazer nada especial — ele já roda em
segundo plano sem depender de nenhuma janela aberta (só o computador
ligado). Se quiser que suba sozinho ao ligar o Windows, dá pra colocar um
atalho do `iniciar.bat` na pasta de Inicialização do Windows — não
obrigatório.

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
- `bot.pid` — PID do processo rodando, usado pelo `parar.bat`
- `robo.log` — log técnico (console.log/erros), útil se algo der errado
- `.env` — sua chave de API

Todos já estão no `.gitignore` desta pasta.
