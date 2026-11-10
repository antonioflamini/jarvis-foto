' JARVIS Foto - avvia un comando senza la finestra nera
' Uso: wscript.exe avvio_nascosto.vbs [sorveglia|arrivi|...]
Option Explicit
Dim fso, sh, cartella, nodo, comando, q
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
cartella = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodo = cartella & "\node\node.exe"
If Not fso.FileExists(nodo) Then nodo = "node"
comando = "sorveglia"
If WScript.Arguments.Count > 0 Then comando = WScript.Arguments(0)
q = Chr(34)
sh.CurrentDirectory = cartella
sh.Run q & nodo & q & " " & q & cartella & "\src\cli.js" & q & " " & comando, 0, False
