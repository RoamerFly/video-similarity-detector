@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"

echo ========================================
echo   Video Similarity - Dev Mode
echo ========================================
echo.

:: Copy icons
if not exist "src-tauri\icons" mkdir "src-tauri\icons"

if exist "icon.png" (
    copy /Y "icon.png" "src-tauri\icons\icon.png" >nul 2>nul
) else if exist "..\icon.png" (
    copy /Y "..\icon.png" "src-tauri\icons\icon.png" >nul 2>nul
)

if exist "icon.ico" (
    copy /Y "icon.ico" "src-tauri\icons\icon.ico" >nul 2>nul
) else if exist "..\icon.ico" (
    copy /Y "..\icon.ico" "src-tauri\icons\icon.ico" >nul 2>nul
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        if not defined CI pause
        exit /b 1
    )
    echo.
)

:: Start dev server
echo Starting Tauri dev mode...
echo Press Ctrl+C to stop
echo.

call npm run tauri:dev
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Dev mode exited with code %EXIT_CODE%.
    if not defined CI pause
    exit /b %EXIT_CODE%
)
