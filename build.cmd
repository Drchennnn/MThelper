@echo off
chcp 65001 >nul
setlocal
if not exist "%~dp0bin" mkdir "%~dp0bin"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:"%~dp0bin\QuietCapture.exe" "%~dp0src\QuietCapture.cs" "%~dp0src\RegionCapture.cs" "%~dp0src\MouseShortcutHost.cs"
exit /b %errorlevel%
