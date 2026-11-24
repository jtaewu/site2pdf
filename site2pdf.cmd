@echo off
rem site2pdf 실행기 (저장소 어디서든 실행 가능). 예: site2pdf.cmd generate --source D:\site -o output
node "%~dp0backend\scripts\cli.mjs" %*
