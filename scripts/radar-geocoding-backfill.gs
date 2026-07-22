/**
 * Backfill de geocodificação + enriquecimento por empresa (RadarClientes)
 * via CNPJá.
 *
 * NÃO faz parte do app (não é Node, não builda, não sobe pro Vercel) — é
 * um script do Google Apps Script, roda direto na planilha. Só está aqui
 * no repositório por registro/histórico.
 *
 * Suporta até 4 chaves da CNPJá (ex.: 4 contas grátis diferentes, 45
 * créditos cada) — usa a primeira até esgotar a cota dela, passa pra
 * próxima sozinho, sem precisar trocar nada na mão no meio do processo.
 *
 * Cada chamada já traz nome/endereço/telefone/CNAE — redundante com o
 * que o CSV já importa, então só aproveita o que é novo: geocodificação
 * (Latitude/Longitude), e-mail (Email), porte da empresa (Porte) e
 * capital social (CapitalSocial). Sócios e atividades secundárias ficam
 * de fora de propósito (ver discussão no chat sobre o schema completo).
 *
 * COMO INSTALAR
 * 1. Abra a planilha do App de Visitas no navegador.
 * 2. Extensões → Apps Script.
 * 3. Apague o conteúdo padrão de Code.gs e cole este arquivo inteiro.
 * 4. Rode `configurarChavesApi` uma vez (edite as chaves antes — pode
 *    deixar só a 1ª preenchida se só tiver uma conta por enquanto).
 *    Guarda as chaves fora do corpo visível do script.
 * 5. Rode `testarUmaEmpresa` — confere se a 1ª chave/autenticação estão
 *    certas usando o CNPJ que já apareceu no print que você me mandou
 *    (Banco do Brasil, Manaus — devia devolver lat -3.079897, lng
 *    -60.026557). Se der erro 401/403, o formato do header de
 *    autenticação abaixo (ver montarHeaderAuth_) provavelmente está
 *    errado — confere na "Referência da API" da CNPJá.
 * 6. Na aba Configurações do Radar (dentro do app), ajuste "Limite
 *    mensal de geocodificação" pra 45 × quantas chaves você configurou
 *    (ex.: 180 pra 4 contas grátis) — senão o limite geral para o
 *    processo antes de usar as contas extras.
 * 7. Só depois de validar os passos 5 e 6, rode
 *    `iniciarBackfillGeocodificacao`. Processa em lotes de ~5min (limite
 *    do Apps Script é 6min por execução) e se reagenda sozinho via
 *    trigger até acabar; você pode fechar a aba, não precisa ficar
 *    olhando.
 *
 * COMO FUNCIONA A RETOMADA (por empresa)
 * Cada linha da planilha guarda seu próprio estado na coluna Latitude
 * (Longitude/Email/Porte/CapitalSocial são criadas junto, mas quem
 * decide se já tentou é só a Latitude — os outros 4 vêm da MESMA
 * chamada):
 *   - vazio       → ainda não tentou
 *   - número      → geocodificado com sucesso
 *   - "sem_coordenada" → a CNPJá respondeu mas não tinha coordenada pra
 *     esse endereço (não tenta de novo sozinho — evita gastar crédito à
 *     toa numa empresa que provavelmente vai continuar sem coordenada)
 * Email/Porte/CapitalSocial só são gravados quando vêm preenchidos —
 * pode ficar vazio numa empresa mesmo já processada, se a CNPJá
 * simplesmente não tinha esse dado específico.
 * Erro de rede/API NÃO marca a linha — ela fica vazia e entra de novo na
 * próxima passada. Rodar o backfill de novo mais tarde (ex.: depois de
 * importar CSV novo) só processa quem ainda está vazio.
 *
 * COMO FUNCIONA A ROTAÇÃO DE CHAVES
 * Cada chave tem uma cota mensal própria (CREDITOS_POR_CHAVE, padrão 45)
 * controlada aqui dentro (Script Properties, não na planilha — é detalhe
 * interno, a aba Configurações do Radar só mostra o total combinado). Ao
 * escolher qual chave usar pra próxima empresa, pula quem já bateu a
 * cota. Se uma chave der 3 erros "de verdade" seguidos (ex.: chave
 * inválida — rate limit NÃO conta pra isso, ver abaixo), ela é
 * descartada só pro resto desse lote — as outras continuam normalmente.
 *
 * RATE LIMIT (por chave, visto na prática — não documentado pela CNPJá)
 * ~10 chamadas por 60s antes da CNPJá responder 429. DELAY_BETWEEN_CALLS_MS
 * (6500ms) já respeita isso por padrão. Se mesmo assim vier um 429, o
 * script lê o "ttl" que a própria CNPJá manda na resposta (segundos até
 * liberar de novo), espera esse tempo e continua da próxima linha — não
 * descarta a chave nem gasta um erro "de verdade" por isso, já que o
 * problema é só velocidade, não a chave em si.
 *
 * CUSTO
 * 1 crédito por linha nova processada (sucesso ou sem_coordenada — a
 * chamada já foi feita de qualquer jeito). O total combinado das chaves é
 * comparado com "Limite mensal de geocodificação" (ConfigEmail,
 * configurável na aba Configurações do Radar) — bate o limite, o script
 * para sozinho até o mês virar.
 */

