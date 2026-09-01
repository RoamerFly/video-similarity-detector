@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
rem Add a dot so a trailing backslash cannot escape the closing quote when
rem this path is passed to PowerShell (also works when the script is on a root).
set "DESKTOP_DIR=%~dp0."
set "PS_SCRIPT=%SCRIPT_DIR%build-windows.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] Missing build script: %PS_SCRIPT%
    if not defined CI pause
    exit /b 1
)

echo ========================================
echo   Video Similarity - GPU Windows Packager
echo ========================================
echo.
echo This wrapper calls build-windows.ps1 with -GpuBuild and forwards all other arguments.
echo Output defaults to desktop\dist_windows_gpu and env defaults to desktop\env_gpu.
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

set "PREFLIGHT_SCRIPT=%SCRIPT_DIR%build-windows-gpu-preflight.ps1"
if not exist "%PREFLIGHT_SCRIPT%" (
    echo [ERROR] Missing GPU environment preflight script: %PREFLIGHT_SCRIPT%
    if not defined CI pause
    exit /b 1
)

rem Keep the local GPU wrapper aligned with the CPU wrapper/release package layout.
rem Respect an explicit -DistName/-DistName=... supplied by the caller.
set "DEFAULT_ARGS=-DistName dist_windows_gpu"
set "HAS_DIST_NAME="
set "HAS_PYTHON="
set "REBUILD_PYTHON=1"
for %%A in (%*) do (
    for /f "tokens=1 delims==" %%B in ("%%~A") do (
        if /I "%%~B"=="-DistName" set "HAS_DIST_NAME=1"
        if /I "%%~B"=="-Python" set "HAS_PYTHON=1"
        if /I "%%~B"=="-SkipPythonEnv" set "REBUILD_PYTHON="
    )
)
if defined HAS_DIST_NAME set "DEFAULT_ARGS="
if defined REBUILD_PYTHON set "DEFAULT_ARGS=%DEFAULT_ARGS% -CleanPythonEnv"

pushd "%SCRIPT_DIR%"
if errorlevel 1 (
    echo [ERROR] Unable to enter the desktop build directory: %SCRIPT_DIR%
    if not defined CI pause
    exit /b 1
)
if not defined REBUILD_PYTHON if not defined HAS_PYTHON call :resolve_gpu_python
if errorlevel 1 (
    popd
    if not defined CI pause
    exit /b 1
)
if defined GPU_PYTHON goto :gpu_build_with_python
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -GpuBuild %DEFAULT_ARGS% %*
set "EXIT_CODE=%ERRORLEVEL%"
goto :gpu_build_result

:gpu_build_with_python
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -GpuBuild %DEFAULT_ARGS% -Python "%GPU_PYTHON%" %*
set "EXIT_CODE=%ERRORLEVEL%"

:gpu_build_result
popd

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] GPU build failed with exit code %EXIT_CODE%.
    if not defined CI pause
    exit /b %EXIT_CODE%
)

echo.
echo GPU build completed successfully.
if not defined CI pause
exit /b 0

:resolve_gpu_python
set "GPU_PYTHON="
for /f "usebackq delims=" %%P in (`%PS_EXE% -NoProfile -ExecutionPolicy Bypass -File "%PREFLIGHT_SCRIPT%" -DesktopDir "%DESKTOP_DIR%"`) do if not defined GPU_PYTHON set "GPU_PYTHON=%%P"
if defined GPU_PYTHON exit /b 0
echo [ERROR] GPU Python preflight failed. The bundled environment must contain a compatible interpreter.
exit /b 1
