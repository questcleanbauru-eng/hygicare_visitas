/**
 * Backfill de geocodificação por empresa (RadarClientes) via CNPJá.
 *
 * NÃO faz parte do app (não é Node, não builda, não sobe pro Vercel) — é
 * um script do Google Apps Script, roda direto na planilha. Só está aqui
 * no repositório por registro/histórico.
 *
 * COMO INSTALAR
 * 1. Abra a planilha do App de Visitas no navegador.
 * 2. Extensões → Apps Script.
 * 3. Apague o conteúdo padrão de Code.gs e cole este arquivo inteiro.
 * 4. Rode `configurarChaveApi` uma vez (edite a linha da chave antes) —
 *    guarda a chave da CNPJá fora do corpo visível do script.
 * 5. Rode `testarUmaEmpresa` — confere se a chave/autenticação estão
 *    certas usando o CNPJ que já apareceu no print que você me mandou
 *    (Banco do Brasil, Manaus — devia devolver lat -3.079897, lng
 *    -60.026557). Se der erro 401/403, o formato do header de
 *    autenticação abaixo (ver AUTH_HEADER) provavelmente está errado —
 *    confere na "Referência da API" da CNPJá.
 * 6. Só depois de validar o passo 5, rode `iniciarBackfillGeocodificacao`.
 *    Processa em lotes de ~5min (limite do Apps Script é 6min por
 *    execução) e se reagenda sozinho via trigger até acabar; você pode
 *    fechar a aba, não precisa ficar olhando.
 *
 * COMO FUNCIONA A RETOMADA
 * Cada linha da planilha guarda seu próprio estado nas colunas
 * Latitude/Longitude (criadas automaticamente se não existirem):
 *   - vazio       → ainda não tentou
 *   - número      → geocodificado com sucesso
 *   - "sem_coordenada" → a CNPJá respondeu mas não tinha coordenada pra
 *     esse endereço (não tenta de novo sozinho — evita gastar crédito à
 *     toa numa empresa que provavelmente vai continuar sem coordenada)
 * Erro de rede/API (ex.: instabilidade, rate limit) NÃO marca a linha —
 * ela fica vazia e entra de novo na próxima passada, automaticamente.
 * Rodar o backfill de novo mais tarde (ex.: depois de importar CSV novo)
 * só processa quem ainda está vazio — nunca gasta crédito de novo em
 * quem já tem coordenada ou já foi marcado sem_coordenada.
 *
 * CUSTO
 * 1 crédito da CNPJá por linha nova processada (sucesso ou
 * sem_coordenada — a chamada já foi feita de qualquer jeito). Confira o
 * "Erro(s)" do log de execução (Execuções, na barra lateral do editor) —
 * eles não custam crédito de novo até darem certo.
 */

// ===== CONFIGURAÇÃO =====
const SHEET_NAME = 'RadarClientes';
const BATCH_TIME_LIMIT_MS = 5 * 60 * 1000; // folga dentro do limite de 6min do Apps Script
const DELAY_BETWEEN_CALLS_MS = 300; // ~3,3 chamadas/seg — aumente se a CNPJá devolver erro de rate limit
const TRIGGER_HANDLER = 'processarLote_';

// Formato do header de autenticação — CONFERIR na "Referência da API" da
// CNPJá antes de rodar o backfill de verdade (testarUmaEmpresa serve
// exatamente pra isso). Chute inicial: header "Authorization" com o
// token puro, sem prefixo "Bearer".
function montarHeaderAuth_(chave) {
    return { 'Authorization': chave };
}

// ===== SETUP (rodar uma vez) =====

function configurarChaveApi() {
    const chave = 'COLE_SUA_CHAVE_DA_CNPJA_AQUI'; // edite antes de rodar
    PropertiesService.getScriptProperties().setProperty('CNPJA_API_KEY', chave);
    Logger.log('Chave salva. Pode apagar a linha acima com a chave em texto puro se quiser.');
}

function testarUmaEmpresa() {
    const resultado = buscarGeocodificacao_('07526557011659'); // Banco do Brasil, Manaus — CNPJ do print
    Logger.log(JSON.stringify(resultado));
}

// ===== BACKFILL =====

