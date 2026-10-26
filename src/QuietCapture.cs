using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// Independent implementation of the documented Windows capture/hotkey APIs.
// No QuizCoze runtime, login, preview window, notification or network access.
static class Program
{
    internal static readonly string Folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Screenshots");

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);

    [STAThread]
    static int Main(string[] args)
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        try
        {
            if (args.Length == 2 && args[0] == "--capture-once")
            {
                Capture(Path.GetFullPath(args[1]));
                return 0;
            }
            if (args.Length == 2 && args[0] == "--capture-region")
                return RegionCapture.Run(Path.GetFullPath(args[1]), false);
            if (args.Length == 2 && args[0] == "--self-test-region")
                return RegionCapture.SelfTest(Path.GetFullPath(args[1]));
            if (args.Length == 2 && args[0] == "--self-test")
            {
                SelfTest(Path.GetFullPath(args[1]));
                return 0;
            }
            if (args.Length == 3 && args[0] == "--mouse-watch")
            {
                WatchMouseSideButton(args[1], args[2]);
                return 0;
            }
            if (args.Length == 2 && args[0] == "--self-test-mouse")
            {
                MouseShortcutHost.SelfTest(Path.GetFullPath(args[1]));
                return 0;
            }
            bool first;
            using (var mutex = new Mutex(true, "Local\\QuietCapture.FullScreen.Hotkey", out first))
            {
                if (!first) return 0;
                Application.EnableVisualStyles();
                using (var app = new TrayApp()) Application.Run(app);
            }
            return 0;
        }
        catch (Exception error)
        {
            Log(error);
            return 1;
        }
    }

    internal static void Capture(string output)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(output));
        using (var bitmap = CaptureDesktop())
        using (var file = new FileStream(output, FileMode.CreateNew, FileAccess.Write))
            bitmap.Save(file, ImageFormat.Png);
    }

    internal static Bitmap CaptureDesktop()
    {
        Rectangle area = SystemInformation.VirtualScreen;
        var bitmap = new Bitmap(area.Width, area.Height, PixelFormat.Format24bppRgb);
        try
        {
            using (var graphics = Graphics.FromImage(bitmap))
                graphics.CopyFromScreen(area.Left, area.Top, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
            return bitmap;
        }
        catch { bitmap.Dispose(); throw; }
    }

    internal static void Log(Exception error)
    {
        try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "error.log"), DateTime.Now.ToString("s") + " " + error + Environment.NewLine); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    static void WatchMouseSideButton(string pipeName, string button)
    {
        using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out))
        {
            pipe.Connect(15000);
            int parent;
            int.TryParse(pipeName.Substring(pipeName.LastIndexOf('-') + 1), out parent);
            using (var host = new MouseShortcutHost(pipe, button, parent)) Application.Run(host);
        }
    }

    static void SelfTest(string output)
    {
        bool captured = false;
        IntPtr foreground = GetForegroundWindow();
        using (var hotkey = new HotkeyWindow(delegate { Capture(output); captured = true; }))
        {
            if (IsWindowVisible(hotkey.Handle)) throw new Exception("Hotkey window must be invisible.");
            if (!PostMessage(hotkey.Handle, 0x0312, new IntPtr(1), IntPtr.Zero)) throw new Win32Exception();
            var timer = Stopwatch.StartNew();
            while (!captured && timer.ElapsedMilliseconds < 3000) { Application.DoEvents(); Thread.Sleep(10); }
            if (!captured) throw new Exception("Hotkey message did not produce a screenshot.");
        }
        using (var image = Image.FromFile(output))
        {
            var expected = SystemInformation.VirtualScreen;
            if (image.Width != expected.Width || image.Height != expected.Height) throw new Exception("Screenshot dimensions differ from the desktop.");
            File.WriteAllText(output + ".json", "{\"hotkeyMessageCapture\":true,\"invisibleWindow\":true,\"width\":" + image.Width + ",\"height\":" + image.Height + ",\"foregroundUnchanged\":" + (foreground == GetForegroundWindow()).ToString().ToLowerInvariant() + "}");
        }
    }
}

sealed class HotkeyWindow : NativeWindow, IDisposable
{
    readonly Action capture;
    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr window, int id);

    internal HotkeyWindow(Action capture)
    {
        this.capture = capture;
        CreateHandle(new CreateParams { Caption = "QuietCapture.Hotkey", Parent = new IntPtr(-3) });
        // Ctrl + Alt + F9; MOD_NOREPEAT suppresses held-key repeats.
        if (!RegisterHotKey(Handle, 1, 0x4003, (uint)Keys.F9))
        {
            int error = Marshal.GetLastWin32Error();
            DestroyHandle();
            throw new Win32Exception(error, "Ctrl+Alt+F9 is unavailable. Close the other application using this shortcut.");
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0312 && message.WParam.ToInt32() == 1) capture();
        base.WndProc(ref message);
    }

    public void Dispose() { if (Handle != IntPtr.Zero) { UnregisterHotKey(Handle, 1); DestroyHandle(); } }
}

sealed class TrayApp : ApplicationContext
{
    readonly NotifyIcon tray;
    readonly HotkeyWindow hotkey;

    internal TrayApp()
    {
        Directory.CreateDirectory(Program.Folder);
        hotkey = new HotkeyWindow(Capture);
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开截图文件夹", null, delegate { try { Process.Start(new ProcessStartInfo(Program.Folder) { UseShellExecute = true }); } catch (Exception error) { Program.Log(error); } });
        menu.Items.Add("退出", null, delegate { ExitThread(); });
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "静默截图 | Ctrl+Alt+F9", ContextMenuStrip = menu, Visible = true };
    }

    void Capture()
    {
        try
        {
            Program.Capture(Path.Combine(Program.Folder, DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss_fff") + ".png"));
            tray.Text = "静默截图 | 已保存 " + DateTime.Now.ToString("HH:mm:ss");
        }
        catch (Exception error) { Program.Log(error); tray.Text = "截图失败，请查看 error.log"; }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { hotkey.Dispose(); tray.Visible = false; tray.ContextMenuStrip.Dispose(); tray.Dispose(); }
        base.Dispose(disposing);
    }
}
