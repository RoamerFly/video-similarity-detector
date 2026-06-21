param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadZip,
    [Parameter(Mandatory = $true)]
    [string]$OutputExe,
    [string]$DisplayName = "Video Similarity",
    [string]$InstallFolderName = "Video Similarity",
    [string]$ExecutableName = "video-similarity-desktop.exe"
)

$ErrorActionPreference = "Stop"

$payloadPath = [System.IO.Path]::GetFullPath($PayloadZip)
$outputPath = [System.IO.Path]::GetFullPath($OutputExe)
if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
    throw "Payload ZIP was not found: $payloadPath"
}
New-Item -ItemType Directory -Force (Split-Path $outputPath -Parent) | Out-Null

function Convert-ToCSharpLiteral([string]$Value) {
    return $Value.Replace("\", "\\").Replace('"', '\"')
}

$escapedDisplayName = Convert-ToCSharpLiteral $DisplayName
$escapedInstallFolder = Convert-ToCSharpLiteral $InstallFolderName
$escapedExecutableName = Convert-ToCSharpLiteral $ExecutableName
$uninstallerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("video-similarity-uninstall-" + [guid]::NewGuid().ToString("N") + ".exe")
$uninstallerSource = @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class VideoSimilarityUninstaller
{
    internal const string DisplayName = "$escapedDisplayName";
    internal const string ExecutableName = "$escapedExecutableName";
    internal const string RegistryKeyName = "VideoSimilarity-$escapedInstallFolder";
    internal const string AppIdentifier = "com.videosimilarity.desktop";

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (UninstallerForm form = new UninstallerForm(args))
        {
            Application.Run(form);
            return form.ExitCode;
        }
    }
}

internal sealed class UninstallerForm : Form
{
    private readonly string installRoot;
    private readonly CheckBox preserveData;
    private readonly Label statusLabel;
    private readonly ProgressBar progressBar;
    private readonly Button uninstallButton;
    private readonly Button cancelButton;
    private readonly BackgroundWorker worker;
    private readonly bool autoStart;
    private readonly bool autoClose;
    private bool completed;
    private bool cleanupScheduled;

    internal int ExitCode { get; private set; }

    internal UninstallerForm(string[] args)
    {
        installRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        autoStart = HasArgument(args, "--auto-start");
        autoClose = HasArgument(args, "--auto-close");
        bool removeData = HasArgument(args, "--remove-data");
        ExitCode = 1;

        Text = "\u5378\u8f7d " + VideoSimilarityUninstaller.DisplayName;
        ClientSize = new Size(560, 330);
        MinimumSize = new Size(560, 365);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        BackColor = Color.FromArgb(246, 248, 253);
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

        Panel banner = new Panel();
        banner.Dock = DockStyle.Top;
        banner.Height = 82;
        banner.BackColor = Color.FromArgb(158, 45, 65);
        Controls.Add(banner);

        Label heading = new Label();
        heading.AutoSize = false;
        heading.Location = new Point(26, 16);
        heading.Size = new Size(505, 30);
        heading.ForeColor = Color.White;
        heading.Font = new Font(Font.FontFamily, 16F, FontStyle.Bold);
        heading.Text = "\u5378\u8f7d " + VideoSimilarityUninstaller.DisplayName;
        banner.Controls.Add(heading);

        Label description = new Label();
        description.AutoSize = false;
        description.Location = new Point(28, 50);
        description.Size = new Size(500, 22);
        description.ForeColor = Color.FromArgb(255, 225, 231);
        description.Text = "\u53ef\u9009\u62e9\u4fdd\u7559\u89c6\u9891\u3001\u7f13\u5b58\u3001\u62a5\u544a\u548c\u5176\u4ed6\u7528\u6237\u6570\u636e\u3002";
        banner.Controls.Add(description);

        Label pathLabel = new Label();
        pathLabel.AutoSize = false;
        pathLabel.Location = new Point(28, 104);
        pathLabel.Size = new Size(505, 42);
        pathLabel.Text = "\u5b89\u88c5\u4f4d\u7f6e\uff1a" + installRoot;
        pathLabel.ForeColor = Color.FromArgb(70, 78, 98);
        Controls.Add(pathLabel);

        preserveData = new CheckBox();
        preserveData.AutoSize = true;
        preserveData.Location = new Point(28, 158);
        preserveData.Text = "\u4fdd\u7559\u7528\u6237\u6570\u636e\uff08data\u3001videos\u3001embeddings\uff09";
        preserveData.Checked = !removeData;
        Controls.Add(preserveData);

        statusLabel = new Label();
        statusLabel.AutoSize = false;
        statusLabel.Location = new Point(28, 196);
        statusLabel.Size = new Size(505, 24);
        statusLabel.Text = "\u70b9\u51fb\u201c\u5378\u8f7d\u201d\u540e\u5c06\u5173\u95ed\u5df2\u5b89\u88c5\u7684\u5e94\u7528\u5e76\u5220\u9664\u7a0b\u5e8f\u6587\u4ef6\u3002";
        Controls.Add(statusLabel);

        progressBar = new ProgressBar();
        progressBar.Location = new Point(28, 226);
        progressBar.Size = new Size(504, 18);
        progressBar.Style = ProgressBarStyle.Continuous;
        Controls.Add(progressBar);

        uninstallButton = new Button();
        uninstallButton.Location = new Point(332, 270);
        uninstallButton.Size = new Size(96, 34);
        uninstallButton.Text = "\u5378\u8f7d";
        uninstallButton.BackColor = Color.FromArgb(180, 50, 72);
        uninstallButton.ForeColor = Color.White;
        uninstallButton.FlatStyle = FlatStyle.Flat;
        uninstallButton.FlatAppearance.BorderSize = 0;
        uninstallButton.Click += UninstallButtonClick;
        Controls.Add(uninstallButton);

        cancelButton = new Button();
        cancelButton.Location = new Point(436, 270);
        cancelButton.Size = new Size(96, 34);
        cancelButton.Text = "\u53d6\u6d88";
        cancelButton.Click += delegate { Close(); };
        Controls.Add(cancelButton);

        worker = new BackgroundWorker();
        worker.WorkerReportsProgress = true;
        worker.DoWork += WorkerDoWork;
        worker.ProgressChanged += WorkerProgressChanged;
        worker.RunWorkerCompleted += WorkerCompleted;

        FormClosing += UninstallerFormClosing;
        Shown += delegate {
            if (autoStart)
            {
                BeginInvoke(new MethodInvoker(BeginUninstall));
            }
        };
    }

