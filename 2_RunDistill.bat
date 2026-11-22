@echo off
setlocal
title Distill - step 2 of 3
cd /d "%~dp0"
echo.
echo   Distill - step 2 of 3
echo   =====================
echo   Reads distill.json from the Desktop, writes distill_result.json and
echo   distill_preview.svg next to it. You can also drag a .json onto this file.
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo   Node.js was not found on this computer.
    echo   Install the LTS version from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)

node "%~dp0distill.js" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
    echo   Something went wrong - see the message above.
) else (
    echo   Done. Next: run 3_DistillImport.jsx in Illustrator.
)
echo.
pause
exit /b %RC%