// ===== CONFIGURAÇÃO =====
const SHEET_NAME = 'RadarClientes';
const BATCH_TIME_LIMIT_MS = 5 * 60 * 1000; // folga dentro do limite de 6min do Apps Script
// Visto na prática (log de execução real): a CNPJá deixa ~10
// chamadas/60s por chave antes de responder 429. 6500ms de espaçamento
// = no máximo ~9,2 chamadas/60s, com folga. Isso é por chave — trocar de
// chave (ver escolherChave_) não acelera, o delay vale igual pra todas.
const DELAY_BETWEEN_CALLS_MS = 6500;
const TRIGGER_HANDLER = 'processarLote_';
const MAX_CHAVES = 4;
const CREDITOS_POR_CHAVE = 45; // cota grátis de cada conta CNPJá — ajuste aqui se alguma virar paga

// A aba Configurações do Radar (dentro do app) lê esses 3 valores da
// ConfigEmail pra mostrar progresso pro admin — o app nunca escreve
// neles, só esse script. "limite" é editável ali; "usado"/"mês" são só
// pra esse script atualizar.
const CONFIG_SHEET_NAME = 'ConfigEmail';
const CONFIG_KEY_LIMITE = 'radar_geocoding_limite_mensal';
const CONFIG_KEY_USADO = 'radar_geocoding_usado_mes';
const CONFIG_KEY_MES = 'radar_geocoding_mes_referencia';

// Formato do header de autenticação — CONFERIR na "Referência da API" da
// CNPJá antes de rodar o backfill de verdade (testarUmaEmpresa serve
// exatamente pra isso). Chute inicial: header "Authorization" com o
// token puro, sem prefixo "Bearer".
function montarHeaderAuth_(chave) {
    return { 'Authorization': chave };
}

// ===== SETUP (rodar uma vez) =====

function configurarChavesApi() {
    const chaves = [
        'COLE_A_CHAVE_DA_CONTA_1_AQUI',
        '', // conta 2 — deixe '' se não tiver ainda
        '', // conta 3
        ''  // conta 4
    ];
    const props = PropertiesService.getScriptProperties();
    let salvas = 0;
    chaves.forEach((chave, i) => {
        if (chave) { props.setProperty('CNPJA_API_KEY_' + (i + 1), chave); salvas++; }
    });
    Logger.log(salvas + ' chave(s) salva(s). Pode apagar as chaves em texto puro acima se quiser. ' +
        'Lembre de ajustar "Limite mensal de geocodificação" na aba Configurações do Radar (dentro do ' +
        'app) pra ' + (salvas * CREDITOS_POR_CHAVE) + ' (= ' + salvas + ' conta(s) × ' + CREDITOS_POR_CHAVE +
        ' créditos grátis cada).');
}

