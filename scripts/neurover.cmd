@echo off
rem Neurover MCP command: works from any folder and does not depend on PATH or the user name.
set "NEUROVER_DATA_DIR=%~dp0."
if exist "%~dp0node\node.exe" ("%~dp0node\node.exe" "%~dp0app\neurover.mjs" %*) else (node "%~dp0app\neurover.mjs" %*)
