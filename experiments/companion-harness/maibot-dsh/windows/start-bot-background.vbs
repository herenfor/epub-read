Option Explicit
Dim shell, fso, folder, processes, item, quote
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
Set processes = GetObject("winmgmts:\\.\root\cimv2").ExecQuery("SELECT ExecutablePath FROM Win32_Process WHERE Name='NapCatWinBootMain.exe'")
For Each item In processes
  If Not IsNull(item.ExecutablePath) Then
    If LCase(item.ExecutablePath) = LCase(folder & "\shell\NapCatWinBootMain.exe") Then WScript.Quit 0
  End If
Next
quote = Chr(34)
shell.Run "cmd.exe /d /c " & quote & quote & folder & "\start-bot.cmd" & quote & quote, 0, False
