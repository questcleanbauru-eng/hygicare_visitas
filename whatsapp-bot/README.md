# Robô de avisos por WhatsApp

Roda **local, no seu computador** — não faz parte do deploy na Vercel (não
dá pra manter uma conexão de WhatsApp viva numa função serverless). Todo
dia útil, dentro da janela de horário configurada, busca no App de Visitas
quem tem agendamento vencido e manda um aviso por WhatsApp pra cada um.

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

Os outros campos (`HORA_INICIO`, `HORA_LIMITE`, etc.) já vêm com um padrão
razoável — ajuste se quiser.

## 3. Primeira execução (parear o número)

```
npm start
```

Vai aparecer um **QR code no terminal**. No celular com o número separado:
WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho →
escaneie o QR. Depois disso o robô fica conectado sozinho — não precisa
repetir esse passo (a menos que fique muito tempo sem rodar).

## 4. Deixar rodando

O robô fica checando a cada alguns minutos (`INTERVALO_CHECAGEM_MIN`) se:
- é dia útil (segunda a sexta)
- está dentro da janela `HORA_INICIO`–`HORA_LIMITE`
- ainda não enviou hoje

Se tudo bater, busca as pendências e manda, com um intervalo entre cada
mensagem (pra não parecer disparo em massa). Se o computador estiver
desligado na hora programada, ele manda assim que for ligado de novo,
contanto que ainda esteja dentro da janela do mesmo dia.

Pra deixar sempre ativo, basta deixar este terminal aberto (ou configurar
pra iniciar com o Windows, se quiser — não obrigatório).

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