function testarUmaEmpresa() {
    const chaves = obterChaves_();
    const resultado = buscarGeocodificacao_('07526557011659', chaves[0].chave); // Banco do Brasil, Manaus — CNPJ do print
    Logger.log(JSON.stringify(resultado));
}

function obterChaves_() {
    const props = PropertiesService.getScriptProperties();
    const chaves = [];
    for (let i = 1; i <= MAX_CHAVES; i++) {
        const chave = props.getProperty('CNPJA_API_KEY_' + i);
        if (chave) chaves.push({ indice: i, chave: chave });
    }
    if (!chaves.length) throw new Error('Nenhuma chave configurada — rode configurarChavesApi primeiro.');
    return chaves;
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
    if (idx.cnpj === -1 || idx.latitude === -1 || idx.longitude === -1 || idx.email === -1 || idx.porte === -1 || idx.capitalSocial === -1) {
        throw new Error('Colunas Cnpj/Latitude/Longitude/Email/Porte/CapitalSocial não encontradas — rode garantirColunas_ primeiro (iniciarBackfillGeocodificacao já faz isso).');
    }

    const chaves = obterChaves_();
    const usoChaves = lerUsoPorChave_();
    const cfg = lerConfigUso_();
    let usadoAgora = cfg.usado; // total combinado — é o que a aba Configurações do Radar mostra
    const errosConsecutivosPorChave = {};
    const chavesDescartadasNesteLote = {};

    function escolherChave_() {
        for (const c of chaves) {
            if (chavesDescartadasNesteLote[c.indice]) continue;
            if ((usoChaves.uso[c.indice] || 0) >= CREDITOS_POR_CHAVE) continue;
            return c;
        }
        return null;
    }

    const startTime = Date.now();
    let cortadoPeloTempo = false;
    let semChaveDisponivel = false;
    let limiteGeralAtingido = false;
    let processados = 0, comCoordenada = 0, semCoordenada = 0, erros = 0;

    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        const cnpj = String(row[idx.cnpj] || '').replace(/\D/g, '');
        const valorLat = row[idx.latitude];
        const jaProcessado = valorLat !== '' && valorLat !== null;
        if (!cnpj || jaProcessado) continue;

        if (usadoAgora >= cfg.limite) { limiteGeralAtingido = true; break; }
        if (Date.now() - startTime > BATCH_TIME_LIMIT_MS) { cortadoPeloTempo = true; break; }

        const chaveAtiva = escolherChave_();
        if (!chaveAtiva) { semChaveDisponivel = true; break; }

        processados++;
        try {
            const resultado = buscarGeocodificacao_(cnpj, chaveAtiva.chave);
            if (resultado.lat !== null && resultado.lng !== null) {
                sheet.getRange(r + 1, idx.latitude + 1).setValue(resultado.lat);
                sheet.getRange(r + 1, idx.longitude + 1).setValue(resultado.lng);
                comCoordenada++;
            } else {
                sheet.getRange(r + 1, idx.latitude + 1).setValue('sem_coordenada');
                semCoordenada++;
            }
            // Mesma chamada já trazia isso — sem custo extra de crédito.
            // Só grava o que veio preenchido (deixa em branco o que a
            // CNPJá não tinha, em vez de sobrescrever com vazio).
            if (resultado.email) sheet.getRange(r + 1, idx.email + 1).setValue(resultado.email);
            if (resultado.porte) sheet.getRange(r + 1, idx.porte + 1).setValue(resultado.porte);
            if (resultado.capitalSocial !== null) sheet.getRange(r + 1, idx.capitalSocial + 1).setValue(resultado.capitalSocial);
            usoChaves.uso[chaveAtiva.indice] = (usoChaves.uso[chaveAtiva.indice] || 0) + 1;
            usadoAgora++; // a chamada foi feita (e respondida) de qualquer jeito, gastou crédito
            errosConsecutivosPorChave[chaveAtiva.indice] = 0;
        } catch (e) {
            if (e.rateLimited) {
                // Não descarta a chave nem conta como erro "de verdade" —
                // só fomos rápido demais. Espera o tempo que a própria
                // CNPJá mandou (+ folga) e segue da próxima linha; essa
                // fica vazia pra ser retentada depois.
                const espera = (e.ttl || 60) + 3;
                Logger.log('Rate limit na chave ' + chaveAtiva.indice + ' (linha ' + (r + 1) + ') — esperando ' + espera + 's.');
                Utilities.sleep(espera * 1000);
                continue;
            }
            Logger.log('Erro no CNPJ ' + cnpj + ' (linha ' + (r + 1) + ', chave ' + chaveAtiva.indice + '): ' + e.message);
            erros++;
            errosConsecutivosPorChave[chaveAtiva.indice] = (errosConsecutivosPorChave[chaveAtiva.indice] || 0) + 1;
            // 3 erros seguidos NESSA chave não é ruído de rede, é sinal de
            // que ela esgotou (ou é inválida) — descarta só ela pro resto
            // desse lote e segue com as outras. A linha continua vazia,
            // será retentada (com essa ou outra chave) na próxima passada.
            if (errosConsecutivosPorChave[chaveAtiva.indice] >= 3) {
                chavesDescartadasNesteLote[chaveAtiva.indice] = true;
                Logger.log('Chave ' + chaveAtiva.indice + ' descartada por esse lote (3 erros seguidos).');
            }
        }
        Utilities.sleep(DELAY_BETWEEN_CALLS_MS);
    }

    salvarUsoPorChave_(usoChaves);
    salvarConfigUso_(cfg, usadoAgora);

    const chavesOk = chaves.length - Object.keys(chavesDescartadasNesteLote).length;
    Logger.log('Lote: ' + processados + ' processados — ' + comCoordenada + ' com coordenada, ' +
        semCoordenada + ' sem coordenada, ' + erros + ' erro(s). Uso total do mês: ' + usadoAgora + '/' +
        cfg.limite + '. Chaves ativas nesse lote: ' + chavesOk + '/' + chaves.length + '.');

    if (limiteGeralAtingido) {
        removerTrigger_();
        Logger.log('PARADO: limite mensal geral (' + cfg.limite + ') atingido. Se configurou mais chaves ' +
            'do que esse número cobre, ajuste "Limite mensal de geocodificação" na aba Configurações do ' +
            'Radar (dentro do app) e rode iniciarBackfillGeocodificacao de novo manualmente — ou espere o ' +
            'mês virar, que reseta sozinho.');
    } else if (semChaveDisponivel) {
        removerTrigger_();
        Logger.log('PARADO: todas as ' + chaves.length + ' chave(s) configurada(s) esgotaram a cota (' +
            CREDITOS_POR_CHAVE + ' cada) ou deram erro nesse lote. Volta a valer mais no mês que vem, ou ' +
            'rode iniciarBackfillGeocodificacao manualmente se resolver algo (chave nova, etc.) antes disso.');
    } else if (cortadoPeloTempo) {
        garantirTrigger_();
    } else {
        // Passou pela planilha inteira nessa passada sem precisar cortar
        // pelo tempo nem por limite — não sobrou nenhuma linha pendente.
        removerTrigger_();
        Logger.log('Backfill concluído — nenhuma linha pendente restante.');
    }
}

