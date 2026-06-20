@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%build-windows.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] Missing build script: %PS_SCRIPT%
    pause
    exit /b 1
)

echo ========================================
echo   Video Similarity - GPU Windows Packager
echo ========================================
echo.
echo This wrapper calls build-windows.ps1 with -GpuBuild and forwards all other arguments.
echo Output defaults to dist_windows_gpu and env defaults to env_gpu.
echo Running packaged apps in the output directory are stopped automatically unless -NoStopRunningApp is passed.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -GpuBuild %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] GPU build failed with exit code %EXIT_CODE%.
    pause
    exit /b %EXIT_CODE%
)

echo.
echo GPU build completed successfully.
pause
