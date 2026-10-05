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
timeout /t 3 >nul
start http://localhost:3344

echo Pronto — esta janela ja pode ser fechada, o robo continua rodando escondido.
echo (Acompanhe tudo pelo painel que acabou de abrir. Log tecnico fica em robo.log, se precisar.)
timeout /t 3 >nul