    private static bool HasArgument(string[] args, string value)
    {
        foreach (string item in args)
        {
            if (String.Equals(item, value, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private void UninstallButtonClick(object sender, EventArgs e)
    {
        if (completed)
        {
            ScheduleSelfCleanup();
            Close();
            return;
        }
        if (!autoStart && MessageBox.Show(
            this,
            preserveData.Checked
                ? "\u786e\u5b9a\u5378\u8f7d\u7a0b\u5e8f\u5e76\u4fdd\u7559\u7528\u6237\u6570\u636e\u5417\uff1f"
                : "\u786e\u5b9a\u5b8c\u5168\u5378\u8f7d\u5e76\u5220\u9664\u6240\u6709\u672c\u5730\u6570\u636e\u5417\uff1f",
            Text,
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning
        ) != DialogResult.Yes)
        {
            return;
        }
        BeginUninstall();
    }

    private void BeginUninstall()
    {
        if (worker.IsBusy)
        {
            return;
        }
        if (!File.Exists(Path.Combine(installRoot, VideoSimilarityUninstaller.ExecutableName)) &&
            !File.Exists(Path.Combine(installRoot, ".video-similarity-install.json")))
        {
            MessageBox.Show(this, "\u5f53\u524d\u76ee\u5f55\u4e0d\u662f\u6709\u6548\u7684 Video Similarity \u5b89\u88c5\u76ee\u5f55\u3002", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        preserveData.Enabled = false;
        uninstallButton.Enabled = false;
        cancelButton.Enabled = false;
        progressBar.Style = ProgressBarStyle.Marquee;
        statusLabel.Text = "\u6b63\u5728\u5378\u8f7d\u7a0b\u5e8f...";
        worker.RunWorkerAsync(preserveData.Checked);
    }

    private void WorkerDoWork(object sender, DoWorkEventArgs e)
    {
        bool keepData = (bool)e.Argument;
        BackgroundWorker backgroundWorker = (BackgroundWorker)sender;
        backgroundWorker.ReportProgress(10, "\u6b63\u5728\u5173\u95ed\u5e94\u7528...");
        StopInstalledApplication();
        backgroundWorker.ReportProgress(30, "\u6b63\u5728\u5220\u9664\u5feb\u6377\u65b9\u5f0f\u548c\u5378\u8f7d\u4fe1\u606f...");
        RemoveShortcutsAndRegistry();
        backgroundWorker.ReportProgress(50, "\u6b63\u5728\u5220\u9664\u7a0b\u5e8f\u6587\u4ef6...");
        DeleteInstalledFiles(keepData);
        if (!keepData)
        {
            DeleteApplicationSettings();
        }
        backgroundWorker.ReportProgress(100, keepData
            ? "\u5378\u8f7d\u5b8c\u6210\uff0c\u7528\u6237\u6570\u636e\u5df2\u4fdd\u7559\u3002"
            : "\u5b8c\u5168\u5378\u8f7d\u5b8c\u6210\u3002");
    }

    private void WorkerProgressChanged(object sender, ProgressChangedEventArgs e)
    {
        statusLabel.Text = Convert.ToString(e.UserState);
    }

    private void WorkerCompleted(object sender, RunWorkerCompletedEventArgs e)
    {
        progressBar.Style = ProgressBarStyle.Continuous;
        if (e.Error != null)
        {
            statusLabel.Text = "\u5378\u8f7d\u5931\u8d25\uff1a" + e.Error.Message;
            uninstallButton.Enabled = true;
            cancelButton.Enabled = true;
            preserveData.Enabled = true;
            return;
        }
        completed = true;
        ExitCode = 0;
        progressBar.Value = 100;
        uninstallButton.Enabled = true;
        uninstallButton.Text = "\u5b8c\u6210";
        cancelButton.Visible = false;
        if (autoClose)
        {
            ScheduleSelfCleanup();
            BeginInvoke(new MethodInvoker(Close));
        }
    }

    private void UninstallerFormClosing(object sender, FormClosingEventArgs e)
    {
        if (worker.IsBusy)
        {
            e.Cancel = true;
            return;
        }
        if (completed)
        {
            ScheduleSelfCleanup();
        }
    }

    private void StopInstalledApplication()
    {
        string expected = Path.GetFullPath(Path.Combine(installRoot, VideoSimilarityUninstaller.ExecutableName));
        string processName = Path.GetFileNameWithoutExtension(VideoSimilarityUninstaller.ExecutableName);
        foreach (Process process in Process.GetProcessesByName(processName))
        {
            try
            {
                string candidate = Path.GetFullPath(process.MainModule.FileName);
                if (String.Equals(candidate, expected, StringComparison.OrdinalIgnoreCase))
                {
                    process.Kill();
                    process.WaitForExit(10000);
                }
            }
            catch
            {
            }
        }
    }

    private void RemoveShortcutsAndRegistry()
    {
        foreach (string shortcut in new string[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), VideoSimilarityUninstaller.DisplayName + ".lnk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), VideoSimilarityUninstaller.DisplayName + ".lnk")
        })
        {
            try
            {
                if (File.Exists(shortcut))
                {
                    File.Delete(shortcut);
                }
            }
            catch
            {
            }
        }
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree(
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + VideoSimilarityUninstaller.RegistryKeyName,
                false
            );
        }
        catch
        {
        }
    }

    private void DeleteInstalledFiles(bool keepData)
    {
        string self = Path.GetFullPath(Application.ExecutablePath);
        foreach (string entry in Directory.GetFileSystemEntries(installRoot))
        {
            string full = Path.GetFullPath(entry);
            if (String.Equals(full, self, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            string name = Path.GetFileName(full);
            if (keepData && (
                String.Equals(name, "data", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(name, "videos", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(name, "embeddings", StringComparison.OrdinalIgnoreCase)
            ))
            {
                continue;
            }
            if (Directory.Exists(full))
            {
                Directory.Delete(full, true);
            }
            else if (File.Exists(full))
            {
                File.Delete(full);
            }
        }
    }

    private void DeleteApplicationSettings()
    {
        foreach (Environment.SpecialFolder folder in new Environment.SpecialFolder[] {
            Environment.SpecialFolder.ApplicationData,
            Environment.SpecialFolder.LocalApplicationData
        })
        {
            string path = Path.Combine(
                Environment.GetFolderPath(folder),
                VideoSimilarityUninstaller.AppIdentifier
            );
            try
            {
                if (Directory.Exists(path))
                {
                    Directory.Delete(path, true);
                }
            }
            catch
            {
            }
        }
    }

    private void ScheduleSelfCleanup()
    {
        if (cleanupScheduled)
        {
            return;
        }
        cleanupScheduled = true;
        string self = Path.GetFullPath(Application.ExecutablePath);
        string command = "/C ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self +
            "\" & rmdir \"" + installRoot + "\" 2>nul";
        Process.Start(new ProcessStartInfo("cmd.exe", command) {
            CreateNoWindow = true,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden
        });
    }
}
"@

Add-Type `
    -TypeDefinition $uninstallerSource `
    -Language CSharp `
    -OutputAssembly $uninstallerPath `
    -OutputType WindowsApplication `
    -ReferencedAssemblies @(
        "System.dll",
        "System.Drawing.dll",
        "System.Windows.Forms.dll"
    )

[System.Reflection.Assembly]::LoadWithPartialName("System.IO.Compression") | Out-Null
[System.Reflection.Assembly]::LoadWithPartialName("System.IO.Compression.FileSystem") | Out-Null
$payloadArchive = [System.IO.Compression.ZipFile]::Open(
    $payloadPath,
    [System.IO.Compression.ZipArchiveMode]::Update
)
try {
    $existingUninstaller = $payloadArchive.GetEntry("uninstall.exe")
    if ($null -ne $existingUninstaller) {
        $existingUninstaller.Delete()
    }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $payloadArchive,
        $uninstallerPath,
        "uninstall.exe",
        [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
} finally {
    $payloadArchive.Dispose()
}

$source = @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class VideoSimilarityInstaller
{
    internal const string Marker = "VSIM_GPU_SFX_01!";
    internal const string DisplayName = "$escapedDisplayName";
    internal const string InstallFolderName = "$escapedInstallFolder";
    internal const string ExecutableName = "$escapedExecutableName";

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        InstallerOptions options = InstallerOptions.Parse(args);
        using (InstallerForm form = new InstallerForm(options))
        {
            Application.Run(form);
            return form.ExitCode;
        }
    }
}

internal static class TextValue
{
    internal static string Get(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }
}

internal sealed class InstallerOptions
{
    internal string Target;
    internal int WaitPid;
    internal bool IsUpdate;
    internal bool AutoStart;
    internal bool AutoClose;
    internal bool NoLaunch;
    internal bool NoShortcuts;

    internal static InstallerOptions Parse(string[] args)
    {
        InstallerOptions options = new InstallerOptions();
        options.Target = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs",
            VideoSimilarityInstaller.InstallFolderName
        );
        for (int i = 0; i < args.Length; i++)
        {
            if (String.Equals(args[i], "--target", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                options.Target = Path.GetFullPath(args[++i]);
            }
            else if (String.Equals(args[i], "--wait-pid", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                Int32.TryParse(args[++i], out options.WaitPid);
            }
            else if (String.Equals(args[i], "--update", StringComparison.OrdinalIgnoreCase))
            {
                options.IsUpdate = true;
            }
            else if (String.Equals(args[i], "--auto-start", StringComparison.OrdinalIgnoreCase))
            {
                options.AutoStart = true;
            }
            else if (String.Equals(args[i], "--auto-close", StringComparison.OrdinalIgnoreCase))
            {
                options.AutoClose = true;
            }
            else if (String.Equals(args[i], "--no-launch", StringComparison.OrdinalIgnoreCase))
            {
                options.NoLaunch = true;
            }
            else if (String.Equals(args[i], "--no-shortcuts", StringComparison.OrdinalIgnoreCase))
            {
                options.NoShortcuts = true;
            }
        }
        return options;
    }
}

internal sealed class InstallerForm : Form
{
    private readonly InstallerOptions options;
    private readonly Label heading;
    private readonly Label description;
    private readonly TextBox targetBox;
    private readonly Button browseButton;
    private readonly CheckBox desktopShortcut;
    private readonly CheckBox launchAfterInstall;
    private readonly ProgressBar progressBar;
    private readonly Label progressLabel;
    private readonly Label detailsLabel;
    private readonly Button installButton;
    private readonly Button cancelButton;
    private readonly BackgroundWorker worker;
    private bool completed;
    private bool createDesktopShortcutRequested;

    internal int ExitCode { get; private set; }

    internal InstallerForm(InstallerOptions options)
    {
        this.options = options;
        ExitCode = 1;
        Text = options.IsUpdate
            ? TextValue.Get("5pu05pawIA==") + VideoSimilarityInstaller.DisplayName
            : TextValue.Get("5a6J6KOFIA==") + VideoSimilarityInstaller.DisplayName;
        ClientSize = new Size(650, 410);
        MinimumSize = new Size(650, 445);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        BackColor = Color.FromArgb(245, 248, 255);
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

        Panel banner = new Panel();
        banner.Dock = DockStyle.Top;
        banner.Height = 92;
        banner.BackColor = Color.FromArgb(27, 92, 190);
        Controls.Add(banner);

        heading = new Label();
        heading.AutoSize = false;
        heading.Location = new Point(28, 18);
        heading.Size = new Size(590, 31);
        heading.ForeColor = Color.White;
        heading.Font = new Font(Font.FontFamily, 17F, FontStyle.Bold);
        heading.Text = options.IsUpdate
            ? TextValue.Get("5YeG5aSH5pu05pawIFZpZGVvIFNpbWlsYXJpdHk=")
            : TextValue.Get("5qyi6L+O5a6J6KOFIFZpZGVvIFNpbWlsYXJpdHk=");
        banner.Controls.Add(heading);

        description = new Label();
        description.AutoSize = false;
        description.Location = new Point(30, 53);
        description.Size = new Size(585, 24);
        description.ForeColor = Color.FromArgb(222, 235, 255);
        description.Text = options.IsUpdate
            ? TextValue.Get("5bCG6KaG55uW56iL5bqP5paH5Lu277yM5bm25L+d55WZ6KeG6aKR44CB57yT5a2Y44CB5oql5ZGK5ZKM55WM6Z2i6K6+572u44CC")
            : TextValue.Get("5a6J6KOF5YyF5bey5YyF5ZCrIFB5dGhvbuOAgeWIhuaekOS+nei1luOAgUZGbXBlZyDlkowgRkZwcm9iZeOAgg==");
        banner.Controls.Add(description);

        Label targetTitle = new Label();
        targetTitle.AutoSize = true;
        targetTitle.Location = new Point(30, 118);
        targetTitle.Font = new Font(Font, FontStyle.Bold);
        targetTitle.Text = TextValue.Get("5a6J6KOF5L2N572u");
        Controls.Add(targetTitle);

        targetBox = new TextBox();
        targetBox.Location = new Point(30, 145);
        targetBox.Size = new Size(490, 28);
        targetBox.Text = options.Target;
        targetBox.ReadOnly = options.IsUpdate;
        Controls.Add(targetBox);

        browseButton = new Button();
        browseButton.Location = new Point(530, 143);
        browseButton.Size = new Size(88, 31);
        browseButton.Text = TextValue.Get("5rWP6KeILi4u");
        browseButton.Enabled = !options.IsUpdate;
        browseButton.Click += BrowseButtonClick;
        Controls.Add(browseButton);

        desktopShortcut = new CheckBox();
        desktopShortcut.AutoSize = true;
        desktopShortcut.Location = new Point(30, 194);
        desktopShortcut.Text = TextValue.Get("5Yib5bu65qGM6Z2i5b+r5o235pa55byP");
        desktopShortcut.Checked = !options.IsUpdate && !options.NoShortcuts;
        Controls.Add(desktopShortcut);

        launchAfterInstall = new CheckBox();
        launchAfterInstall.AutoSize = true;
        launchAfterInstall.Location = new Point(220, 194);
        launchAfterInstall.Text = options.IsUpdate
            ? TextValue.Get("5pu05paw5a6M5oiQ5ZCO6YeN5paw5ZCv5Yqo")
            : TextValue.Get("5a6J6KOF5a6M5oiQ5ZCO6L+Q6KGM");
        launchAfterInstall.Checked = !options.NoLaunch;
        Controls.Add(launchAfterInstall);

        progressLabel = new Label();
        progressLabel.AutoSize = false;
        progressLabel.Location = new Point(30, 235);
        progressLabel.Size = new Size(588, 24);
        progressLabel.Text = options.IsUpdate
            ? TextValue.Get("54K55Ye74oCc56uL5Y2z5pu05paw4oCd5byA5aeL6KaG55uW5a6J6KOF44CC")
            : TextValue.Get("54K55Ye74oCc5a6J6KOF4oCd5byA5aeL44CC");
        Controls.Add(progressLabel);

        progressBar = new ProgressBar();
        progressBar.Location = new Point(30, 265);
        progressBar.Size = new Size(588, 19);
        progressBar.Style = ProgressBarStyle.Continuous;
        Controls.Add(progressBar);

        detailsLabel = new Label();
        detailsLabel.AutoSize = false;
        detailsLabel.Location = new Point(30, 294);
        detailsLabel.Size = new Size(588, 44);
        detailsLabel.ForeColor = Color.FromArgb(82, 92, 115);
        detailsLabel.Text = TextValue.Get("5a6J6KOF5pe25Lya5pu/5o2iIGVuduOAgXNjcmlwdHMg5ZKMIHZpZGVvX3Npbe+8m2RhdGHjgIF2aWRlb3PjgIFlbWJlZGRpbmdzIOS4jeS8muiiq+a4heeQhuOAgg==");
        Controls.Add(detailsLabel);

        installButton = new Button();
        installButton.Location = new Point(420, 353);
        installButton.Size = new Size(96, 34);
        installButton.Text = options.IsUpdate
            ? TextValue.Get("56uL5Y2z5pu05paw")
            : TextValue.Get("5a6J6KOF");
        installButton.BackColor = Color.FromArgb(36, 112, 220);
        installButton.ForeColor = Color.White;
        installButton.FlatStyle = FlatStyle.Flat;
        installButton.FlatAppearance.BorderSize = 0;
        installButton.Click += InstallButtonClick;
        Controls.Add(installButton);

        cancelButton = new Button();
        cancelButton.Location = new Point(522, 353);
        cancelButton.Size = new Size(96, 34);
        cancelButton.Text = TextValue.Get("5Y+W5raI");
        cancelButton.Click += CancelButtonClick;
        Controls.Add(cancelButton);

        worker = new BackgroundWorker();
        worker.WorkerReportsProgress = true;
        worker.WorkerSupportsCancellation = true;
        worker.DoWork += WorkerDoWork;
        worker.ProgressChanged += WorkerProgressChanged;
        worker.RunWorkerCompleted += WorkerCompleted;

        FormClosing += InstallerFormClosing;
        Shown += InstallerFormShown;
    }

    private void InstallerFormShown(object sender, EventArgs e)
    {
        if (options.AutoStart)
        {
            BeginInvoke(new MethodInvoker(BeginInstall));
        }
    }

    private void BrowseButtonClick(object sender, EventArgs e)
    {
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = TextValue.Get("6YCJ5oupIFZpZGVvIFNpbWlsYXJpdHkg5a6J6KOF55uu5b2V");
            dialog.SelectedPath = Directory.Exists(targetBox.Text)
                ? targetBox.Text
                : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                targetBox.Text = Path.Combine(dialog.SelectedPath, VideoSimilarityInstaller.InstallFolderName);
            }
        }
    }

    private void InstallButtonClick(object sender, EventArgs e)
    {
        if (completed)
        {
            Close();
            return;
        }
        BeginInstall();
    }

    private void BeginInstall()
    {
        if (worker.IsBusy)
        {
            return;
        }
        string target;
        try
        {
            target = Path.GetFullPath(targetBox.Text.Trim());
            string root = Path.GetPathRoot(target);
            if (String.IsNullOrWhiteSpace(target) ||
                String.Equals(target.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(TextValue.Get("5LiN6IO955u05o6l5a6J6KOF5Yiw56OB55uY5qC555uu5b2V44CC"));
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(this, TextValue.Get("5a6J6KOF6Lev5b6E5peg5pWI77ya") + Environment.NewLine + error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        options.Target = target;
        createDesktopShortcutRequested = desktopShortcut.Checked;
        targetBox.Text = target;
        targetBox.Enabled = false;
        browseButton.Enabled = false;
        desktopShortcut.Enabled = false;
        launchAfterInstall.Enabled = false;
        installButton.Enabled = false;
        cancelButton.Text = TextValue.Get("5Y+W5raI5a6J6KOF");
        progressBar.Value = 0;
        progressLabel.Text = options.WaitPid > 0
            ? TextValue.Get("5q2j5Zyo562J5b6F5bqU55So6YCA5Ye6Li4u")
            : TextValue.Get("5q2j5Zyo5YeG5aSH5a6J6KOFLi4u");
        worker.RunWorkerAsync();
    }

    private void CancelButtonClick(object sender, EventArgs e)
    {
        if (worker.IsBusy)
        {
            if (MessageBox.Show(this, TextValue.Get("5a6J6KOF5bCa5pyq5a6M5oiQ77yM56Gu5a6a5Y+W5raI5ZCX77yf"), Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            {
                worker.CancelAsync();
                cancelButton.Enabled = false;
                progressLabel.Text = TextValue.Get("5q2j5Zyo5Y+W5raILi4u");
            }
            return;
        }
        Close();
    }

    private void InstallerFormClosing(object sender, FormClosingEventArgs e)
    {
        if (worker.IsBusy)
        {
            e.Cancel = true;
            CancelButtonClick(sender, EventArgs.Empty);
        }
    }

    private void WorkerDoWork(object sender, DoWorkEventArgs e)
    {
        BackgroundWorker backgroundWorker = (BackgroundWorker)sender;
        if (options.WaitPid > 0)
        {
            backgroundWorker.ReportProgress(1, new ProgressInfo(TextValue.Get("5q2j5Zyo562J5b6F5pen54mI5pys5a6J5YWo6YCA5Ye6Li4u"), ""));
            WaitForProcessExit(options.WaitPid, backgroundWorker, e);
            if (e.Cancel)
            {
                return;
            }
        }

        ValidatePayload(options.Target);
        if (options.IsUpdate)
        {
            backgroundWorker.ReportProgress(2, new ProgressInfo(
                TextValue.Get("5q2j5Zyo5riF55CG5pen55qE56iL5bqP5paH5Lu2Li4u"),
                TextValue.Get("55So5oi35pWw5o2u55uu5b2V5Lya6KKr5L+d55WZ44CC")
            ));
            CleanupManagedFiles(options.Target);
        }

        ExtractPayload(options.Target, options.IsUpdate, backgroundWorker, e);
        if (e.Cancel)
        {
            return;
        }

        string executable = Path.Combine(options.Target, VideoSimilarityInstaller.ExecutableName);
        if (!File.Exists(executable))
        {
            throw new FileNotFoundException(TextValue.Get("5a6J6KOF5a6M5oiQ5ZCO5rKh5pyJ5om+5Yiw5bqU55So56iL5bqP44CC"), executable);
        }

        WriteInstallMarker(options.Target, options.IsUpdate);
        if (!options.NoShortcuts)
        {
            CreateShortcut(
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    VideoSimilarityInstaller.DisplayName + ".lnk"
                ),
                executable
            );
            if (createDesktopShortcutRequested)
            {
                CreateShortcut(
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                        VideoSimilarityInstaller.DisplayName + ".lnk"
                    ),
                    executable
                );
            }
        }
        RegisterUninstaller(options.Target, executable);
        backgroundWorker.ReportProgress(100, new ProgressInfo(TextValue.Get("5a6J6KOF5a6M5oiQ"), options.Target));
    }

    private void WorkerProgressChanged(object sender, ProgressChangedEventArgs e)
    {
        progressBar.Value = Math.Max(0, Math.Min(100, e.ProgressPercentage));
        ProgressInfo info = e.UserState as ProgressInfo;
        if (info != null)
        {
            progressLabel.Text = info.Stage;
            if (!String.IsNullOrWhiteSpace(info.Details))
            {
                detailsLabel.Text = info.Details;
            }
        }
    }

    private void WorkerCompleted(object sender, RunWorkerCompletedEventArgs e)
    {
        cancelButton.Enabled = true;
        if (e.Cancelled)
        {
            progressLabel.Text = TextValue.Get("5a6J6KOF5bey5Y+W5raI44CC");
            detailsLabel.Text = TextValue.Get("5Y+v5Lul6YeN5paw6L+Q6KGM5a6J6KOF56iL5bqP57un57ut5a6J6KOF44CC");
            ResetControls();
            return;
        }
        if (e.Error != null)
        {
            progressLabel.Text = TextValue.Get("5a6J6KOF5aSx6LSl44CC");
            detailsLabel.Text = e.Error.Message;
            MessageBox.Show(this, TextValue.Get("5a6J6KOF5aSx6LSl77ya") + Environment.NewLine + e.Error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            ResetControls();
            return;
        }

        completed = true;
        ExitCode = 0;
        heading.Text = options.IsUpdate
            ? TextValue.Get("5pu05paw5a6M5oiQ")
            : TextValue.Get("5a6J6KOF5a6M5oiQ");
        description.Text = TextValue.Get("56iL5bqP5paH5Lu25bey57uP5bCx57uq77yM55So5oi35pWw5o2u5L+d5oyB5LiN5Y+Y44CC");
        progressBar.Value = 100;
        installButton.Enabled = true;
        installButton.Text = TextValue.Get("5a6M5oiQ");
        cancelButton.Visible = false;
        if (launchAfterInstall.Checked)
        {
            string executable = Path.Combine(options.Target, VideoSimilarityInstaller.ExecutableName);
            Process.Start(new ProcessStartInfo(executable) {
                WorkingDirectory = options.Target,
                UseShellExecute = true
            });
        }
        if (options.AutoClose)
        {
            BeginInvoke(new MethodInvoker(Close));
        }
    }

    private void ResetControls()
    {
        targetBox.Enabled = true;
        targetBox.ReadOnly = options.IsUpdate;
        browseButton.Enabled = !options.IsUpdate;
        desktopShortcut.Enabled = true;
        launchAfterInstall.Enabled = true;
        installButton.Enabled = true;
        cancelButton.Text = TextValue.Get("5Y+W5raI");
    }

    private static void WaitForProcessExit(int pid, BackgroundWorker worker, DoWorkEventArgs e)
    {
        try
        {
            Process process = Process.GetProcessById(pid);
            while (!process.HasExited)
            {
                if (worker.CancellationPending)
                {
                    e.Cancel = true;
                    return;
                }
                Thread.Sleep(250);
                process.Refresh();
            }
        }
        catch (ArgumentException)
        {
        }
    }

    private static void CleanupManagedFiles(string target)
    {
        foreach (string relative in new string[] { "env", "scripts", "video_sim" })
        {
            string path = Path.Combine(target, relative);
            if (Directory.Exists(path))
            {
                Directory.Delete(path, true);
            }
        }
        foreach (string relative in new string[] {
            VideoSimilarityInstaller.ExecutableName,
            "requirements.txt",
            "requirements-runtime.txt",
            "run-video-similarity.bat",
            "README_windows.txt",
            "BUILD_FLAVOR.txt",
            "ENVIRONMENT.txt"
        })
        {
            string path = Path.Combine(target, relative);
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }

    private static void ValidatePayload(string target)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        long archiveOffset;
        long archiveLength;
        ReadPayloadBounds(self, out archiveOffset, out archiveLength);
        string targetRoot = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar) +
            Path.DirectorySeparatorChar;
        bool executableFound = false;
        using (FileStream input = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (SegmentStream segment = new SegmentStream(input, archiveOffset, archiveLength))
        using (ZipArchive archive = new ZipArchive(segment, ZipArchiveMode.Read, false))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                string destination = Path.GetFullPath(Path.Combine(targetRoot, relative));
                if (!destination.StartsWith(targetRoot, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException(TextValue.Get("5a6J6KOF5YyF5YyF5ZCr5LiN5a6J5YWo6Lev5b6E77ya") + entry.FullName);
                }
                if (String.Equals(
                    relative.TrimStart(Path.DirectorySeparatorChar),
                    VideoSimilarityInstaller.ExecutableName,
                    StringComparison.OrdinalIgnoreCase
                ))
                {
                    executableFound = true;
                }
            }
        }
        if (!executableFound)
        {
            throw new InvalidDataException("Installer payload does not contain the application executable.");
        }
    }

    private static void ExtractPayload(string target, bool preserveData, BackgroundWorker worker, DoWorkEventArgs e)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        long archiveOffset;
        long archiveLength;
        ReadPayloadBounds(self, out archiveOffset, out archiveLength);
        Directory.CreateDirectory(target);
        string targetRoot = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar) +
            Path.DirectorySeparatorChar;

        using (FileStream input = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (SegmentStream segment = new SegmentStream(input, archiveOffset, archiveLength))
        using (ZipArchive archive = new ZipArchive(segment, ZipArchiveMode.Read, false))
        {
            long total = 0;
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                if (!ShouldPreserveEntry(entry.FullName, preserveData) && !IsDirectory(entry))
                {
                    total += entry.Length;
                }
            }

            long written = 0;
            byte[] buffer = new byte[1024 * 1024];
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                if (worker.CancellationPending)
                {
                    e.Cancel = true;
                    return;
                }
                if (ShouldPreserveEntry(entry.FullName, preserveData))
                {
                    continue;
                }

                string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                string destination = Path.GetFullPath(Path.Combine(targetRoot, relative));
                if (!destination.StartsWith(targetRoot, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException(TextValue.Get("5a6J6KOF5YyF5YyF5ZCr5LiN5a6J5YWo6Lev5b6E77ya") + entry.FullName);
                }
                if (IsDirectory(entry))
                {
                    Directory.CreateDirectory(destination);
                    continue;
                }

                string parent = Path.GetDirectoryName(destination);
                if (!String.IsNullOrEmpty(parent))
                {
                    Directory.CreateDirectory(parent);
                }
                using (Stream source = entry.Open())
                using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 1024 * 1024))
                {
                    int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (worker.CancellationPending)
                        {
                            e.Cancel = true;
                            return;
                        }
                        output.Write(buffer, 0, read);
                        written += read;
                        int percent = total > 0
                            ? 3 + (int)Math.Min(95, written * 94 / total)
                            : 50;
                        worker.ReportProgress(
                            percent,
                            new ProgressInfo(
                                TextValue.Get("5q2j5Zyo5a6J6KOF56iL5bqP5paH5Lu2Li4u"),
                                entry.FullName + "  (" + FormatBytes(written) + " / " + FormatBytes(total) + ")"
                            )
                        );
                    }
                }
                try
                {
                    File.SetLastWriteTime(destination, entry.LastWriteTime.LocalDateTime);
                }
                catch
                {
                }
            }
        }
    }

    private static bool ShouldPreserveEntry(string name, bool preserveData)
    {
        if (!preserveData)
        {
            return false;
        }
        string normalized = name.Replace('\\', '/').TrimStart('/').ToLowerInvariant();
        return normalized == "data" || normalized.StartsWith("data/") ||
            normalized == "videos" || normalized.StartsWith("videos/") ||
            normalized == "embeddings" || normalized.StartsWith("embeddings/");
    }

    private static bool IsDirectory(ZipArchiveEntry entry)
    {
        return entry.FullName.EndsWith("/", StringComparison.Ordinal);
    }

    private static void ReadPayloadBounds(string self, out long archiveOffset, out long archiveLength)
    {
        byte[] marker = Encoding.ASCII.GetBytes(VideoSimilarityInstaller.Marker);
        const int footerSize = 32;
        using (FileStream input = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (input.Length < footerSize)
            {
                throw new InvalidDataException(TextValue.Get("5a6J6KOF5Zmo6LSf6L295LiN5a2Y5Zyo44CC"));
            }
            input.Seek(-footerSize, SeekOrigin.End);
            byte[] storedMarker = new byte[16];
            ReadExactly(input, storedMarker, 0, storedMarker.Length);
            for (int i = 0; i < marker.Length; i++)
            {
                if (storedMarker[i] != marker[i])
                {
                    throw new InvalidDataException(TextValue.Get("5a6J6KOF5Zmo6LSf6L295qCH6K6w5peg5pWI44CC"));
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
                throw new InvalidDataException(TextValue.Get("5a6J6KOF5Zmo6LSf6L296IyD5Zu05peg5pWI44CC"));
            }
        }
    }

    private static void WriteInstallMarker(string target, bool updated)
    {
        string executable = Path.Combine(target, VideoSimilarityInstaller.ExecutableName);
        string version = FileVersionInfo.GetVersionInfo(executable).FileVersion ?? "";
        string json = "{\r\n" +
            "  \"product\": \"" + EscapeJson(VideoSimilarityInstaller.DisplayName) + "\",\r\n" +
            "  \"version\": \"" + EscapeJson(version) + "\",\r\n" +
            "  \"installRoot\": \"" + EscapeJson(target) + "\",\r\n" +
            "  \"updated\": " + (updated ? "true" : "false") + "\r\n" +
            "}\r\n";
        File.WriteAllText(Path.Combine(target, ".video-similarity-install.json"), json, new UTF8Encoding(false));
    }

    private static void RegisterUninstaller(string target, string executable)
    {
        string uninstall = Path.Combine(target, "uninstall.exe");
        if (!File.Exists(uninstall))
        {
            throw new FileNotFoundException("Uninstaller was not installed.", uninstall);
        }
        string registryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoSimilarity-" +
            VideoSimilarityInstaller.InstallFolderName;
        using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(registryPath))
        {
            key.SetValue("DisplayName", VideoSimilarityInstaller.DisplayName);
            key.SetValue("DisplayVersion", FileVersionInfo.GetVersionInfo(executable).FileVersion ?? "");
            key.SetValue("InstallLocation", target);
            key.SetValue("DisplayIcon", executable + ",0");
            key.SetValue("UninstallString", "\"" + uninstall + "\"");
            key.SetValue("NoModify", 1, Microsoft.Win32.RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, Microsoft.Win32.RegistryValueKind.DWord);
        }
    }

    private static string EscapeJson(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static void CreateShortcut(string shortcutPath, string executable)
    {
        try
        {
            string parent = Path.GetDirectoryName(shortcutPath);
            if (!String.IsNullOrEmpty(parent))
            {
                Directory.CreateDirectory(parent);
            }
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                return;
            }
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember(
                "CreateShortcut",
                BindingFlags.InvokeMethod,
                null,
                shell,
                new object[] { shortcutPath }
            );
            Type shortcutType = shortcut.GetType();
            shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { executable });
            shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(executable) });
            shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { VideoSimilarityInstaller.DisplayName });
            shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { executable + ",0" });
            shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        catch
        {
        }
    }

    private static string FormatBytes(long bytes)
    {
        if (bytes >= 1024L * 1024L * 1024L)
        {
            return (bytes / 1024D / 1024D / 1024D).ToString("0.0") + " GB";
        }
        if (bytes >= 1024L * 1024L)
        {
            return (bytes / 1024D / 1024D).ToString("0.0") + " MB";
        }
        return (bytes / 1024D).ToString("0.0") + " KB";
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

internal sealed class ProgressInfo
{
    internal readonly string Stage;
    internal readonly string Details;

    internal ProgressInfo(string stage, string details)
    {
        Stage = stage;
        Details = details;
    }
}

internal sealed class SegmentStream : Stream
{
    private readonly Stream inner;
    private readonly long start;
    private readonly long length;
    private long position;

    internal SegmentStream(Stream inner, long start, long length)
    {
        this.inner = inner;
        this.start = start;
        this.length = length;
        position = 0;
        inner.Seek(start, SeekOrigin.Begin);
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return length; } }
    public override long Position
    {
        get { return position; }
        set { Seek(value, SeekOrigin.Begin); }
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (position >= length)
        {
            return 0;
        }
        int requested = (int)Math.Min(count, length - position);
        inner.Seek(start + position, SeekOrigin.Begin);
        int read = inner.Read(buffer, offset, requested);
        position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        long next;
        if (origin == SeekOrigin.Begin)
        {
            next = offset;
        }
        else if (origin == SeekOrigin.Current)
        {
            next = position + offset;
        }
        else
        {
            next = length + offset;
        }
        if (next < 0 || next > length)
        {
            throw new IOException(TextValue.Get("5a6J6KOF5Zmo6LSf6L295a6a5L2N6LaF5Ye66IyD5Zu044CC"));
        }
        position = next;
        inner.Seek(start + position, SeekOrigin.Begin);
        return position;
    }

    public override void Flush() { }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
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
            "System.Core.dll",
            "System.Drawing.dll",
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
    Write-Host "Created interactive installer: $outputPath"
    Write-Host "Payload bytes: $($payloadInfo.Length)"
    Write-Host "Installer bytes: $($result.Length)"
} finally {
    Remove-Item -LiteralPath $stubPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $uninstallerPath -Force -ErrorAction SilentlyContinue
}
