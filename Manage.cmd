@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Install Node.js LTS, then open this file again.
  pause
  exit /b 1
)
node "%~dp0scripts\manage-launch.mjs" %*
set "manager_exit=%errorlevel%"
if not "%~1"=="" exit /b %manager_exit%
echo.
pause
exit /b %manager_exit%
