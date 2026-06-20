param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadZip,
    [Parameter(Mandatory = $true)]
    [string]$OutputExe,
    [string]$DisplayName = "Video Similarity GPU",
    [string]$InstallFolderName = "Video Similarity GPU",
    [string]$ExecutableName = "video-similarity-desktop.exe"
)

$ErrorActionPreference = "Stop"

$payloadPath = [System.IO.Path]::GetFullPath($PayloadZip)
$outputPath = [System.IO.Path]::GetFullPath($OutputExe)
if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
    throw "Payload ZIP was not found: $payloadPath"
}
New-Item -ItemType Directory -Force (Split-Path $outputPath -Parent) | Out-Null

$escapedDisplayName = $DisplayName.Replace("\", "\\").Replace('"', '\"')
$escapedInstallFolder = $InstallFolderName.Replace("\", "\\").Replace('"', '\"')
$escapedExecutableName = $ExecutableName.Replace("\", "\\").Replace('"', '\"')
$source = @"
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Windows.Forms;

internal static class VideoSimilarityInstaller
{
    private const string Marker = "VSIM_GPU_SFX_01!";
    private const string DisplayName = "$escapedDisplayName";
    private const string InstallFolderName = "$escapedInstallFolder";
    private const string ExecutableName = "$escapedExecutableName";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string target = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                InstallFolderName
            );
            bool launch = true;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--target" && i + 1 < args.Length)
                {
                    target = Path.GetFullPath(args[++i]);
                }
                else if (args[i] == "--no-launch")
                {
                    launch = false;
                }
            }

            ExtractPayload(target);
            string executable = Path.Combine(target, ExecutableName);
            if (!File.Exists(executable))
            {
                throw new FileNotFoundException("Installed application executable was not found.", executable);
            }

            if (launch)
            {
                Process.Start(new ProcessStartInfo(executable) {
                    WorkingDirectory = target,
                    UseShellExecute = true
                });
                MessageBox.Show(
                    DisplayName + " installed successfully to:\n" + target,
                    DisplayName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Installation failed:\n" + error.Message,
                DisplayName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }

    private static void ExtractPayload(string target)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        byte[] marker = Encoding.ASCII.GetBytes(Marker);
        const int footerSize = 32;
        long archiveOffset;
        long archiveLength;

        string tempZip = Path.Combine(
            Path.GetTempPath(),
            "video-similarity-" + Guid.NewGuid().ToString("N") + ".zip"
        );
        try
        {
            using (FileStream input = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (input.Length < footerSize)
                {
                    throw new InvalidDataException("Installer payload footer is missing.");
                }
                input.Seek(-footerSize, SeekOrigin.End);
                byte[] storedMarker = new byte[16];
                ReadExactly(input, storedMarker, 0, storedMarker.Length);
                for (int i = 0; i < marker.Length; i++)
                {
                    if (storedMarker[i] != marker[i])
                    {
                        throw new InvalidDataException("Installer payload marker is invalid.");
                    }
                }
                byte[] number = new byte[8];
                ReadExactly(input, number, 0, number.Length);
                archiveOffset = BitConverter.ToInt64(number, 0);
                ReadExactly(input, number, 0, number.Length);
                archiveLength = BitConverter.ToInt64(number, 0);
                if (archiveOffset < 0 || archiveLength <= 0 ||
                    archiveOffset + archiveLength + footerSize != input.Length)
                {
                    throw new InvalidDataException("Installer payload bounds are invalid.");
                }

                input.Seek(archiveOffset, SeekOrigin.Begin);
                using (FileStream output = new FileStream(tempZip, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    CopyRange(input, output, archiveLength);
                }
            }

            Directory.CreateDirectory(target);
            string targetRoot = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar) +
                Path.DirectorySeparatorChar;
            using (ZipArchive archive = ZipFile.OpenRead(tempZip))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string destination = Path.GetFullPath(Path.Combine(targetRoot, relative));
                    if (!destination.StartsWith(targetRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("Unsafe archive path: " + entry.FullName);
                    }
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal))
                    {
                        Directory.CreateDirectory(destination);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (Stream source = entry.Open())
                    using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        source.CopyTo(output);
                    }
                    File.SetLastWriteTime(destination, entry.LastWriteTime.LocalDateTime);
                }
            }
        }
        finally
        {
            if (File.Exists(tempZip))
            {
                File.Delete(tempZip);
            }
        }
    }

    private static void CopyRange(Stream input, Stream output, long bytes)
    {
        byte[] buffer = new byte[1024 * 1024];
        long remaining = bytes;
        while (remaining > 0)
        {
            int requested = (int)Math.Min(buffer.Length, remaining);
            int read = input.Read(buffer, 0, requested);
            if (read <= 0)
            {
                throw new EndOfStreamException("Installer payload ended unexpectedly.");
            }
            output.Write(buffer, 0, read);
            remaining -= read;
        }
    }

    private static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
    {
        while (count > 0)
        {
            int read = stream.Read(buffer, offset, count);
            if (read <= 0)
            {
                throw new EndOfStreamException();
            }
            offset += read;
            count -= read;
        }
    }
}
"@

$stubPath = [System.IO.Path]::ChangeExtension($outputPath, ".stub.exe")
try {
    Add-Type `
        -TypeDefinition $source `
        -Language CSharp `
        -OutputAssembly $stubPath `
        -OutputType WindowsApplication `
        -ReferencedAssemblies @(
            "System.dll",
            "System.IO.Compression.dll",
            "System.IO.Compression.FileSystem.dll",
            "System.Windows.Forms.dll"
        )

    $marker = [System.Text.Encoding]::ASCII.GetBytes("VSIM_GPU_SFX_01!")
    if ($marker.Length -ne 16) {
        throw "Self-extractor marker must be exactly 16 bytes."
    }

    $stubInfo = Get-Item -LiteralPath $stubPath
    $payloadInfo = Get-Item -LiteralPath $payloadPath
    $output = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    try {
        $stub = [System.IO.File]::OpenRead($stubPath)
        try { $stub.CopyTo($output) } finally { $stub.Dispose() }
        $payload = [System.IO.File]::OpenRead($payloadPath)
        try { $payload.CopyTo($output) } finally { $payload.Dispose() }
        $output.Write($marker, 0, $marker.Length)
        $offsetBytes = [System.BitConverter]::GetBytes([int64]$stubInfo.Length)
        $lengthBytes = [System.BitConverter]::GetBytes([int64]$payloadInfo.Length)
        $output.Write($offsetBytes, 0, $offsetBytes.Length)
        $output.Write($lengthBytes, 0, $lengthBytes.Length)
    } finally {
        $output.Dispose()
    }

    $result = Get-Item -LiteralPath $outputPath
    $expectedLength = $stubInfo.Length + $payloadInfo.Length + 32
    if ($result.Length -ne $expectedLength) {
        throw "Self-extractor size verification failed."
    }
    Write-Host "Created self-extracting installer: $outputPath"
    Write-Host "Payload bytes: $($payloadInfo.Length)"
    Write-Host "Installer bytes: $($result.Length)"
} finally {
    Remove-Item -LiteralPath $stubPath -Force -ErrorAction SilentlyContinue
}
