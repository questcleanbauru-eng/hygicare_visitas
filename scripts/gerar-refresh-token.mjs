// Gera o GOOGLE_OAUTH_REFRESH_TOKEN pro upload de arquivos no Drive.
//
// Pré-requisitos:
//   1. Google Cloud Console > APIs e serviços > Credenciais
//      > Criar credenciais > ID do cliente OAuth > tipo "App para computador"
//      (Desktop app). Anote o Client ID e o Client Secret.
//   2. Tela de consentimento OAuth configurada e o app PUBLICADO
//      ("Em produção") — senão o refresh token expira em 7 dias.
//   3. Google Drive API ativada no projeto.
//
// Uso (na pasta do projeto):
//   node scripts/gerar-refresh-token.mjs SEU_CLIENT_ID SEU_CLIENT_SECRET
//
// Vai abrir uma URL: faça login com a conta DONA das pastas
// (questcleanbauru@gmail.com), aprove o acesso, e o token aparece aqui.

import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
    console.error('Uso: node scripts/gerar-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>');
    process.exit(1);
}

const PORT = 5599;
const redirectUri = `http://localhost:${PORT}`;
const oauth = new OAuth2Client(clientId, clientSecret, redirectUri);

const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive']
});

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);
    const code = url.searchParams.get('code');
    if (!code) { res.writeHead(400); res.end('Sem code.'); return; }
    try {
        const { tokens } = await oauth.getToken(code);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Pronto! Pode fechar esta aba e voltar pro terminal.</h2>');
        console.log('\n============================================================');
        if (tokens.refresh_token) {
            console.log('GOOGLE_OAUTH_REFRESH_TOKEN=');
            console.log(tokens.refresh_token);
        } else {
            console.log('NÃO veio refresh_token. Remova o acesso do app em');
            console.log('https://myaccount.google.com/permissions e rode de novo.');
        }
        console.log('============================================================\n');
        server.close();
        process.exit(0);
    } catch (e) {
        res.writeHead(500); res.end('Erro: ' + e.message);
        console.error(e);
        process.exit(1);
    }
});

server.listen(PORT, () => {
    console.log('\nAbra esta URL no navegador (logado como a conta dona das pastas):\n');
    console.log(authUrl);
    console.log('\nAguardando o retorno do Google...\n');
});
