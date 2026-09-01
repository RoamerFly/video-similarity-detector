param(
    [switch]$Launch,
    [switch]$SkipFrontendBuild,
    [switch]$SkipNpmInstall,
    [switch]$ForceNpmInstall,
    [switch]$SkipRuntimeCheck,
    [switch]$NoStopRunningApp,
    [string]$OutputDir = "",
    [string]$GpuEnvDir = "",
    [string]$MergeEnvDir = ""
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host $Message -ForegroundColor Yellow
}

function Invoke-Checked([scriptblock]$Command, [string]$ErrorMessage) {
    $global:LASTEXITCODE = 0
    & $Command
    if (-not $? -or $LASTEXITCODE -ne 0) {
        throw $ErrorMessage
    }
}

function Add-PathEntry([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return
    }

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $entries = @($env:PATH -split [System.IO.Path]::PathSeparator) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    foreach ($entry in $entries) {
        if ([System.IO.Path]::GetFullPath($entry).Equals(
            $fullPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return
        }
    }
    $env:PATH = "$fullPath$([System.IO.Path]::PathSeparator)$env:PATH"
}

function Ensure-BuildCommand([string]$Command) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        return
    }

    if ($Command -eq "cargo") {
        $cargoCandidates = @()
        if (-not [string]::IsNullOrWhiteSpace($env:CARGO_HOME)) {
            $cargoCandidates += Join-Path $env:CARGO_HOME "bin\cargo.exe"
        }
        if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
            $cargoCandidates += Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
        }
        $profileDir = [Environment]::GetFolderPath("UserProfile")
        if (-not [string]::IsNullOrWhiteSpace($profileDir)) {
            $cargoCandidates += Join-Path $profileDir ".cargo\bin\cargo.exe"
        }

        foreach ($candidate in $cargoCandidates | Select-Object -Unique) {
            if (Test-Path -LiteralPath $candidate) {
                Add-PathEntry (Split-Path -Parent $candidate)
                if (Get-Command $Command -ErrorAction SilentlyContinue) {
                    Write-Host "  - Found cargo: $candidate" -ForegroundColor Green
                    return
                }
            }
        }
    }

    throw "Missing build command: $Command"
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

function Stop-WorkspaceNodeDevProcesses([string]$WorkspaceDir) {
    $workspaceFull = [System.IO.Path]::GetFullPath($WorkspaceDir).TrimEnd('\')
    $escapedWorkspace = [Regex]::Escape($workspaceFull)
    $running = @(
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                if (-not $_.CommandLine) {
                    return $false
                }
                $commandLine = $_.CommandLine
                if ($commandLine -notmatch $escapedWorkspace) {
                    return $false
                }
                return $commandLine -match '(?i)(vite|tauri[\\/]cli|tauri:dev|npm[^\r\n]+run[^\r\n]+dev)'
            }
    )
    if ($running.Count -eq 0) {
        return
    }
    if ($NoStopRunningApp) {
        $ids = @($running | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
        throw "Node dev server process(es) in this workspace are running and may lock node_modules. Close PID(s) $($ids -join ', ') first."
    }

    $ids = @($running | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
    Write-Host "  - Stopping workspace Node dev process(es): PID(s) $($ids -join ', ')" -ForegroundColor Yellow
    $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
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
            # A previous full build may have materialized these reusable assets as
            # real directories in the requested output. Keep them in place rather
            # than deleting a potentially multi-gigabyte environment; the fast
            # build can still refresh the EXE and create missing junctions.
            Write-Host "  - Reusing existing real directory in the output: $Path" -ForegroundColor DarkYellow
            return
        }
    }

    New-Item -ItemType Junction -Path $Path -Target $targetFull | Out-Null
}

function Invoke-TauriFastBuild([string]$OverridePath) {
    Invoke-Checked {
        npx tauri build --ci --no-bundle --features custom-protocol --config $OverridePath
    } "Tauri GPU test EXE build failed."
}

