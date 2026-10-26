using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Bound side-button DOWN and UP are consumed before Chromium/browser navigation.
// Notify on release, so changing bindings or opening a selector cannot leak an UP.
sealed class MouseShortcutHost : ApplicationContext
{
    readonly Stream output;
    readonly bool mouse4, mouse5;
    bool held4, held5;
    readonly HookProc callback;
    readonly DispatchWindow events;
    readonly Timer watchdog;
    IntPtr hook;
    delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct MouseData { internal Point point; internal uint mouseData, flags, time; internal UIntPtr extraInfo; }
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int type, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, int message, IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

    internal MouseShortcutHost(Stream stream, string buttons, int parentId)
    {
        output = stream;
        foreach (string button in buttons.Split(','))
        {
            if (button == "Mouse4") mouse4 = true;
            else if (button == "Mouse5") mouse5 = true;
            else throw new ArgumentException("Unsupported mouse button.");
        }
        try
        {
            events = new DispatchWindow(delegate(int key) {
                try { output.WriteByte((byte)key); output.Flush(); }
                catch (IOException) { ExitThread(); }
            });
            callback = OnMouse;
            hook = SetWindowsHookEx(14, callback, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) throw new Win32Exception();
            watchdog = new Timer { Interval = 500 };
            watchdog.Tick += delegate {
                if (parentId <= 0) return;
                try { using (var parent = Process.GetProcessById(parentId)) { if (parent.HasExited) ExitThread(); } }
                catch (ArgumentException) { ExitThread(); }
            };
            watchdog.Start();
            output.WriteByte(0); output.Flush(); // readiness acknowledgement after hook installation
        }
        catch { Dispose(); throw; }
    }
    IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            var mouse = (MouseData)Marshal.PtrToStructure(data, typeof(MouseData));
            if (HandleButton(message.ToInt32(), (int)((mouse.mouseData >> 16) & 0xffff))) return new IntPtr(1);
        }
        return CallNextHookEx(hook, code, message, data);
    }
    bool HandleButton(int message, int button)
    {
        if (message != 0x20B && message != 0x20C && message != 0x20D) return false;
        if ((button == 1 && !mouse4) || (button == 2 && !mouse5) || (button != 1 && button != 2)) return false;
        if (message == 0x20B || message == 0x20D)
        {
            if (button == 1) held4 = true; else held5 = true;
        }
        else if (button == 1 ? held4 : held5)
        {
            if (button == 1) held4 = false; else held5 = false;
            PostMessage(events.Handle, 0x8008, new IntPtr(button == 1 ? 5 : 6), IntPtr.Zero);
        }
        return true;
    }
    protected override void Dispose(bool disposing)
    {
        if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
        if (disposing)
        {
            if (watchdog != null) watchdog.Dispose();
            if (events != null) events.Dispose();
        }
        base.Dispose(disposing);
    }
    internal static void SelfTest(string file)
    {
        IntPtr foreground = GetForegroundWindow();
        using (var stream = new MemoryStream())
        {
            var host = new MouseShortcutHost(stream, "Mouse4", 0);
            using (host)
            {
                if (!host.HandleButton(0x20B, 1)) throw new Exception("Bound DOWN must be consumed.");
                if (!host.HandleButton(0x20B, 1)) throw new Exception("Repeated DOWN must be consumed.");
                if (!host.HandleButton(0x20C, 1)) throw new Exception("Bound UP must be consumed.");
                if (!host.HandleButton(0x20C, 1)) throw new Exception("Duplicate UP must be consumed.");
                if (host.HandleButton(0x20B, 2) || host.HandleButton(0x20C, 2) || host.HandleButton(0x201, 0)) throw new Exception("Unbound buttons must pass through.");
                Application.DoEvents();
                byte[] bytes = stream.ToArray();
                if (bytes.Length != 2 || bytes[0] != 0 || bytes[1] != 5) throw new Exception("Expected readiness and one release notification.");
            }
            if (host.hook != IntPtr.Zero) throw new Exception("Mouse hook was not released.");
        }
        using (var stream = new MemoryStream())
        using (var host = new MouseShortcutHost(stream, "Mouse4,Mouse5", 0))
        {
            host.HandleButton(0x20B, 2); host.HandleButton(0x20C, 2); Application.DoEvents();
            if (stream.ToArray()[1] != 6) throw new Exception("Mouse5 mapping failed.");
        }
        if (foreground != GetForegroundWindow()) throw new Exception("Mouse watcher must not change focus.");
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllText(file, "{\"hookInstalled\":true,\"boundDownUpConsumed\":true,\"unboundButtonsPassThrough\":true,\"oneEventPerRelease\":true,\"bothSideButtonsSupported\":true,\"hookReleased\":true,\"foregroundUnchanged\":true}");
    }
    sealed class DispatchWindow : NativeWindow, IDisposable
    {
        readonly Action<int> onButton;
        internal DispatchWindow(Action<int> action) { onButton = action; CreateHandle(new CreateParams { Caption = "QuietCapture.MouseHook", Parent = new IntPtr(-3) }); }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x8008) onButton(message.WParam.ToInt32());
            base.WndProc(ref message);
        }
        public void Dispose() { if (Handle != IntPtr.Zero) DestroyHandle(); }
    }
}
