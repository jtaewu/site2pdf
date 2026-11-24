@echo off
rem 내부망 반입 패키지 만들기 (인터넷 PC에서 실행). 결과: C:\site2pdf-offline
node "%~dp0backend\scripts\offline-bundle.mjs" %*
if errorlevel 1 pause