// A mesma chamada já traz nome/endereço/telefone/CNAE etc. — a maior
// parte é redundante com o que o CSV já importa, então só extrai o que é
// realmente novo: geocodificação, e-mail, porte e capital social. Ver
// discussão no chat sobre o schema completo — sócios (`members`) e
// atividades secundárias ficaram de fora de propósito.
function buscarGeocodificacao_(cnpj, chave) {
    const url = 'https://api.cnpja.com/office/' + cnpj + '?geocoding=true';
    const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: montarHeaderAuth_(chave),
        muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code === 429) {
        // Rate limit (visto na prática: ~10 chamadas/60s por chave) —
        // NÃO é a chave que está ruim, somos nós indo rápido demais. A
        // própria CNPJá manda quanto falta pro limite liberar de novo
        // (ttl, em segundos) — usa isso em vez de chutar um tempo de
        // espera. Marcado à parte (erro.rateLimited) pra quem chamou
        // saber que não deve tratar isso como "chave inválida".
        let ttl = 60;
        try {
            const parsed = JSON.parse(response.getContentText());
            if (typeof parsed.ttl === 'number') ttl = parsed.ttl;
        } catch (e) { /* mantém os 60s padrão se o corpo não vier no formato esperado */ }
        const erro = new Error('HTTP 429 (rate limit): ' + response.getContentText().slice(0, 200));
        erro.rateLimited = true;
        erro.ttl = ttl;
        throw erro;
    }
    if (code !== 200) {
        throw new Error('HTTP ' + code + ': ' + response.getContentText().slice(0, 200));
    }

    const body = JSON.parse(response.getContentText());
    const lat = body && body.address && body.address.latitude;
    const lng = body && body.address && body.address.longitude;
    const email = (body && body.emails && body.emails[0] && body.emails[0].address) || '';
    const porte = (body && body.company && body.company.size && body.company.size.text) || '';
    const equity = body && body.company && body.company.equity;

    return {
        lat: (typeof lat === 'number') ? lat : null,
        lng: (typeof lng === 'number') ? lng : null,
        email: email,
        porte: porte,
        capitalSocial: (typeof equity === 'number') ? equity : null
    };
}

