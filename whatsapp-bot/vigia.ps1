# Roda a cada 5 min via Agendador de Tarefas do Windows (ver
# registrar-vigia.ps1) — cuida de 2 coisas sozinho, sem precisar abrir nada:
#
# 1) Reinicia o robo se ele cair sem querer (processo morreu/travou). Nao
#    mexe se alguem parou de proposito pelo botao "Parar robo" do painel --
#    esse botao grava bot.pid vazio antes de sair; "cheio" quer dizer que
#    deveria estar rodando e nao esta.
# 2) Gira o robo.log quando ele passa de 20 MB, pra nao crescer pra sempre.
#    Reaproveita o mesmo reinicio (para, renomeia, religa).
#
# Fica de fora enquanto o computador estiver desligado/hibernando (o
# Agendador so roda a tarefa se a maquina estiver ligada) -- de proposito,
# ver pedido do Bruno de manter o robo só no computador dele, sem infra
# nenhuma a mais.

$ErrorActionPreference = 'SilentlyContinue'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $pasta

$pidFile = Join-Path $pasta 'bot.pid'
$logFile = Join-Path $pasta 'robo.log'
$logOldFile = Join-Path $pasta 'robo.log.old'
$vigiaLog = Join-Path $pasta 'vigia.log'
$limiteLogBytes = 20MB

function Escrever-Log([string]$msg) {
    $linha = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $vigiaLog -Value $linha -Encoding UTF8
    # O proprio vigia.log nao deve crescer pra sempre tambem -- mantem só as
    # ultimas ~500 linhas.
    $linhas = Get-Content $vigiaLog
    if ($linhas.Count -gt 500) { $linhas | Select-Object -Last 500 | Set-Content $vigiaLog -Encoding UTF8 }
}

function Porta-Respondendo {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $resultado = $client.BeginConnect('localhost', 3344, $null, $null)
        $ok = $resultado.AsyncWaitHandle.WaitOne(3000)
        if ($ok -and $client.Connected) { $client.Close(); return $true }
        $client.Close()
        return $false
    } catch { return $false }
}

$pidConteudo = if (Test-Path $pidFile) { (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue) } else { '' }
$deviaEstarRodando = -not [string]::IsNullOrWhiteSpace($pidConteudo)

if (-not $deviaEstarRodando) {
    # bot.pid vazio = parada intencional (botao "Parar robo") -- respeita,
    # nao reinicia sozinho.
    exit 0
}

$logGrande = (Test-Path $logFile) -and ((Get-Item $logFile).Length -gt $limiteLogBytes)
$portaOk = Porta-Respondendo

if ($portaOk -and -not $logGrande) {
    exit 0  # tudo normal
}

if ($logGrande) {
    $tamanhoMB = [math]::Round((Get-Item $logFile).Length / 1MB, 1)
    Escrever-Log "robo.log com $tamanhoMB MB (limite 20 MB) -- girando e reiniciando."
} else {
    Escrever-Log "Painel nao respondeu na porta 3344 com bot.pid preenchido -- robo deve ter caido. Reiniciando."
}

# Para com educacao se a porta ainda responder (caso do log grande com robo
# vivo); se ja estiver fora do ar, pula direto pro relancamento.
if ($portaOk) {
    try { Invoke-RestMethod -Uri 'http://localhost:3344/parar' -Method Post -TimeoutSec 5 | Out-Null } catch {}
    Start-Sleep -Seconds 3
}

if ($logGrande) {
    if (Test-Path $logOldFile) { Remove-Item $logOldFile -Force -ErrorAction SilentlyContinue }
    if (Test-Path $logFile) { Rename-Item $logFile $logOldFile -ErrorAction SilentlyContinue }
}

Start-Sleep -Seconds 1
$wsh = New-Object -ComObject WScript.Shell
$wsh.Run("wscript.exe `"$pasta\iniciar-oculto.vbs`"", 0, $false)
Escrever-Log 'Relancado.'