function iniciarBackfillGeocodificacao() {
    garantirColunas_();
    processarLote_();
}

function processarLote_() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Aba "' + SHEET_NAME + '" não encontrada nesta planilha.');

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idx = mapearColunas_(headers);
    if (idx.cnpj === -1 || idx.latitude === -1 || idx.longitude === -1) {
        throw new Error('Colunas Cnpj/Latitude/Longitude não encontradas — rode garantirColunas_ primeiro (iniciarBackfillGeocodificacao já faz isso).');
    }

    const startTime = Date.now();
    let cortadoPeloTempo = false;
    let processados = 0, comCoordenada = 0, semCoordenada = 0, erros = 0;

    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        const cnpj = String(row[idx.cnpj] || '').replace(/\D/g, '');
        const valorLat = row[idx.latitude];
        const jaProcessado = valorLat !== '' && valorLat !== null;
        if (!cnpj || jaProcessado) continue;

        if (Date.now() - startTime > BATCH_TIME_LIMIT_MS) { cortadoPeloTempo = true; break; }

        processados++;
        try {
            const resultado = buscarGeocodificacao_(cnpj);
            if (resultado) {
                sheet.getRange(r + 1, idx.latitude + 1).setValue(resultado.lat);
                sheet.getRange(r + 1, idx.longitude + 1).setValue(resultado.lng);
                comCoordenada++;
            } else {
                sheet.getRange(r + 1, idx.latitude + 1).setValue('sem_coordenada');
                semCoordenada++;
            }
        } catch (e) {
            Logger.log('Erro no CNPJ ' + cnpj + ' (linha ' + (r + 1) + '): ' + e.message);
            erros++;
        }
        Utilities.sleep(DELAY_BETWEEN_CALLS_MS);
    }

    Logger.log('Lote: ' + processados + ' processados — ' + comCoordenada + ' com coordenada, ' +
        semCoordenada + ' sem coordenada, ' + erros + ' erro(s) (serão retentados no próximo lote).');

    if (cortadoPeloTempo) {
        garantirTrigger_();
    } else {
        // Passou pela planilha inteira nessa passada sem precisar cortar
        // pelo tempo — não sobrou nenhuma linha pendente.
        removerTrigger_();
        Logger.log('Backfill concluído — nenhuma linha pendente restante.');
    }
}

function buscarGeocodificacao_(cnpj) {
    const chave = PropertiesService.getScriptProperties().getProperty('CNPJA_API_KEY');
    if (!chave) throw new Error('Chave da CNPJá não configurada — rode configurarChaveApi primeiro.');

    const url = 'https://api.cnpja.com/office/' + cnpj + '?geocoding=true';
    const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: montarHeaderAuth_(chave),
        muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code !== 200) {
        throw new Error('HTTP ' + code + ': ' + response.getContentText().slice(0, 200));
    }

    const body = JSON.parse(response.getContentText());
    const lat = body && body.address && body.address.latitude;
    const lng = body && body.address && body.address.longitude;
    if (typeof lat === 'number' && typeof lng === 'number') {
        return { lat: lat, lng: lng };
    }
    return null; // CNPJá respondeu certo, mas não tinha coordenada pra esse endereço
}

// ===== COLUNAS E TRIGGER =====

function garantirColunas_() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Aba "' + SHEET_NAME + '" não encontrada nesta planilha.');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const faltando = ['Latitude', 'Longitude'].filter((h) => headers.indexOf(h) === -1);
    if (faltando.length) {
        sheet.getRange(1, headers.length + 1, 1, faltando.length).setValues([faltando]);
    }
}

function mapearColunas_(headers) {
    return {
        cnpj: headers.indexOf('Cnpj'),
        latitude: headers.indexOf('Latitude'),
        longitude: headers.indexOf('Longitude')
    };
}

function garantirTrigger_() {
    const jaExiste = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === TRIGGER_HANDLER);
    if (!jaExiste) {
        ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(5).create();
        Logger.log('Trigger criado — vai continuar sozinho a cada 5min até acabar.');
    }
}

function removerTrigger_() {
    ScriptApp.getProjectTriggers().forEach((t) => {
        if (t.getHandlerFunction() === TRIGGER_HANDLER) ScriptApp.deleteTrigger(t);
    });
}
