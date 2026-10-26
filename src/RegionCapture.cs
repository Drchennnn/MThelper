using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// No desktop-sized overlay. A hidden message window receives queued hook events;
// the only visible surfaces are four thin edges and a small nonactivating hint.
static class RegionCapture
{
    internal static int Run(string output, bool test)
    {
        bool first;
        using (var mutex = new Mutex(true, "Local\\QuietCapture.Region.Selector", out first))
        {
            if (!first) return 2;
            using (var selector = new RegionSelector(output, test ? "drag" : null))
            {
                Application.Run(selector);
                return selector.Captured ? 0 : 2;
            }
        }
    }

    internal static int SelfTest(string output)
    {
        bool unchanged, thinOnly, excluded, released, pixelsEqual;
        int width, height;
        using (var selector = new RegionSelector(output, "drag"))
        {
            Application.Run(selector);
            if (!selector.Captured) throw new Exception("Region selection did not capture.");
            unchanged = selector.ForegroundUnchanged;
            thinOnly = selector.ThinWindowsOnly;
            excluded = selector.AllExcluded;
            released = selector.HooksReleased;
            width = selector.Selection.Width;
            height = selector.Selection.Height;
            using (var actual = new Bitmap(output))
            {
                if (actual.Width != width || actual.Height != height) throw new Exception("Incorrect crop dimensions.");
                pixelsEqual = selector.PixelsMatchSnapshot;
            }
        }
        string cancelledOutput = output + ".cancel.png";
        if (File.Exists(cancelledOutput)) throw new Exception("Self-test cancellation path already exists.");
        using (var selector = new RegionSelector(cancelledOutput, "cancel"))
        {
            Application.Run(selector);
            if (selector.Captured || File.Exists(cancelledOutput) || !selector.HooksReleased) throw new Exception("Cancellation did not release resources.");
            unchanged &= selector.ForegroundUnchanged;
        }
        Rectangle clipped = RegionSelector.Normalize(new Point(-100, -100), new Point(20, 30), new Rectangle(-60, -40, 200, 100));
        if (clipped != new Rectangle(-60, -40, 80, 70)) throw new Exception("Negative coordinate clipping failed.");
        if (!unchanged || !thinOnly || !released || !pixelsEqual) throw new Exception("Region capture invariants failed.");
        File.WriteAllText(output + ".json", "{\"regionCapture\":true,\"width\":" + width + ",\"height\":" + height + ",\"foregroundUnchanged\":true,\"noFullscreenOverlay\":true,\"hooksReleased\":true,\"pixelsMatchInitialFrame\":true,\"escapeCancelsWithoutFile\":true,\"negativeCoordinatesClipped\":true,\"overlayExcludedFromCapture\":" + excluded.ToString().ToLowerInvariant() + "}");
        return 0;
    }
}

sealed class SelectionEdge : Form
{
    readonly string hint;
    internal bool Excluded;
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    internal SelectionEdge(string text)
    {
        hint = text;
        Text = text == null ? "QuietCapture.SelectionEdge" : "QuietCapture.SelectionHint";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = text == null ? Color.FromArgb(53, 167, 255) : Color.FromArgb(28, 32, 40);
        ForeColor = Color.White;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get
        {
            var p = base.CreateParams;
            p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020; // NOACTIVATE, TOOLWINDOW, TRANSPARENT
            return p;
        }
    }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Excluded = SetWindowDisplayAffinity(Handle, 0x11);
        int disabled = 1;
        DwmSetWindowAttribute(Handle, 3, ref disabled, 4);
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x21) { m.Result = new IntPtr(3); return; } // MA_NOACTIVATE
        if (m.Msg == 0x84) { m.Result = new IntPtr(-1); return; } // HTTRANSPARENT
        base.WndProc(ref m);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        if (hint != null)
            TextRenderer.DrawText(e.Graphics, hint, SystemFonts.MessageBoxFont, ClientRectangle, ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
    internal void Place(Rectangle area)
    {
        if (area.Width <= 0 || area.Height <= 0) { Hide(); return; }
        Bounds = area;
        if (!Visible) Show();
        SetWindowPos(Handle, new IntPtr(-1), area.Left, area.Top, area.Width, area.Height, 0x0010 | 0x0040);
    }
}