// ===== USO POR CHAVE (rotação entre contas — Script Properties, interno) =====
// Detalhe de implementação: quanto CADA chave já gastou esse mês, pra
// saber quando pular pra próxima. Diferente do total combinado (que vai
// pra ConfigEmail, visível na aba Configurações do Radar), isso fica só
// aqui — o app não precisa saber qual chave específica fez qual chamada.

function lerUsoPorChave_() {
    const props = PropertiesService.getScriptProperties();
    const mesAtual = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Sao_Paulo', 'yyyy-MM');
    const mesSalvo = props.getProperty('CHAVES_MES_REFERENCIA');
    const uso = {};
    for (let i = 1; i <= MAX_CHAVES; i++) {
        uso[i] = (mesSalvo === mesAtual) ? (Number(props.getProperty('CHAVE_' + i + '_USO')) || 0) : 0;
    }
    return { uso: uso, mesAtual: mesAtual };
}

function salvarUsoPorChave_(usoChaves) {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('CHAVES_MES_REFERENCIA', usoChaves.mesAtual);
    for (let i = 1; i <= MAX_CHAVES; i++) {
        props.setProperty('CHAVE_' + i + '_USO', String(usoChaves.uso[i] || 0));
    }
}

// ===== CONFIG (ConfigEmail) =====
// Mesma aba que a tela admin do app já usa (Chave na coluna A, Valor na
// coluna B). Só lê radar_geocoding_limite_mensal (editável na aba
// Configurações do Radar, dentro do app); lê e escreve
// radar_geocoding_usado_mes + radar_geocoding_mes_referencia — só esse
// script escreve esses 2, o app só mostra.

