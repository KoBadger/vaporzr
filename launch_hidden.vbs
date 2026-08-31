' Hidden launcher for the Vaporzr bot — run by the Task Scheduler so the bot
' process tree is owned by the scheduler service, not by whatever shell asked
' for it to start (survives shell/session teardown).
Dim fso, sh, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
sh.Run "cmd.exe /c """ & root & "\start_bot.cmd""", 0, False
