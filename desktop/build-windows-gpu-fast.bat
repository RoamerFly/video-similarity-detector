@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%build-windows-gpu-fast.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] Missing build script: %PS_SCRIPT%
    if not defined CI pause
    exit /b 1
)

set "PS_EXE="
where.exe pwsh >nul 2>nul
if not errorlevel 1 set "PS_EXE=pwsh"
if not defined PS_EXE (
    where.exe powershell >nul 2>nul
    if not errorlevel 1 set "PS_EXE=powershell"
)
if not defined PS_EXE (
    echo [ERROR] Neither pwsh nor Windows PowerShell was found in PATH.
    if not defined CI pause
    exit /b 1
)

pushd "%SCRIPT_DIR%"
if errorlevel 1 (
    echo [ERROR] Unable to enter the desktop build directory: %SCRIPT_DIR%
    if not defined CI pause
    exit /b 1
)
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] GPU fast build failed with exit code %EXIT_CODE%.
    if not defined CI pause
    exit /b %EXIT_CODE%
)

echo.
echo GPU fast build completed successfully.
if not defined CI pause
exit /b 0
