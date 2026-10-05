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

echo Iniciando o robo de WhatsApp numa janela separada...
start "HygicareWhatsAppBot" cmd /k npm start
echo Pronto — pode fechar esta janela, o robo continua na outra.
timeout /t 3 >nul
