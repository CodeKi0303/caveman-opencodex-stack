Option Explicit
Dim shell, fso, script, powershell
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "scripts\sync-gui.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
shell.Run """" & powershell & """ -NoProfile -STA -ExecutionPolicy Bypass -File """ & script & """", 0, False
