param(
    [Parameter(Mandatory = $true)]
    [string]$DesktopDir
)

$ErrorActionPreference = "Stop"

function Get-ComparablePath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

$desktopFull = Get-ComparablePath $DesktopDir
$envDir = Join-Path $desktopFull "env_gpu\python"
$portablePython = Join-Path $envDir "python.exe"
if (-not (Test-Path -LiteralPath $envDir)) {
    Write-Error "GPU environment directory does not exist: $envDir"
    exit 1
}

# The portable environment must match its bundled versioned Python DLL.  The full
# packager uses the env\python executable as its active interpreter, so a
# system-Python launcher must never be copied over it.
$pythonDll = Get-ChildItem -LiteralPath $envDir -Filter "python*.dll" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^python(?<major>\d)(?<minor>\d{2})\.dll$' } |
    Select-Object -First 1
if (-not $pythonDll) {
    Write-Error "Unable to determine the bundled Python version: python*.dll is missing from $envDir"
    exit 1
}
$expectedVersion = "{0}.{1}" -f $Matches.major, ([int]$Matches.minor)

$candidates = @(
    $portablePython,
    (Join-Path $desktopFull "src-tauri\target\release\_up_\env_gpu\python\python.exe"),
    (Join-Path $desktopFull "src-tauri\target\debug\_up_\env_gpu\python\python.exe")
)

function Find-CompatiblePython([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    try {
        $version = (& $Path -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null).Trim()
        if ($LASTEXITCODE -eq 0 -and $version -eq $expectedVersion) {
            return $Path
        }
    } catch {
        return $null
    }
    return $null
}

$selected = $null
foreach ($candidate in $candidates) {
    $selected = Find-CompatiblePython $candidate
    if ($selected) {
        break
    }
}
if (-not $selected) {
    $foundVersions = @()
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            try {
                $foundVersions += "${candidate}: $((& $candidate --version 2>&1).Trim())"
            } catch {
                $foundVersions += "${candidate}: unavailable"
            }
        }
    }
    $details = if ($foundVersions.Count) { $foundVersions -join "; " } else { "no candidate executable found" }
    Write-Error "GPU environment requires Python $expectedVersion, but no compatible interpreter is available ($details). Recreate env_gpu with the matching Python runtime."
    exit 1
}

# If an earlier build copied a system Python over env_gpu\python, repair only
# the launcher/runtime files from a known compatible packaged candidate.  The
# site-packages tree is intentionally left untouched.
$selectedFull = Get-ComparablePath $selected
$portableFull = Get-ComparablePath $portablePython
if (-not $selectedFull.Equals($portableFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    $sourceDir = Split-Path -Parent $selectedFull
    foreach ($name in @("python.exe", "pythonw.exe", "python3.dll", "vcruntime140.dll", "vcruntime140_1.dll")) {
        $source = Join-Path $sourceDir $name
        $destination = Join-Path $envDir $name
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination $destination -Force
        }
    }
    Get-ChildItem -LiteralPath $sourceDir -Filter "python*.dll" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^python\d+\.dll$' } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $envDir $_.Name) -Force
        }
}

$finalVersion = (& $portablePython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $finalVersion -ne $expectedVersion) {
    Write-Error "Failed to prepare a compatible GPU Python interpreter at $portablePython (expected $expectedVersion, got $finalVersion)."
    exit 1
}

# stdout is consumed by build-windows-gpu.bat; keep it to one machine-readable
# path so diagnostics on stderr do not become command-line arguments.
Write-Output $portablePython
