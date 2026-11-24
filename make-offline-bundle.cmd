@echo off
rem Build the offline transfer package (run on a PC with internet). Output: C:\site2pdf-offline
node "%~dp0backend\scripts\offline-bundle.mjs" %*
if errorlevel 1 pause
