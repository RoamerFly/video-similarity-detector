@echo off
chcp 65001 >nul

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
    echo.
)

:: Start dev server
echo Starting Tauri dev mode...
echo Press Ctrl+C to stop
echo.

call npm run tauri:dev
