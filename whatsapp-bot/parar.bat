@echo off
cd /d "%~dp0"
echo Parando o robo de WhatsApp...

set PAROU=0

if exist bot.pid (
    set /p PID=<bot.pid
    if not "%PID%"=="" (
        taskkill /PID %PID% /T /F >nul 2>&1
        if not errorlevel 1 set PAROU=1
    )
)

REM Reserva: pega qualquer node.exe rodando este index.js, caso o bot.pid
REM esteja desatualizado (ex.: processo caiu e reiniciou sem atualizar).
if "%PAROU%"=="0" (
    for /f "tokens=2 delims=," %%p in ('wmic process where "name='node.exe' and CommandLine like '%%whatsapp-bot%%'" get ProcessId^,CommandLine /format:csv 2^>nul ^| findstr /r "[0-9]"') do (
        taskkill /PID %%p /F >nul 2>&1
        set PAROU=1
    )
)

if "%PAROU%"=="1" (
    echo Robo parado.
) else (
    echo Nenhum robo rodando foi encontrado ^(ja estava parado?^).
)
pause
