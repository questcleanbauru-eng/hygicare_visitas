@echo off
cd /d "%~dp0"

if not exist node_modules (
    echo Primeira vez rodando aqui — instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo.
        echo Falhou ao instalar. Confira se o Node.js esta instalado ^(node -v^).
        pause
        exit /b 1
    )
)

if not exist .env (
    echo.
    echo Falta o arquivo .env — copie env.example para .env e preencha antes de iniciar.
    pause
    exit /b 1
)

echo Iniciando o robo de WhatsApp em segundo plano (sem janela)...
wscript.exe "%~dp0iniciar-oculto.vbs"

echo Abrindo o painel de status...
rem Espera a porta responder de verdade (em vez de um tempo fixo) — o robo
rem as vezes demora mais que 3s pra subir (ex.: antivirus escaneando na
rem primeira vez), e abrir o navegador cedo demais dava "nao e possivel
rem acessar esse site" ate um F5 manual.
powershell -NoProfile -Command "$t=0; while ($t -lt 30) { try { (New-Object Net.Sockets.TcpClient('localhost',3344)).Close(); break } catch { Start-Sleep -Milliseconds 500; $t++ } }"
start http://localhost:3344

echo Pronto — esta janela ja pode ser fechada, o robo continua rodando escondido.
echo (Acompanhe tudo pelo painel que acabou de abrir. Log tecnico fica em robo.log, se precisar.)
timeout /t 3 >nul
