@echo off
rem Cadastra a tarefa agendada do Windows que roda vigia.ps1 a cada 5 min --
rem so precisa rodar isso UMA VEZ (ou de novo se algum dia mudar a pasta do
rem robo). Nao precisa ser admin: /rl limited roda com os mesmos
rem privilegios da sua conta normal, so quando voce estiver logado -- igual
rem o resto do robo.
cd /d "%~dp0"

schtasks /create /tn "Hygicare - Vigia Robo WhatsApp" ^
    /tr "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0vigia.ps1\"" ^
    /sc minute /mo 5 /rl limited /f

if errorlevel 1 (
    echo.
    echo Nao consegui cadastrar a tarefa. Confira a mensagem acima.
    pause
    exit /b 1
)

echo.
echo Pronto — o robo agora se reinicia sozinho se cair, e o robo.log gira
echo sozinho quando passar de 20 MB. Confira em vigia.log (nesta pasta) se
echo algum dia quiser ver o historico disso.
echo.
echo Pra desligar essa checagem automatica algum dia: abra "Agendador de
echo Tarefas" no Windows e apague a tarefa "Hygicare - Vigia Robo WhatsApp".
pause
