' feishu-bridge silent launcher
' Starts core/main.js with no visible window (used at logon).
'
' NOTE: keep this file pure ASCII. VBScript saved as ANSI mangles non-ASCII
' paths, which is why the old version ended up with "D:\??????\node.exe".
'
' Node resolution order:
'   1. %FEISHU_BRIDGE_NODE% (explicit override)
'   2. portable node installed by install.ps1 (.tools\node\node.exe)
'   3. node.exe on PATH

Option Explicit

Dim shell, fso, here, nodeExe, scriptPath, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(here, "core\main.js")

nodeExe = shell.ExpandEnvironmentStrings("%FEISHU_BRIDGE_NODE%")
If nodeExe = "%FEISHU_BRIDGE_NODE%" Or Not fso.FileExists(nodeExe) Then
    ' portable node from install.ps1
    nodeExe = fso.BuildPath(fso.BuildPath(here, ".tools\node"), "node.exe")
End If
If Not fso.FileExists(nodeExe) Then
    nodeExe = "node.exe"   ' PATH fallback; shell.Run resolves it
End If

If Not fso.FileExists(scriptPath) Then
    MsgBox "Cannot find " & scriptPath, 16, "feishu-bridge"
    WScript.Quit 1
End If

cmd = """" & nodeExe & """ """ & scriptPath & """"

' 0 = hidden window, False = do not wait for exit
shell.CurrentDirectory = here
shell.Run cmd, 0, False