sealed class RegionSelector : ApplicationContext
{
    internal readonly Bitmap Snapshot;
    internal readonly Rectangle Desktop;
    internal Rectangle Selection;
    internal bool Captured;
    internal bool PixelsMatchSnapshot;
    internal bool ForegroundUnchanged { get { return foreground == GetForegroundWindow(); } }
    internal bool ThinWindowsOnly = true;
    internal bool AllExcluded = true;
    internal bool HooksReleased { get { return mouseHook == IntPtr.Zero && keyboardHook == IntPtr.Zero; } }
    readonly string output;
    readonly string testMode;
    readonly IntPtr foreground;
    readonly SelectionEdge[] edges = new SelectionEdge[4];
    readonly SelectionEdge hint;
    readonly EventWindow events;
    readonly HookProc mouseProc;
    readonly HookProc keyboardProc;
    readonly System.Windows.Forms.Timer timeout;
    readonly System.Windows.Forms.Timer testTimer;
    IntPtr mouseHook, keyboardHook;
    Point start, end;
    bool dragging, finishing, updateQueued, cancelOnMouseUp;
    int testStage;
    const int UpdateMessage = 0x8001, FinishMessage = 0x8002, CancelMessage = 0x8003;
    delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct MouseData { internal Point point; internal uint mouseData, flags, time; internal UIntPtr extraInfo; }
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int type, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, int message, IntPtr a, IntPtr b);

    internal RegionSelector(string file, string test)
    {
        output = file;
        testMode = test;
        Desktop = SystemInformation.VirtualScreen;
        foreground = GetForegroundWindow();
        // Take the image before showing any selection UI. Only this initial frame is cropped.
        Snapshot = Program.CaptureDesktop();
        try
        {
            events = new EventWindow(OnQueuedEvent);
            for (int i = 0; i < edges.Length; i++) edges[i] = new SelectionEdge(null);
            hint = new SelectionEdge("拖动鼠标左键框选 · Esc / 右键取消");
            timeout = new System.Windows.Forms.Timer { Interval = 60000 };
            timeout.Tick += delegate { Complete(false); };
            mouseProc = MouseHook;
            keyboardProc = KeyboardHook;
            mouseHook = SetWindowsHookEx(14, mouseProc, GetModuleHandle(null), 0);
            if (mouseHook == IntPtr.Zero) throw new Win32Exception();
            keyboardHook = SetWindowsHookEx(13, keyboardProc, GetModuleHandle(null), 0);
            if (keyboardHook == IntPtr.Zero) throw new Win32Exception();
            var work = Screen.FromPoint(Cursor.Position).WorkingArea;
            hint.Place(new Rectangle(work.Left + Math.Max(0, (work.Width - 340) / 2), work.Top + 12, Math.Min(340, work.Width), 28));
            AllExcluded &= hint.Excluded;
            timeout.Start();
            if (testMode != null)
            {
                testTimer = new System.Windows.Forms.Timer { Interval = 120 };
                testTimer.Tick += TestTick;
                testTimer.Start();
            }
        }
        catch { Dispose(); throw; }
    }

    internal static Rectangle Normalize(Point a, Point b, Rectangle desktop)
    {
        return Rectangle.Intersect(desktop, Rectangle.FromLTRB(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Max(a.X, b.X), Math.Max(a.Y, b.Y)));
    }
    IntPtr MouseHook(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && HandleMouse(message.ToInt32(), ((MouseData)Marshal.PtrToStructure(data, typeof(MouseData))).point)) return new IntPtr(1);
        return CallNextHookEx(mouseHook, code, message, data);
    }
    bool HandleMouse(int message, Point point)
    {
        // The dedicated side-button hook must see the matching release, even
        // while a region selection is active, so it can swallow browser navigation.
        if (message == 0x20B || message == 0x20C || message == 0x20D) return false;
        if (message == 0x200)
        {
            if (dragging && !finishing)
            {
                end = point;
                if (!updateQueued) { updateQueued = true; Queue(UpdateMessage); }
            }
            return false;
        }
        if (finishing) return true;
        if (message == 0x201) { start = end = point; dragging = true; Queue(UpdateMessage); }
        else if (message == 0x202 && dragging) { end = point; finishing = true; Queue(FinishMessage); }
        else if (message == 0x204 || message == 0x207) cancelOnMouseUp = true;
        else if ((message == 0x205 || message == 0x208) && cancelOnMouseUp) { finishing = true; Queue(CancelMessage); }
        return true; // Only button/wheel events are swallowed; pointer motion stays natural.
    }
    IntPtr KeyboardHook(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && Marshal.ReadInt32(data) == 27)
        {
            if (message.ToInt32() == 0x100 || message.ToInt32() == 0x104) { finishing = true; Queue(CancelMessage); }
            return new IntPtr(1);
        }
        return CallNextHookEx(keyboardHook, code, message, data);
    }
    void Queue(int message) { PostMessage(events.Handle, message, IntPtr.Zero, IntPtr.Zero); }
    void OnQueuedEvent(int message)
    {
        if (message == UpdateMessage) { updateQueued = false; DrawEdges(); }
        else if (message == FinishMessage) Complete(true);
        else if (message == CancelMessage) Complete(false);
    }
    void DrawEdges()
    {
        Rectangle r = Normalize(start, end, Desktop);
        if (r.Width < 4 || r.Height < 4) return;
        Rectangle[] bounds = {
            new Rectangle(r.Left, r.Top, r.Width, 2), new Rectangle(r.Left, r.Bottom - 2, r.Width, 2),
            new Rectangle(r.Left, r.Top + 2, 2, r.Height - 4), new Rectangle(r.Right - 2, r.Top + 2, 2, r.Height - 4)
        };
        for (int i = 0; i < edges.Length; i++)
        {
            edges[i].Place(bounds[i]);
            ThinWindowsOnly &= edges[i].Bounds.Width <= 2 || edges[i].Bounds.Height <= 2;
            AllExcluded &= edges[i].Excluded;
        }
    }
    void Complete(bool save)
    {
        finishing = true;
        timeout.Stop();
        if (testTimer != null) testTimer.Stop();
        ReleaseHooks();
        foreach (var edge in edges) edge.Hide();
        hint.Hide();
        Selection = Normalize(start, end, Desktop);
        if (save && Selection.Width >= 4 && Selection.Height >= 4)
        {
            Rectangle crop = new Rectangle(Selection.Left - Desktop.Left, Selection.Top - Desktop.Top, Selection.Width, Selection.Height);
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            using (var bitmap = Snapshot.Clone(crop, PixelFormat.Format24bppRgb))
            using (var stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write)) bitmap.Save(stream, ImageFormat.Png);
            if (testMode != null)
            {
                PixelsMatchSnapshot = true;
                using (var actual = new Bitmap(output))
                    for (int y = 0; y < crop.Height; y += 11)
                        for (int x = 0; x < crop.Width; x += 13)
                            if (actual.GetPixel(x, y) != Snapshot.GetPixel(crop.Left + x, crop.Top + y)) PixelsMatchSnapshot = false;
            }
            Captured = true;
        }
        ExitThread();
    }
    void ReleaseHooks()
    {
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        if (keyboardHook != IntPtr.Zero) { UnhookWindowsHookEx(keyboardHook); keyboardHook = IntPtr.Zero; }
    }
    void TestTick(object sender, EventArgs args)
    {
        if (testMode == "cancel")
        {
            IntPtr data = Marshal.AllocHGlobal(4);
            try { Marshal.WriteInt32(data, 27); KeyboardHook(0, new IntPtr(0x100), data); }
            finally { Marshal.FreeHGlobal(data); }
            return;
        }
        Point a = new Point(Desktop.Left + 30, Desktop.Top + 80);
        Point b = new Point(a.X + 240, a.Y + 160);
        if (testStage == 0) HandleMouse(0x201, b); // reverse drag also exercises normalization
        else if (testStage == 1) HandleMouse(0x200, a);
        else if (testStage == 2)
        {
            if (!ForegroundUnchanged) throw new Exception("Selector stole focus.");
            foreach (var edge in edges) if (!edge.Visible) throw new Exception("Selection edges did not appear.");
            HandleMouse(0x202, a);
        }
        testStage++;
    }
    protected override void Dispose(bool disposing)
    {
        ReleaseHooks();
        if (disposing)
        {
            if (timeout != null) timeout.Dispose();
            if (testTimer != null) testTimer.Dispose();
            foreach (var edge in edges) if (edge != null) edge.Dispose();
            if (hint != null) hint.Dispose();
            if (events != null) events.Dispose();
            Snapshot.Dispose();
        }
        base.Dispose(disposing);
    }
    sealed class EventWindow : NativeWindow, IDisposable
    {
        readonly Action<int> onMessage;
        internal EventWindow(Action<int> handler)
        {
            onMessage = handler;
            CreateHandle(new CreateParams { Caption = "QuietCapture.RegionEvents", Parent = new IntPtr(-3) });
        }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg >= UpdateMessage && m.Msg <= CancelMessage) onMessage(m.Msg);
            base.WndProc(ref m);
        }
        public void Dispose() { if (Handle != IntPtr.Zero) DestroyHandle(); }
    }
}
