@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%build-windows.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] Missing build script: %PS_SCRIPT%
    if not defined CI pause
    exit /b 1
)

echo ========================================
echo   Video Similarity - Windows Packager
echo ========================================
echo.
echo This wrapper calls build-windows.ps1 and forwards all arguments.
echo Python runtime is rebuilt on every package build to avoid mixing files from different Python versions.
echo Pass -SkipPythonEnv when you intentionally want to reuse the existing bundled environment.
echo Running packaged apps in the output directory are stopped automatically unless -NoStopRunningApp is passed.
echo.

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

set "DEFAULT_ARGS=-CleanPythonEnv"
set "HAS_SKIP_PYTHON_ENV="
set "HAS_CLEAN_PYTHON_ENV="
for %%A in (%*) do (
    for /f "tokens=1 delims==" %%B in ("%%~A") do (
        if /I "%%~B"=="-SkipPythonEnv" set "HAS_SKIP_PYTHON_ENV=1"
        if /I "%%~B"=="-CleanPythonEnv" set "HAS_CLEAN_PYTHON_ENV=1"
    )
)
if defined HAS_SKIP_PYTHON_ENV set "DEFAULT_ARGS="
if defined HAS_CLEAN_PYTHON_ENV set "DEFAULT_ARGS="

pushd "%SCRIPT_DIR%"
if errorlevel 1 (
    echo [ERROR] Unable to enter the desktop build directory: %SCRIPT_DIR%
    if not defined CI pause
    exit /b 1
)
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %DEFAULT_ARGS% %*
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Build failed with exit code %EXIT_CODE%.
    if not defined CI pause
    exit /b %EXIT_CODE%
)

echo.
echo Build completed successfully.
if not defined CI pause
exit /b 0
