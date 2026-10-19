' Starts the switcher service without a console window.
' Argument "open": also open the UI in the browser. No argument: background only (used by autostart).
' Keep this file ASCII-only: Windows Script Host reads it with the system ANSI code page.
Set shell = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
extra = " --no-open"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "open" Then extra = ""
End If
shell.CurrentDirectory = dir
shell.Run """" & dir & "\runtime\node.exe"" """ & dir & "\main.cjs""" & extra, 0, False