function Install-FrontendDependencies([string]$DesktopDir) {
    if ($SkipNpmInstall) {
        Write-Host "  - Skipped npm install by flag." -ForegroundColor Yellow
        return
    }

    Stop-WorkspaceNodeDevProcesses $DesktopDir

    $nodeModules = Join-Path $DesktopDir "node_modules"
    if ((Test-Path -LiteralPath $nodeModules) -and -not $ForceNpmInstall) {
        Write-Host "  - Reusing existing node_modules. Pass -ForceNpmInstall to refresh dependencies." -ForegroundColor Green
        return
    }

    Write-Host "  - Installing frontend dependencies..." -ForegroundColor Yellow
    Set-Location $DesktopDir
    if (Test-Path -LiteralPath (Join-Path $DesktopDir "package-lock.json")) {
        Invoke-Checked { npm ci } "npm ci failed."
    } else {
        Invoke-Checked { npm install } "npm install failed."
    }
}

$desktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $desktopDir ".."))
$outputDir = Resolve-AbsolutePath $desktopDir $OutputDir "dist_windows_gpu"
$gpuEnvDir = Resolve-AbsolutePath $desktopDir $GpuEnvDir "env_gpu"
$mergeEnvDir = Resolve-AbsolutePath $desktopDir $MergeEnvDir "merge-env"
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
Write-Host "Merge env    : $mergeEnvDir"
Write-Host "Test output  : $outputDir"

Write-Step "[1/5] Checking reusable local environment"
foreach ($command in @("node", "npm", "npx", "cargo")) {
    Ensure-BuildCommand $command
}
Install-FrontendDependencies $desktopDir
if (-not (Test-Path -LiteralPath $gpuPython)) {
    throw "Existing GPU Python env is missing: $gpuPython`nRun once: .\build-windows-gpu.bat -CleanPythonEnv"
}

if (-not $SkipRuntimeCheck) {
    Invoke-Checked {
        & $gpuPython -c "import torch; assert torch.version.cuda, 'Torch is not a CUDA build'; print('Torch:', torch.__version__); print('CUDA runtime:', torch.version.cuda); print('GPU available:', torch.cuda.is_available())"
    } "GPU Python environment check failed."
}

$ffmpeg = Join-Path $mergeEnvDir "ffmpeg.exe"
$ffprobe = Join-Path $mergeEnvDir "ffprobe.exe"
if (-not (Test-Path -LiteralPath $ffmpeg) -or -not (Test-Path -LiteralPath $ffprobe)) {
    Write-Host "  - Standalone FFmpeg is missing. It will be downloaded once and reused later." -ForegroundColor Yellow
    $prepareFfmpeg = Join-Path $repoRoot "scripts\prepare-ffmpeg-runtime.ps1"
    if (-not (Test-Path -LiteralPath $prepareFfmpeg)) {
        throw "FFmpeg preparation script was not found: $prepareFfmpeg"
    }
    & $prepareFfmpeg -DestinationDir $mergeEnvDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to prepare the standalone FFmpeg runtime."
    }
}
foreach ($tool in @($ffmpeg, $ffprobe)) {
    if (-not (Test-Path -LiteralPath $tool)) {
        throw "Standalone FFmpeg runtime is incomplete. Missing: $tool"
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
Stop-TestApp $releaseExe
Stop-TestApp $outputExe
$overridePath = Join-Path $env:TEMP ("video-similarity-gpu-fast-tauri-{0}-{1}.json" -f $PID, [Guid]::NewGuid().ToString("N"))
$override = @{
    build = @{ beforeBuildCommand = "" }
} | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $overridePath -Value $override -Encoding ASCII
try {
    Invoke-TauriFastBuild $overridePath
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
Ensure-Junction (Join-Path $outputDir "merge-env") $mergeEnvDir
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
set "VIDEO_SIM_FFMPEG=%~dp0merge-env\ffmpeg.exe"
set "VIDEO_SIM_FFPROBE=%~dp0merge-env\ffprobe.exe"
set "PATH=%~dp0merge-env;%~dp0env;%PATH%"
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
