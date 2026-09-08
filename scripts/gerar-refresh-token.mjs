// Configura o upload de arquivos no Google Drive (fotos da Manutenção,
// PDFs de Contrato). Gera o refresh token E cria as duas pastas de
// destino, já imprimindo tudo pronto pra colar na Vercel.
//
// Pré-requisitos (uma vez, no Google Cloud Console — projeto hygicare-visitas):
//   1. APIs e serviços > Biblioteca > ativar "Google Drive API".
//   2. APIs e serviços > Tela de permissão OAuth:
//        - Tipo: Externo
//        - Preencher nome do app + e-mails
//        - Em "Usuários de teste", adicionar questcleanbauru@gmail.com
//        - PUBLICAR o app ("Em produção"). Pode ignorar o aviso de
//          verificação — com escopo drive.file não trava, e sem publicar
//          o refresh token expiraria em 7 dias.
//   3. APIs e serviços > Credenciais > Criar credenciais >
//        ID do cliente OAuth > tipo "App para computador".
//        Anote o Client ID e o Client Secret.
//
// Uso (na pasta do projeto):
//   node scripts/gerar-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//
// Faça login com questcleanbauru@gmail.com, aprove (tela "app não
// verificado" > Avançado > Acessar), e copie o bloco que aparece aqui
// pras Environment Variables da Vercel (Production and Preview).

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
    scope: ['https://www.googleapis.com/auth/drive.file']
});

async function createFolder(token, name) {
    const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!res.ok) throw new Error(`Falha ao criar pasta "${name}": ${res.status} ${await res.text()}`);
    return (await res.json()).id;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);
    const code = url.searchParams.get('code');
    if (!code) { res.writeHead(400); res.end('Sem code.'); return; }
    try {
        const { tokens } = await oauth.getToken(code);
        if (!tokens.refresh_token) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>Não veio refresh_token. Revogue o acesso em myaccount.google.com/permissions e rode de novo.</h2>');
            console.error('\nNÃO veio refresh_token. Remova o acesso do app em');
            console.error('https://myaccount.google.com/permissions e rode de novo.\n');
            process.exit(1);
        }
        oauth.setCredentials(tokens);
        const accessToken = tokens.access_token;

        console.log('\nCriando as pastas no Drive...');
        const fotosId = await createFolder(accessToken, 'App de Visitas - Fotos Manutencao');
        const contratosId = await createFolder(accessToken, 'App de Visitas - Contratos');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Pronto! Pode fechar esta aba e voltar pro terminal.</h2>');

        console.log('\n==================  COLE NA VERCEL  ==================\n');
        console.log('GOOGLE_OAUTH_CLIENT_ID');
        console.log(clientId);
        console.log('\nGOOGLE_OAUTH_CLIENT_SECRET');
        console.log(clientSecret);
        console.log('\nGOOGLE_OAUTH_REFRESH_TOKEN');
        console.log(tokens.refresh_token);
        console.log('\nDRIVE_FOTOS_MANUTENCAO_FOLDER_ID');
        console.log(fotosId);
        console.log('\nDRIVE_CONTRATOS_FOLDER_ID');
        console.log(contratosId);
        console.log('\n=====================================================');
        console.log('As pastas aparecem em "Meu Drive" da conta questcleanbauru.');
        console.log('Pode movê-las pra onde quiser no Drive (não quebra nada).');
        console.log('Depois de salvar as 5 vars, faça Redeploy na Vercel.\n');
        server.close();
        process.exit(0);
    } catch (e) {
        res.writeHead(500); res.end('Erro: ' + e.message);
        console.error(e);
        process.exit(1);
    }
});

server.listen(PORT, () => {
    console.log('\nAbra esta URL no navegador (logado como questcleanbauru@gmail.com):\n');
    console.log(authUrl);
    console.log('\nAguardando o retorno do Google...\n');
});
