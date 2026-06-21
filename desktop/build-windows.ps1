param(
    [switch]$SkipPythonEnv,
    [switch]$CleanPythonEnv,
    [switch]$SkipNpmInstall,
    [switch]$SkipNpmAudit,
    [switch]$SkipFrontendBuild,
    [switch]$SkipTauriBuild,
    [switch]$BuildInstaller,
    [switch]$GpuBuild,
    [switch]$NoPrunePythonEnv,
    [switch]$NoStopRunningApp,
    [int]$StopTimeoutSeconds = 15,
    [string]$Python = "",
    [string]$RuntimeRequirements = "",
    [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cpu",
    [string]$GpuTorchIndexUrl = "https://download.pytorch.org/whl/cu130",
    [string]$EnvName = "",
    [string]$DistName = "dist_windows"
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

function Test-Command([string]$Name) {
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Add-PathEntry([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path)) {
        return
    }

    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $entries = @($env:PATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $exists = $entries | Where-Object {
        try {
            [System.IO.Path]::GetFullPath($_).TrimEnd('\').Equals($full, [System.StringComparison]::OrdinalIgnoreCase)
        } catch {
            $false
        }
    }
    if (-not $exists) {
        $env:PATH = "$full;$env:PATH"
    }
}

function Initialize-BuildToolPath {
    if ($env:CARGO_HOME) {
        Add-PathEntry (Join-Path $env:CARGO_HOME "bin")
    }
    if ($env:USERPROFILE) {
        Add-PathEntry (Join-Path $env:USERPROFILE ".cargo\bin")
    }
    if ($env:APPDATA) {
        Add-PathEntry (Join-Path $env:APPDATA "npm")
    }
    if ($env:ProgramFiles) {
        Add-PathEntry (Join-Path $env:ProgramFiles "nodejs")
    }
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if ($programFilesX86) {
        Add-PathEntry (Join-Path $programFilesX86 "nodejs")
    }
}

function Assert-BuildCommand([string]$Name, [string]$InstallHint) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "$Name not found. $InstallHint"
    }
    return $command.Source
}

function Assert-ChildPath([string]$Parent, [string]$Child) {
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
    if (-not ($childFull.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase) -or $childFull.StartsWith("$parentFull\", [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing to remove or copy outside workspace: $childFull"
    }
}

function Test-FileLocked([string]$Path) {
    if (-not (Test-Path $Path)) {
        return $false
    }

    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $stream.Close()
        return $false
    } catch {
        return $true
    }
}

function Convert-ToComparablePath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.StartsWith("\\?\UNC\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $full = "\\" + $full.Substring(8)
    } elseif ($full.StartsWith("\\?\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $full = $full.Substring(4)
    }
    return $full.TrimEnd('\')
}

function Get-ProcessIdValue($Process) {
    if ($null -ne $Process.PSObject.Properties["ProcessId"]) {
        return [int]$Process.ProcessId
    }
    return [int]$Process.Id
}

function Get-ExecutableProcesses([string]$ExecutablePath) {
    if (-not (Test-Path $ExecutablePath)) {
        return @()
    }

    $targetFull = Convert-ToComparablePath $ExecutablePath
    $exeName = [System.IO.Path]::GetFileName($targetFull)
    $processName = [System.IO.Path]::GetFileNameWithoutExtension($targetFull)
    $found = @{}

    try {
        Get-CimInstance Win32_Process -Filter "Name = '$exeName'" -ErrorAction Stop | ForEach-Object {
            if ($_.ExecutablePath) {
                $candidateFull = Convert-ToComparablePath $_.ExecutablePath
                if ($candidateFull.Equals($targetFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $found[[int]$_.ProcessId] = $_
                }
            }
        }
    } catch {
        Write-Host "  - Process path lookup by CIM failed; falling back to Get-Process." -ForegroundColor DarkYellow
    }

    try {
        Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object {
            $candidate = $null
            try {
                $candidate = $_.Path
            } catch {
                $candidate = $null
            }
            if ($candidate) {
                $candidateFull = Convert-ToComparablePath $candidate
                if ($candidateFull.Equals($targetFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $found[[int]$_.Id] = $_
                }
            }
        }
    } catch {
        return @($found.Values)
    }

    return @($found.Values)
}

function Wait-ProcessIdsExit([int[]]$ProcessIds, [string]$Label) {
    if (-not $ProcessIds -or $ProcessIds.Count -eq 0) {
        return
    }

    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $StopTimeoutSeconds))
    while ((Get-Date) -lt $deadline) {
        $alive = @($ProcessIds | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
        if ($alive.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 500
    }

    $remaining = @($ProcessIds | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
    if ($remaining.Count -gt 0) {
        throw "Timed out waiting for $Label to exit. Still running PID(s): $($remaining -join ', ')."
    }
}

function Wait-FileUnlocked([string]$Path, [string]$Label) {
    if (-not (Test-Path $Path)) {
        return
    }

    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $StopTimeoutSeconds))
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-FileLocked $Path)) {
            return
        }
        Start-Sleep -Milliseconds 500
    }

    if (Test-FileLocked $Path) {
        throw "$Label is still locked: $Path"
    }
}

function Stop-ExecutableIfRunning([string]$ExecutablePath, [string]$Label) {
    if (-not (Test-Path $ExecutablePath)) {
        return
    }

    $processes = @(Get-ExecutableProcesses $ExecutablePath)
    if ($processes.Count -eq 0) {
        return
    }

    $ids = @($processes | ForEach-Object { Get-ProcessIdValue $_ } | Sort-Object -Unique)
    if ($NoStopRunningApp) {
        throw "$Label is running and locks the rebuild target. Close PID(s) $($ids -join ', ') first, or rerun without -NoStopRunningApp."
    }

    Write-Host "  - Stopping running ${Label}: PID(s) $($ids -join ', ')" -ForegroundColor Yellow
    foreach ($id in $ids) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    Wait-ProcessIdsExit $ids $Label
    Wait-FileUnlocked $ExecutablePath $Label
}

function Remove-DirectoryWithRetry([string]$Path, [string]$Label) {
    if (-not (Test-Path $Path)) {
        return
    }

    $attempts = 8
    for ($i = 1; $i -le $attempts; $i += 1) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if (-not (Test-Path $Path)) {
                return
            }
            if ($i -eq $attempts) {
                throw "Failed to remove $Label after $attempts attempts: $($_.Exception.Message)"
            }
            $delay = [Math]::Min(5, $i)
            Write-Host "  - ${Label} is still busy; retrying in $delay seconds ($i/$attempts)." -ForegroundColor Yellow
            Start-Sleep -Seconds $delay
        }
    }
}

