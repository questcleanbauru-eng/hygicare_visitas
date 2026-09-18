/**
 * Retransmissor de e-mail (resumo diário) via MailApp.
 *
 * NÃO faz parte do app (não é Node, não builda, não sobe pro Vercel) — é
 * um script do Google Apps Script, publicado como Web App. O backend do
 * app (Vercel) monta o e-mail inteiro (assunto + HTML) e só chama essa URL
 * pra mandar de verdade, usando o MailApp da conta Google que fizer o
 * deploy (cota do Gmail pessoal: 100 e-mails/dia — de sobra pra 1 resumo
 * por dia pra poucos destinatários).
 *
 * COMO INSTALAR
 * 1. Abra a planilha do App de Visitas no navegador.
 * 2. Extensões → Apps Script.
 * 3. Se já tiver outro script aqui (ex.: radar-geocoding-backfill), crie
 *    um ARQUIVO NOVO (ícone "+" ao lado de "Arquivos" → Script) — não
 *    apague o que já existe. Nomeie como "MailRelay" e cole este arquivo
 *    inteiro nele.
 * 4. SÓ NA PRIMEIRA VEZ: rode a função `configurarSegredo` (edite o
 *    segredo abaixo antes — invente uma senha longa qualquer, ex. uma
 *    frase aleatória). O segredo fica guardado no PROJETO (Script
 *    Properties), separado do código — colar uma versão nova do script
 *    depois nunca apaga isso.
 * 5. Deploy → Nova implantação → tipo "App da Web".
 *      - Executar como: Eu (sua conta)
 *      - Quem pode acessar: Qualquer pessoa
 *    Autorize as permissões pedidas (é o Google avisando que o script vai
 *    mandar e-mail em seu nome — normal, é exatamente o que queremos).
 * 6. Copie a URL gerada (termina em /exec) e me mande — eu configuro como
 *    MAIL_RELAY_URL no Vercel. Me mande também o mesmo segredo do passo 4
 *    (via um canal seguro, tipo aqui na conversa) pra eu configurar como
 *    MAIL_RELAY_SECRET.
 * 7. Se editar o script depois, use "Gerenciar implantações" → ✏️ → "Nova
 *    versão" (uma implantação nova geraria uma URL diferente).
 */

function configurarSegredo() {
    const SEGREDO = 'TROQUE_POR_UMA_SENHA_LONGA_AQUI';
    PropertiesService.getScriptProperties().setProperty('MAIL_RELAY_SECRET', SEGREDO);
}

function doPost(e) {
    try {
        const segredoEsperado = PropertiesService.getScriptProperties().getProperty('MAIL_RELAY_SECRET');
        const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

        if (!segredoEsperado || body.secret !== segredoEsperado) {
            return respond({ ok: false, error: 'unauthorized' });
        }
        if (!body.to || !body.subject || !body.html) {
            return respond({ ok: false, error: 'campos faltando (to/subject/html)' });
        }

        MailApp.sendEmail({
            to: body.to,
            subject: body.subject,
            htmlBody: body.html
        });
        return respond({ ok: true });
    } catch (err) {
        return respond({ ok: false, error: String(err) });
    }
}

function respond(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
