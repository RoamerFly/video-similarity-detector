param(
    [switch]$Launch,
    [switch]$SkipFrontendBuild,
    [switch]$SkipRuntimeCheck,
    [switch]$NoStopRunningApp,
    [string]$OutputDir = "",
    [string]$GpuEnvDir = ""
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host $Message -ForegroundColor Yellow
}

function Invoke-Checked([scriptblock]$Command, [string]$ErrorMessage) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw $ErrorMessage
    }
}

function Resolve-AbsolutePath([string]$Base, [string]$Value, [string]$DefaultValue) {
    $selected = if ([string]::IsNullOrWhiteSpace($Value)) { $DefaultValue } else { $Value.Trim() }
    if ([System.IO.Path]::IsPathRooted($selected)) {
        return [System.IO.Path]::GetFullPath($selected)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $Base $selected))
}

function Stop-TestApp([string]$ExecutablePath) {
    if (-not (Test-Path -LiteralPath $ExecutablePath)) {
        return
    }

    $target = [System.IO.Path]::GetFullPath($ExecutablePath)
    $running = @(
        Get-CimInstance Win32_Process -Filter "Name = 'video-similarity-desktop.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                [System.IO.Path]::GetFullPath($_.ExecutablePath).Equals(
                    $target,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
    )
    if ($running.Count -eq 0) {
        return
    }
    if ($NoStopRunningApp) {
        throw "The test app is running. Close it first: $target"
    }

    Write-Host "  - Stopping the previous test app..." -ForegroundColor Yellow
    $running | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}

function Ensure-Junction([string]$Path, [string]$Target) {
    $targetFull = [System.IO.Path]::GetFullPath($Target)
    if (-not (Test-Path -LiteralPath $targetFull)) {
        throw "Cannot create junction because the source directory is missing: $targetFull"
    }

    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            $currentTarget = [string](@($item.Target) | Select-Object -First 1)
            if ($currentTarget.StartsWith("\??\")) {
                $currentTarget = $currentTarget.Substring(4)
            }
            if ($currentTarget.Equals($targetFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                return
            }
            throw "Existing junction points elsewhere: $Path -> $currentTarget"
        } else {
            throw "Refusing to replace a real directory in the quick output: $Path"
        }
    }

    New-Item -ItemType Junction -Path $Path -Target $targetFull | Out-Null
}

$desktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $desktopDir ".."))
$outputDir = Resolve-AbsolutePath $desktopDir $OutputDir "dist_windows_gpu_quick"
$gpuEnvDir = Resolve-AbsolutePath $desktopDir $GpuEnvDir "env_gpu"
$gpuPython = Join-Path $gpuEnvDir "python\python.exe"
$releaseExe = Join-Path $desktopDir "src-tauri\target\release\video-similarity-desktop.exe"
$outputExe = Join-Path $outputDir "video-similarity-desktop.exe"
$frontendDist = Join-Path $desktopDir "dist"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Video Similarity - GPU Fast Test Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Project root : $repoRoot"
Write-Host "GPU env      : $gpuEnvDir"
Write-Host "Test output  : $outputDir"

Write-Step "[1/5] Checking reusable local environment"
foreach ($command in @("node", "npm", "npx", "cargo")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing build command: $command"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $desktopDir "node_modules"))) {
    throw "desktop\node_modules is missing. Run npm install in desktop once."
}
if (-not (Test-Path -LiteralPath $gpuPython)) {
    throw "Existing GPU Python env is missing: $gpuPython`nRun once: .\build-windows-gpu.bat -CleanPythonEnv"
}

if (-not $SkipRuntimeCheck) {
    Invoke-Checked {
        & $gpuPython -c "import torch; assert torch.version.cuda, 'Torch is not a CUDA build'; print('Torch:', torch.__version__); print('CUDA runtime:', torch.version.cuda); print('GPU available:', torch.cuda.is_available())"
    } "GPU Python environment check failed."
}

$ffmpeg = Join-Path $gpuEnvDir "ffmpeg.exe"
$ffprobe = Join-Path $gpuEnvDir "ffprobe.exe"
if (-not (Test-Path -LiteralPath $ffmpeg) -or -not (Test-Path -LiteralPath $ffprobe)) {
    Write-Host "  - FFmpeg is missing. It will be downloaded once and reused later." -ForegroundColor Yellow
    $prepareFfmpeg = Join-Path $repoRoot "scripts\prepare-ffmpeg-runtime.ps1"
    & $prepareFfmpeg -DestinationDir $gpuEnvDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to prepare FFmpeg runtime."
    }
}

Write-Step "[2/5] Building frontend"
Set-Location $desktopDir
if ($SkipFrontendBuild) {
    if (-not (Test-Path -LiteralPath (Join-Path $frontendDist "index.html"))) {
        throw "-SkipFrontendBuild was requested, but desktop\dist does not exist."
    }
    Write-Host "  - Reusing existing frontend dist." -ForegroundColor Green
} else {
    Invoke-Checked { npm run build } "Frontend build failed."
}

Write-Step "[3/5] Incrementally building Tauri EXE"
Stop-TestApp $outputExe
$overridePath = Join-Path $env:TEMP "video-similarity-gpu-fast-tauri.json"
$override = @{
    build = @{ beforeBuildCommand = "" }
    bundle = @{
        resources = @(
            "../../scripts",
            "../../video_sim",
            "../../requirements.txt",
            "../env_gpu"
        )
    }
} | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $overridePath -Value $override -Encoding ASCII
try {
    Invoke-Checked {
        npx tauri build --no-bundle --features custom-protocol --config $overridePath
    } "Tauri GPU test EXE build failed."
} finally {
    Remove-Item -LiteralPath $overridePath -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath $releaseExe)) {
    throw "Build completed but the EXE was not found: $releaseExe"
}

Write-Step "[4/5] Assembling lightweight test directory"
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
Copy-Item -LiteralPath $releaseExe -Destination $outputExe -Force
Ensure-Junction (Join-Path $outputDir "env") $gpuEnvDir
Ensure-Junction (Join-Path $outputDir "scripts") (Join-Path $repoRoot "scripts")
Ensure-Junction (Join-Path $outputDir "video_sim") (Join-Path $repoRoot "video_sim")
New-Item -ItemType Directory -Path (Join-Path $outputDir "data\reports") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outputDir "data\cache") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outputDir "models") -Force | Out-Null
Set-Content -LiteralPath (Join-Path $outputDir "BUILD_FLAVOR.txt") -Value "gpu" -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $repoRoot "requirements.txt") -Destination $outputDir -Force

$launcher = @"
@echo off
cd /d "%~dp0"
set "VIDEO_SIM_FFMPEG=%~dp0env\ffmpeg.exe"
set "PATH=%~dp0env;%PATH%"
start "" "%~dp0video-similarity-desktop.exe"
"@
Set-Content -LiteralPath (Join-Path $outputDir "run-gpu-test.bat") -Value $launcher -Encoding ASCII

Write-Step "[5/5] Complete"
$sizeMb = [Math]::Round((Get-Item -LiteralPath $outputExe).Length / 1MB, 1)
Write-Host "  - EXE: $outputExe ($sizeMb MB)" -ForegroundColor Green
Write-Host "  - Python/CUDA, FFmpeg, scripts and video_sim are reused through junctions." -ForegroundColor Green
Write-Host "  - Run run-gpu-test.bat or launch the EXE directly." -ForegroundColor Cyan

if ($Launch) {
    Start-Process -FilePath $outputExe -WorkingDirectory $outputDir
}