function Remove-DistDirectory([string]$DistDir) {
    Assert-ChildPath $desktopDir $DistDir
    $distExe = Join-Path $DistDir "video-similarity-desktop.exe"
    Stop-ExecutableIfRunning $distExe "packaged app"
    Remove-DirectoryWithRetry $DistDir "portable output directory"
}

function Copy-Directory([string]$Source, [string]$Destination) {
    if (-not (Test-Path $Source)) {
        throw "Missing required directory: $Source"
    }
    if (Test-Path $Destination) {
        Remove-DirectoryWithRetry $Destination "destination directory"
    }
    New-Item -ItemType Directory -Path (Split-Path $Destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Copy-DirectoryContents([string]$Source, [string]$Destination, [string[]]$Exclude = @()) {
    if (-not (Test-Path $Source)) {
        return
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Where-Object {
        $Exclude -notcontains $_.Name
    } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Copy-PythonExecutableFiles([string]$BasePrefix, [string]$Destination) {
    foreach ($name in @("python.exe", "pythonw.exe", "python3.dll", "python310.dll", "vcruntime140.dll", "vcruntime140_1.dll")) {
        $source = Join-Path $BasePrefix $name
        if (Test-Path $source) {
            Copy-FileIfDifferent $source (Join-Path $Destination $name)
        }
    }

    $parent = Split-Path $BasePrefix -Parent
    Get-ChildItem -LiteralPath $parent -File -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -like "vcruntime*.dll"
    } | ForEach-Object {
        Copy-FileIfDifferent $_.FullName (Join-Path $Destination $_.Name)
    }

    $rootPython = Join-Path $Destination "python.exe"
    $scriptsDir = Join-Path $Destination "Scripts"
    $scriptPython = Join-Path $scriptsDir "python.exe"
    if ((Test-Path $rootPython) -and -not (Test-Path $scriptPython)) {
        New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
        Copy-Item -LiteralPath $rootPython -Destination $scriptPython -Force
    }
}

function Copy-FileIfDifferent([string]$Source, [string]$Destination) {
    $sourceFull = [System.IO.Path]::GetFullPath($Source)
    $destinationFull = [System.IO.Path]::GetFullPath($Destination)
    if ($sourceFull.Equals($destinationFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    New-Item -ItemType Directory -Path (Split-Path $Destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Complete-PythonRuntime([string]$VenvDir, [string]$VenvPython) {
    $basePrefix = (& $VenvPython -c "import sys; print(sys.base_prefix)") 2>$null
    if (-not $basePrefix -or -not (Test-Path $basePrefix)) {
        $cfg = Join-Path $VenvDir "pyvenv.cfg"
        if (Test-Path $cfg) {
            $homeLine = Get-Content -LiteralPath $cfg | Where-Object { $_ -match '^home\s*=' } | Select-Object -First 1
            if ($homeLine) {
                $basePrefix = ($homeLine -replace '^home\s*=\s*', '').Trim()
            }
        }
    }

    if (-not $basePrefix -or -not (Test-Path $basePrefix)) {
        throw "Unable to locate base Python runtime for portable copy."
    }

    $baseFull = [System.IO.Path]::GetFullPath($basePrefix).TrimEnd('\')
    $venvFull = [System.IO.Path]::GetFullPath($VenvDir).TrimEnd('\')
    if (-not $baseFull.Equals($venvFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Host "  - Completing portable runtime from: $basePrefix" -ForegroundColor Gray
        Copy-DirectoryContents (Join-Path $basePrefix "DLLs") (Join-Path $VenvDir "DLLs")
        Copy-DirectoryContents (Join-Path $basePrefix "Lib") (Join-Path $VenvDir "Lib") @("site-packages")

        Get-ChildItem -LiteralPath $basePrefix -File -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -like "python*.dll" -or $_.Name -like "vcruntime*.dll" -or $_.Name -in @("python.exe", "pythonw.exe")
        } | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $VenvDir $_.Name) -Force
        }

        Copy-PythonExecutableFiles $basePrefix $VenvDir
    } else {
        Write-Host "  - Portable runtime already contains local Python files." -ForegroundColor Green
    }

    Copy-PythonExecutableFiles $basePrefix $VenvDir

    $cfg = Join-Path $VenvDir "pyvenv.cfg"
    if (Test-Path $cfg) {
        Remove-Item -LiteralPath $cfg -Force
    }
}

function Remove-PythonEnvWaste([string]$PythonDir) {
    if (-not (Test-Path $PythonDir)) {
        return
    }

    Write-Host "  - Pruning Python cache and test files" -ForegroundColor Gray

    $fixedDirs = @(
        "Lib\test",
        "Lib\tkinter",
        "Lib\turtledemo",
        "Lib\idlelib",
        "Lib\ensurepip",
        "Lib\site-packages\torch\include",
        "Lib\site-packages\pip",
        "Lib\site-packages\imageio_ffmpeg",
        "share\doc"
    )

    foreach ($relative in $fixedDirs) {
        $target = Join-Path $PythonDir $relative
        if (Test-Path $target) {
            Assert-ChildPath $PythonDir $target
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Get-ChildItem -LiteralPath $PythonDir -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object {
            if ($_.Name -eq "__pycache__") {
                return $true
            }
            if ($_.Name -notin @("test", "tests")) {
                return $false
            }

            $relative = $_.FullName.Substring(
                [System.IO.Path]::GetFullPath($PythonDir).TrimEnd('\').Length
            ).TrimStart('\')
            # NumPy testing imports this private module at runtime; SciPy reaches it
            # while Transformers loads CLIP, so it is not removable test-only data.
            return $relative -notlike "Lib\site-packages\numpy\_core\tests"
        } |
        ForEach-Object {
            Assert-ChildPath $PythonDir $_.FullName
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }

    Get-ChildItem -LiteralPath $PythonDir -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @(".pyc", ".pyo", ".lib", ".exp", ".pdb") } |
        ForEach-Object {
            Assert-ChildPath $PythonDir $_.FullName
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }

    $sitePackages = Join-Path $PythonDir "Lib\site-packages"
    if (Test-Path $sitePackages) {
        Get-ChildItem -LiteralPath $sitePackages -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -like "pip-*.dist-info" -or
                $_.Name -eq "wheel" -or
                $_.Name -like "wheel-*.dist-info" -or
                $_.Name -like "imageio_ffmpeg-*.dist-info"
            } |
            ForEach-Object {
                Assert-ChildPath $PythonDir $_.FullName
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }

        $transformerModels = Join-Path $sitePackages "transformers\models"
        if (Test-Path $transformerModels) {
            Get-ChildItem -LiteralPath $transformerModels -Directory -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notin @("auto", "clip") } |
                ForEach-Object {
                    Assert-ChildPath $PythonDir $_.FullName
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
        }
    }
}

function Remove-PortableSourceWaste([string]$DistDir) {
    foreach ($relative in @("scripts", "video_sim")) {
        $target = Join-Path $DistDir $relative
        if (-not (Test-Path $target)) {
            continue
        }

        Get-ChildItem -LiteralPath $target -Recurse -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq "__pycache__" } |
            ForEach-Object {
                Assert-ChildPath $DistDir $_.FullName
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }

        Get-ChildItem -LiteralPath $target -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in @(".pyc", ".pyo") } |
            ForEach-Object {
                Assert-ChildPath $DistDir $_.FullName
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            }
    }
}

function Get-BundledPythonExe([string]$PortablePythonExe, [string]$VenvPythonExe) {
    if (Test-Path $PortablePythonExe) {
        return $PortablePythonExe
    }
    if (Test-Path $VenvPythonExe) {
        return $VenvPythonExe
    }
    throw "Bundled Python executable not found. Expected one of: $PortablePythonExe or $VenvPythonExe"
}

function Test-BundledPythonEnv([string]$PythonExe, [bool]$RequireCuda = $false) {
    Write-Host "  - Verifying bundled Python dependencies" -ForegroundColor Gray
    $cudaRequiredLiteral = if ($RequireCuda) { "True" } else { "False" }
    $probe = @"
import importlib.util
missing = [name for name in ["numpy", "torch", "transformers", "PIL", "cv2", "decord", "faiss", "imagehash", "tqdm"] if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit("Missing modules: " + ", ".join(missing))
import torch
from transformers import CLIPImageProcessor, CLIPVisionModel
print("Torch:", torch.__version__)
print("Torch CUDA:", torch.version.cuda)
print("CUDA available:", torch.cuda.is_available())
if $cudaRequiredLiteral and not torch.version.cuda:
    raise SystemExit("CUDA is required for this GPU package, but this torch build has no CUDA runtime")
print("Bundled Python env OK")
"@
    Invoke-Checked { $probe | & $PythonExe - } "Bundled Python dependency probe failed."
}

function Test-TorchCudaReady([string]$PythonExe) {
    if (-not (Test-Path $PythonExe)) {
        return $false
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $PythonExe -c "import torch; raise SystemExit(0 if torch.version.cuda else 1)" *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Assert-PortablePackage([string]$DistDir, [bool]$RequireCuda = $false) {
    $required = @(
        "video-similarity-desktop.exe",
        "env\python\python.exe",
        "env\ffmpeg.exe",
        "env\ffprobe.exe",
        "data",
        "data\reports",
        "models",
        "scripts\batch_compare.py",
        "scripts\merge_videos.py",
        "video_sim\candidate_selector.py",
        "video_sim\matcher.py",
        "video_sim\preprocess.py"
    )

    foreach ($relative in $required) {
        $target = Join-Path $DistDir $relative
        if (-not (Test-Path $target)) {
            throw "Portable package is incomplete. Missing: $relative"
        }
    }

    foreach ($tool in @("ffmpeg.exe", "ffprobe.exe")) {
        $toolPath = Join-Path $DistDir "env\$tool"
        if ((Get-Item -LiteralPath $toolPath).Length -lt 5MB) {
            throw "$tool is too small to be the bundled standalone runtime."
        }
        $versionOutput = & $toolPath -version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "$tool failed its portable package version check."
        }
        Write-Host ($versionOutput | Select-Object -First 1)
    }

    $distPython = Join-Path $DistDir "env\python\python.exe"
    Test-BundledPythonEnv $distPython $RequireCuda
    Invoke-Checked {
        & $distPython -m py_compile `
            (Join-Path $DistDir "scripts\batch_compare.py") `
            (Join-Path $DistDir "scripts\merge_videos.py") `
            (Join-Path $DistDir "video_sim\candidate_selector.py") `
            (Join-Path $DistDir "video_sim\preprocess.py") `
            (Join-Path $DistDir "video_sim\frame_sampler.py") `
            (Join-Path $DistDir "video_sim\matcher.py") `
            (Join-Path $DistDir "video_sim\reporter.py")
    } "Portable package Python compile check failed."
    Remove-PortableSourceWaste $DistDir
}

function Read-RequirementLines([string]$Path) {
    Get-Content -LiteralPath $Path -Encoding UTF8 |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith("#") }
}

$desktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $desktopDir ".."))

if ($GpuBuild) {
    if (-not $PSBoundParameters.ContainsKey("DistName")) {
        $DistName = "dist_windows_gpu"
    }
    if (-not $PSBoundParameters.ContainsKey("TorchIndexUrl")) {
        $TorchIndexUrl = $GpuTorchIndexUrl
    }
}

if (-not $EnvName.Trim()) {
    $EnvName = if ($GpuBuild) { "env_gpu" } else { "env" }
}

$distDir = Join-Path $desktopDir $DistName
$envDir = Join-Path $desktopDir $EnvName
$legacyRuntimeDir = Join-Path $desktopDir "runtime"
$legacyPythonEnvDir = Join-Path $legacyRuntimeDir "python"
$pythonEnvDir = Join-Path $envDir "python"
$venvPythonExe = Join-Path $pythonEnvDir "Scripts\python.exe"
$portablePythonExe = Join-Path $pythonEnvDir "python.exe"
$releaseDir = Join-Path $desktopDir "src-tauri\target\release"
$bundleDir = Join-Path $releaseDir "bundle"
$appExe = Join-Path $releaseDir "video-similarity-desktop.exe"
$requirements = Join-Path $repoRoot "requirements.txt"
$defaultRuntimeRequirements = Join-Path $desktopDir "requirements-runtime.txt"
$runtimeRequirements = if ($RuntimeRequirements.Trim()) {
    [System.IO.Path]::GetFullPath($RuntimeRequirements.Trim())
} elseif (Test-Path $defaultRuntimeRequirements) {
    $defaultRuntimeRequirements
} else {
    $requirements
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Video Similarity - Windows Packager" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Project root : $repoRoot"
Write-Host "Desktop dir  : $desktopDir"
Write-Host "Output dir   : $distDir"
Write-Host "Env dir      : $envDir"
Write-Host "Runtime reqs : $runtimeRequirements"
Write-Host "Build flavor : $(if ($GpuBuild) { "GPU / CUDA" } else { "CPU" })"
Write-Host "Torch index  : $TorchIndexUrl"

Set-Location $desktopDir

if (-not (Test-Path (Join-Path $envDir "ffmpeg.exe")) -or -not (Test-Path (Join-Path $envDir "ffprobe.exe"))) {
    Write-Step "[0/9] Downloading standalone FFmpeg runtime..."
    $prepareFfmpeg = Join-Path $repoRoot "scripts\prepare-ffmpeg-runtime.ps1"
    if (-not (Test-Path $prepareFfmpeg)) {
        throw "FFmpeg preparation script was not found: $prepareFfmpeg"
    }
    & $prepareFfmpeg -DestinationDir $envDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to prepare the standalone FFmpeg runtime."
    }
}

Write-Step "[1/9] Checking build tools..."
Initialize-BuildToolPath
$nodePath = Assert-BuildCommand "node" "Install Node.js LTS first: winget install OpenJS.NodeJS.LTS"
$npmPath = Assert-BuildCommand "npm" "npm is installed with Node.js. Reinstall Node.js LTS or add npm to PATH."
$rustcPath = Assert-BuildCommand "rustc" "Install Rust with: winget install Rustlang.Rustup ; then reopen the terminal. If Rust is already installed, add %USERPROFILE%\.cargo\bin to PATH."
$cargoPath = Assert-BuildCommand "cargo" "Cargo is installed with Rust. Run rustup default stable, or add %USERPROFILE%\.cargo\bin to PATH."
Write-Host "  - Node.js: $(node --version)" -ForegroundColor Green
Write-Host "            $nodePath" -ForegroundColor DarkGray
Write-Host "  - npm    : $(npm --version)" -ForegroundColor Green
Write-Host "            $npmPath" -ForegroundColor DarkGray
Write-Host "  - Rust   : $(rustc --version)" -ForegroundColor Green
Write-Host "            $rustcPath" -ForegroundColor DarkGray
Write-Host "  - Cargo  : $(cargo --version)" -ForegroundColor Green
Write-Host "            $cargoPath" -ForegroundColor DarkGray

Write-Step "[2/9] Preparing app icons..."
if (-not (Test-Path "src-tauri\icons")) {
    New-Item -ItemType Directory -Path "src-tauri\icons" -Force | Out-Null
}
$iconCopied = $false
foreach ($dir in @($desktopDir, $repoRoot)) {
    $png = Join-Path $dir "icon.png"
    $ico = Join-Path $dir "icon.ico"
    if (Test-Path $png) {
        Copy-Item -LiteralPath $png -Destination "src-tauri\icons\icon.png" -Force
        Write-Host "  - Copied icon.png" -ForegroundColor Green
        $iconCopied = $true
    }
    if (Test-Path $ico) {
        Copy-Item -LiteralPath $ico -Destination "src-tauri\icons\icon.ico" -Force
        Write-Host "  - Copied icon.ico" -ForegroundColor Green
        $iconCopied = $true
    }
    if ($iconCopied) { break }
}
if (-not $iconCopied) {
    Write-Host "  - Reusing existing Tauri icons" -ForegroundColor Gray
}

Write-Step "[3/9] Preparing bundled Python env..."
New-Item -ItemType Directory -Path $envDir -Force | Out-Null

if ((-not (Test-Path $pythonEnvDir)) -and (Test-Path $legacyPythonEnvDir)) {
    Assert-ChildPath $desktopDir $legacyPythonEnvDir
    Assert-ChildPath $desktopDir $pythonEnvDir
    Write-Host "  - Migrating existing runtime\\python to env\\python" -ForegroundColor Yellow
    Move-Item -LiteralPath $legacyPythonEnvDir -Destination $pythonEnvDir -Force
}

if ($SkipPythonEnv) {
    if (-not ((Test-Path $portablePythonExe) -or (Test-Path $venvPythonExe))) {
        throw "SkipPythonEnv was requested, but $EnvName\python was not found. Run without -SkipPythonEnv or use -CleanPythonEnv."
    }
    Write-Host "  - Skipped Python env creation by flag." -ForegroundColor Yellow
} else {
    if ($CleanPythonEnv -and (Test-Path $pythonEnvDir)) {
        Assert-ChildPath $desktopDir $pythonEnvDir
        Remove-Item -LiteralPath $pythonEnvDir -Recurse -Force
    }

    $hostPython = if ($Python.Trim()) { $Python.Trim() } elseif ($env:PYTHON) { $env:PYTHON } else { "python" }
    if (-not (Test-Path $venvPythonExe) -and -not (Test-Path $portablePythonExe)) {
        Write-Host "  - Creating venv with copies: $pythonEnvDir" -ForegroundColor Gray
        Invoke-Checked { & $hostPython -m venv --copies $pythonEnvDir } "Failed to create bundled Python environment."
    } else {
        Write-Host "  - Existing env found: $pythonEnvDir" -ForegroundColor Green
    }

    $runtimeCfg = Join-Path $pythonEnvDir "pyvenv.cfg"
    if ((Test-Path $portablePythonExe) -and (Test-Path $runtimeCfg)) {
        Remove-Item -LiteralPath $runtimeCfg -Force
    }

    $activePythonExe = if (Test-Path $portablePythonExe) { $portablePythonExe } else { $venvPythonExe }
    if (-not (Test-Path $activePythonExe)) {
        throw "Bundled Python executable not found: $activePythonExe"
    }

    $env:USE_TF = "0"
    $env:TRANSFORMERS_NO_TF = "1"
    $env:TF_CPP_MIN_LOG_LEVEL = "2"
    $env:PYTHONNOUSERSITE = "1"
    $env:PYTHONDONTWRITEBYTECODE = "1"

    Write-Host "  - Python: $(& $activePythonExe --version)" -ForegroundColor Green
    Invoke-Checked { & $activePythonExe -m pip install --no-cache-dir --upgrade pip wheel "setuptools<82" } "Failed to upgrade pip in bundled Python."

    $runtimePackages = @(Read-RequirementLines $runtimeRequirements)
    $torchPackages = @($runtimePackages | Where-Object { $_ -match '^torch([<>=!~].*)?$' })
    $otherPackages = @($runtimePackages | Where-Object { $_ -notmatch '^torch([<>=!~].*)?$' })

    if ($torchPackages.Count -gt 0) {
        if ($GpuBuild -and (Test-TorchCudaReady $activePythonExe) -and -not $CleanPythonEnv) {
            Write-Host "  - CUDA torch already available; skipping torch reinstall." -ForegroundColor Green
        } elseif ($GpuBuild) {
            Write-Host "  - Installing CUDA torch from: $TorchIndexUrl" -ForegroundColor Gray
            Invoke-Checked { & $activePythonExe -m pip install --no-cache-dir --upgrade --force-reinstall --index-url $TorchIndexUrl @torchPackages } "Failed to install CUDA torch into bundled env."
        } else {
            Write-Host "  - Installing CPU torch from: $TorchIndexUrl" -ForegroundColor Gray
            Invoke-Checked { & $activePythonExe -m pip install --no-cache-dir --index-url $TorchIndexUrl @torchPackages } "Failed to install CPU torch into bundled env."
        }
    }
    if ($otherPackages.Count -gt 0) {
        Invoke-Checked { & $activePythonExe -m pip install --no-cache-dir @otherPackages } "Failed to install Python dependencies into bundled env."
    }

    Complete-PythonRuntime $pythonEnvDir $activePythonExe
if (-not $NoPrunePythonEnv) {
        Remove-PythonEnvWaste $pythonEnvDir
    }
    $baseForRepair = (& $hostPython -c "import sys; print(sys.base_prefix)") 2>$null
    if ($baseForRepair -and (Test-Path $baseForRepair)) {
        Copy-PythonExecutableFiles $baseForRepair $pythonEnvDir
    }
    $activePythonExe = Get-BundledPythonExe $portablePythonExe $venvPythonExe
    Test-BundledPythonEnv $activePythonExe $GpuBuild

    $envNote = @"
Video Similarity bundled Python env
Created: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Python: $(& $activePythonExe --version)
Runtime requirements: $runtimeRequirements
Build flavor: $(if ($GpuBuild) { "GPU / CUDA" } else { "CPU" })
Torch index: $TorchIndexUrl

The Tauri backend automatically uses env\python when the in-app Python path is left as "python".
"@
    Set-Content -LiteralPath (Join-Path $envDir "ENVIRONMENT.txt") -Value $envNote -Encoding UTF8
}

$activePythonExe = Get-BundledPythonExe $portablePythonExe $venvPythonExe
Test-BundledPythonEnv $activePythonExe $GpuBuild

Write-Step "[4/9] Installing frontend dependencies..."
if ($SkipNpmInstall) {
    Write-Host "  - Skipped npm install by flag." -ForegroundColor Yellow
} else {
    if (Test-Path (Join-Path $desktopDir "package-lock.json")) {
        Invoke-Checked { npm ci } "npm ci failed."
    } else {
        Invoke-Checked { npm install } "npm install failed."
    }
}

if ($SkipNpmAudit) {
    Write-Host "  - Skipped npm audit by flag." -ForegroundColor Yellow
} else {
    Invoke-Checked { npm audit --audit-level=high } "npm audit found high severity vulnerabilities. Run npm audit fix or update package.json/package-lock.json."
}

Write-Step "[5/9] Building frontend..."
if ($SkipFrontendBuild) {
    Write-Host "  - Skipped frontend build by flag." -ForegroundColor Yellow
} else {
    Invoke-Checked { npm run build } "Frontend build failed."
}

Write-Step "[6/9] Checking Windows build mode..."
if (-not $SkipTauriBuild) {
    Invoke-Checked { npx tauri --version | Out-Null } "Tauri CLI is not available. Run npm install first."
    Write-Host "  - Tauri CLI ready" -ForegroundColor Green
}
if ($BuildInstaller) {
    Write-Host "  - Installer build is enabled" -ForegroundColor Yellow
} else {
    Write-Host "  - Portable build mode; NSIS installer is skipped" -ForegroundColor Green
}

Write-Step "[7/9] Building Windows app..."
if (-not $SkipTauriBuild) {
    Stop-ExecutableIfRunning $appExe "release build artifact"
}
if ($SkipTauriBuild) {
    Write-Host "  - Skipped Tauri build by flag." -ForegroundColor Yellow
} elseif ($BuildInstaller) {
    if (Test-Path $bundleDir) {
        Assert-ChildPath $desktopDir $bundleDir
        Remove-DirectoryWithRetry $bundleDir "Tauri bundle directory"
    }
    $tauriConfigOverride = Join-Path $env:TEMP "video-similarity-tauri-build-override.json"
    $tauriOverride = @{
        build = @{ beforeBuildCommand = "" }
        bundle = @{
            resources = @(
                "../../scripts",
                "../../video_sim",
                "../../requirements.txt",
                "../$EnvName"
            )
        }
    } | ConvertTo-Json -Depth 5
    Set-Content -LiteralPath $tauriConfigOverride -Value $tauriOverride -Encoding ASCII
    Invoke-Checked { npx tauri build --features custom-protocol --config $tauriConfigOverride } "Tauri installer build failed."
} else {
    $tauriConfigOverride = Join-Path $env:TEMP "video-similarity-tauri-build-override.json"
    $tauriOverride = @{
        build = @{ beforeBuildCommand = "" }
        bundle = @{
            resources = @(
                "../../scripts",
                "../../video_sim",
                "../../requirements.txt",
                "../$EnvName"
            )
        }
    } | ConvertTo-Json -Depth 5
    Set-Content -LiteralPath $tauriConfigOverride -Value $tauriOverride -Encoding ASCII
    Invoke-Checked { npx tauri build --no-bundle --features custom-protocol --config $tauriConfigOverride } "Portable release exe build failed."
}

Write-Step "[8/9] Creating portable $DistName package..."
if (Test-Path $distDir) {
    Remove-DistDirectory $distDir
}
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

$copiedArtifacts = 0
if (Test-Path $appExe) {
    Copy-Item -LiteralPath $appExe -Destination (Join-Path $distDir "video-similarity-desktop.exe") -Force
    $copiedArtifacts += 1
    Write-Host "  - Copied video-similarity-desktop.exe" -ForegroundColor Green
} else {
    Write-Host "  - Standalone exe not found: $appExe" -ForegroundColor Yellow
}

if ($BuildInstaller -and (Test-Path $bundleDir)) {
    $installerDir = Join-Path $distDir "installer"
    New-Item -ItemType Directory -Path $installerDir -Force | Out-Null
    Get-ChildItem -Path $bundleDir -Recurse -Include "*.exe", "*.msi" | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $installerDir $_.Name) -Force
        Write-Host "  - Copied installer\$($_.Name)" -ForegroundColor Green
    }
}

if ($copiedArtifacts -eq 0) {
    throw "No Windows build artifacts were copied. Expected output under: $releaseDir"
}

Copy-Directory (Join-Path $repoRoot "scripts") (Join-Path $distDir "scripts")
Copy-Directory (Join-Path $repoRoot "video_sim") (Join-Path $distDir "video_sim")
Remove-PortableSourceWaste $distDir
Copy-Item -LiteralPath $requirements -Destination (Join-Path $distDir "requirements.txt") -Force
Copy-Item -LiteralPath $runtimeRequirements -Destination (Join-Path $distDir "requirements-runtime.txt") -Force
Set-Content -LiteralPath (Join-Path $distDir "BUILD_FLAVOR.txt") -Value $(if ($GpuBuild) { "gpu" } else { "cpu" }) -Encoding ASCII

Copy-Directory $envDir (Join-Path $distDir "env")

New-Item -ItemType Directory -Path (Join-Path $distDir "data\reports") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $distDir "data\cache") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $distDir "data\frames") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $distDir "models") -Force | Out-Null

$launcher = @"
@echo off
setlocal
cd /d "%~dp0"
set "USE_TF=0"
set "TRANSFORMERS_NO_TF=1"
set "TF_CPP_MIN_LOG_LEVEL=2"
set "PYTHONNOUSERSITE=1"
set "VIDEO_SIM_FFMPEG=%~dp0env\ffmpeg.exe"
set "PATH=%~dp0env;%PATH%"
start "" "%~dp0video-similarity-desktop.exe"
"@
Set-Content -LiteralPath (Join-Path $distDir "run-video-similarity.bat") -Value $launcher -Encoding ASCII

$readme = @"
Video Similarity - Windows portable package

Output structure:
- video-similarity-desktop.exe: executable app.
- env\python\: bundled runtime and dependencies.
- env\ffmpeg.exe and env\ffprobe.exe: bundled standalone media tools.
- data\: analysis data and reports.

Run:
1. Double-click run-video-similarity.bat or video-similarity-desktop.exe.
2. Keep the in-app Python path as the default value "python" to use env\python automatically.
3. scripts, video_sim and requirements.txt are copied next to the exe.
4. Reports are written to data\reports by default.

Acceptance:
- Settings -> check environment should show Python and batch_compare.py as available.
- Analyze -> choose a video directory -> start analysis. The log panel should show real Python output.

Rebuild bundled Python env:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -CleanPythonEnv

Reuse an existing env quickly:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -SkipPythonEnv

Build GPU/CUDA portable package:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -GpuBuild -CleanPythonEnv

Reuse existing GPU env quickly:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -GpuBuild -SkipPythonEnv

Keep a running packaged app open and fail instead of auto-stopping it:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -NoStopRunningApp

Skip npm audit only when offline or after reviewing npm audit manually:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -SkipNpmAudit

Build optional NSIS installer:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -SkipPythonEnv -BuildInstaller
"@
Set-Content -LiteralPath (Join-Path $distDir "README_windows.txt") -Value $readme -Encoding ASCII

Assert-PortablePackage $distDir $GpuBuild

Write-Step "[9/9] Summary..."
Write-Host "  - Portable package: $distDir" -ForegroundColor Cyan
Write-Host "  - Bundled env     : $(if (Test-Path (Join-Path $distDir "env\python")) { "yes" } else { "no" })" -ForegroundColor Cyan
Write-Host ""
Get-ChildItem -LiteralPath $distDir | ForEach-Object {
    if ($_.PSIsContainer) {
        Write-Host "  - $($_.Name)\" -ForegroundColor White
    } else {
        $size = if ($_.Length -gt 1MB) { "{0:N1} MB" -f ($_.Length / 1MB) } else { "{0:N1} KB" -f ($_.Length / 1KB) }
        Write-Host "  - $($_.Name) ($size)" -ForegroundColor White
    }
}

Write-Host ""
Write-Host "Build complete." -ForegroundColor Green
