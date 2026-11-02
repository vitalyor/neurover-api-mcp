@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.16+ LTS from https://nodejs.org/ and run this installer again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<16))process.exit(1)"
if errorlevel 1 exit /b 1
call npm ci --omit=dev --ignore-scripts
if errorlevel 1 exit /b 1
node bin/neurover.mjs install-browser
if errorlevel 1 echo Browser install failed. One-time terminal login remains available.
node bin/neurover.mjs setup
if errorlevel 1 exit /b 1
pause
