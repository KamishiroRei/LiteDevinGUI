' devin-lite 一键启动（无控制台窗口）：
' 先探测已有服务——server.mjs 常驻持有唯一的 devin acp 进程；
' 已运行则只开浏览器接入，未运行才拉起。
Dim fso, sh, dir, http
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir

alive = False
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://127.0.0.1:8317/api/health", False
http.Send
If Err.Number = 0 And http.Status = 200 Then alive = True
On Error Goto 0

If Not alive Then
  sh.Run "node.exe """ & dir & "\server.mjs""", 0, False
  WScript.Sleep 1500
End If
sh.Run "http://127.0.0.1:8317"
