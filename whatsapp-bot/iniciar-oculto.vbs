' Roda o robo escondido (sem janela de console) — chamado pelo iniciar.bat.
' O log continua indo pro arquivo robo.log (o painel em
' http://localhost:3344 e' a forma normal de acompanhar o status).
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = pasta
WshShell.Run "cmd /c npm start >> robo.log 2>&1", 0, False
