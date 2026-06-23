@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%build-windows-gpu-fast.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] Missing build script: %PS_SCRIPT%
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] GPU fast build failed with exit code %EXIT_CODE%.
    pause
    exit /b %EXIT_CODE%
)

echo.
echo GPU fast build completed successfully.
pause
