@echo off
echo Parando o robo de WhatsApp...
taskkill /FI "WINDOWTITLE eq HygicareWhatsAppBot*" /T /F >nul 2>&1
if errorlevel 1 (
    echo Nenhum robo rodando foi encontrado ^(ja estava parado?^).
) else (
    echo Robo parado.
)
pause