function lerConfigUso_() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET_NAME);
    const mesAtual = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Sao_Paulo', 'yyyy-MM');
    if (!sheet) {
        Logger.log('Aba "' + CONFIG_SHEET_NAME + '" não encontrada — rodando sem limite mensal configurado (padrão 45).');
        return { sheet: null, limite: 45, usado: 0, mesAtual: mesAtual, linhaUsado: -1, linhaMes: -1 };
    }

    const data = sheet.getDataRange().getValues();
    let limite = 45, usado = 0, mesReferencia = '';
    let linhaUsado = -1, linhaMes = -1;
    for (let r = 1; r < data.length; r++) {
        const chave = String(data[r][0] || '').trim();
        if (chave === CONFIG_KEY_LIMITE) limite = Number(data[r][1]) || 45;
        if (chave === CONFIG_KEY_USADO) { usado = Number(data[r][1]) || 0; linhaUsado = r; }
        if (chave === CONFIG_KEY_MES) { mesReferencia = String(data[r][1] || ''); linhaMes = r; }
    }
    const usadoAntesDoReset = usado;
    if (mesReferencia !== mesAtual) usado = 0; // virou o mês, zera o contador

    // DIAGNÓSTICO TEMPORÁRIO — remover depois de achar a causa do contador
    // não persistir entre execuções (visto em produção: lote fechou com
    // usadoAgora=28 mas a planilha ficou com 0 depois).
    Logger.log('[diag] lerConfigUso_: linhaUsado=' + linhaUsado + ' valorBruto=' +
        JSON.stringify(linhaUsado >= 0 ? data[linhaUsado][1] : null) + ' tipo=' +
        (linhaUsado >= 0 ? typeof data[linhaUsado][1] : 'n/a') + ' usadoAntesDoReset=' + usadoAntesDoReset +
        ' mesReferencia="' + mesReferencia + '" mesAtual="' + mesAtual + '" usadoFinal=' + usado);

    return { sheet: sheet, limite: limite, usado: usado, mesAtual: mesAtual, linhaUsado: linhaUsado, linhaMes: linhaMes };
}

function salvarConfigUso_(cfg, usadoAgora) {
    if (!cfg.sheet) return;
    // DIAGNÓSTICO TEMPORÁRIO — ver comentário em lerConfigUso_.
    Logger.log('[diag] salvarConfigUso_: linhaUsado=' + cfg.linhaUsado + ' escrevendo="' + String(usadoAgora) + '"');
    if (cfg.linhaUsado === -1) {
        cfg.sheet.appendRow([CONFIG_KEY_USADO, String(usadoAgora)]);
    } else {
        cfg.sheet.getRange(cfg.linhaUsado + 1, 2).setValue(String(usadoAgora));
    }
    if (cfg.linhaMes === -1) {
        cfg.sheet.appendRow([CONFIG_KEY_MES, cfg.mesAtual]);
    } else {
        cfg.sheet.getRange(cfg.linhaMes + 1, 2).setValue(cfg.mesAtual);
    }
    SpreadsheetApp.flush(); // força gravar agora — sem isso, em execuções longas a escrita pode ficar em buffer até o fim
    // DIAGNÓSTICO TEMPORÁRIO — relê na hora pra confirmar o que ficou salvo de verdade.
    const confereUsado = cfg.linhaUsado === -1
        ? cfg.sheet.getRange(cfg.sheet.getLastRow() - 1, 2).getValue()
        : cfg.sheet.getRange(cfg.linhaUsado + 1, 2).getValue();
    Logger.log('[diag] salvarConfigUso_: relido logo depois de salvar = ' + JSON.stringify(confereUsado));
}

// ===== COLUNAS E TRIGGER =====

function garantirColunas_() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Aba "' + SHEET_NAME + '" não encontrada nesta planilha.');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const faltando = ['Latitude', 'Longitude', 'Email', 'Porte', 'CapitalSocial'].filter((h) => headers.indexOf(h) === -1);
    if (faltando.length) {
        sheet.getRange(1, headers.length + 1, 1, faltando.length).setValues([faltando]);
    }
}

function mapearColunas_(headers) {
    return {
        cnpj: headers.indexOf('Cnpj'),
        latitude: headers.indexOf('Latitude'),
        longitude: headers.indexOf('Longitude'),
        email: headers.indexOf('Email'),
        porte: headers.indexOf('Porte'),
        capitalSocial: headers.indexOf('CapitalSocial')
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
