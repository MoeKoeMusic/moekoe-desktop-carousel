using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("DesktopCoverCarousel")]
[assembly: AssemblyProduct("DesktopCoverCarousel")]
[assembly: AssemblyCompany("MoeKoe Music")]
[assembly: AssemblyDescription("MoeKoe desktop cover carousel native host.")]

namespace DesktopCoverCarousel
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Application.Run(new WallpaperForm());
        }
    }

    internal enum ImageFitMode
    {
        Cover,
        Contain
    }

    internal sealed class CarouselOptions
    {
        public readonly List<string> Images = new List<string>();
        public int IntervalSeconds = 7;
        public int FadeMilliseconds = 1200;
        public ImageFitMode FitMode = ImageFitMode.Cover;
        public bool Shuffle;
    }

    internal sealed class WallpaperForm : Form
    {
        private const int FadeFrameInterval = 16;
        private const int WM_NCHITTEST = 0x0084;
        private const int HTTRANSPARENT = -1;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_NOACTIVATE = 0x08000000;

        private readonly List<string> sources = new List<string>();
        private readonly System.Windows.Forms.Timer slideTimer;
        private readonly System.Windows.Forms.Timer fadeTimer;
        private readonly Stopwatch fadeWatch = new Stopwatch();

        private int fadeMilliseconds = 1200;
        private ImageFitMode fitMode = ImageFitMode.Cover;
        private Bitmap currentFrame;
        private Bitmap fadingFrame;
        private Bitmap preloadedFrame;
        private int preloadedIndex = -1;
        private float fadeProgress = 1f;
        private int index = -1;
        private int requestId;
        private int preloadRequestId;
        private bool desktopAttached;

        public WallpaperForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            DoubleBuffered = true;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer,
                true);
            UpdateStyles();

            slideTimer = new System.Windows.Forms.Timer();
            slideTimer.Interval = 7000;
            slideTimer.Tick += delegate { ShowNext(); };

            fadeTimer = new System.Windows.Forms.Timer();
            fadeTimer.Interval = FadeFrameInterval;
            fadeTimer.Tick += delegate { UpdateFade(); };

            FormClosing += OnFormClosing;
            FormClosed += OnFormClosed;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);

            Rectangle screen = SystemInformation.VirtualScreen;
            SetBounds(0, 0, screen.Width, screen.Height);
            NativeCommandReader.Start(this);
            Hide();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);

            if (currentFrame == null && fadingFrame == null)
            {
                return;
            }

            e.Graphics.Clear(Color.Black);
            e.Graphics.CompositingQuality = CompositingQuality.HighSpeed;
            e.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.HighSpeed;
            e.Graphics.SmoothingMode = SmoothingMode.None;

            if (currentFrame != null)
            {
                DrawFrame(e.Graphics, currentFrame, 1f);
            }

            if (fadingFrame != null)
            {
                DrawFrame(e.Graphics, fadingFrame, fadeProgress);
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST)
            {
                m.Result = new IntPtr(HTTRANSPARENT);
                return;
            }

            base.WndProc(ref m);
        }

        public void ApplyCommand(NativeCommand command)
        {
            if (IsDisposed)
            {
                return;
            }

            if (InvokeRequired)
            {
                BeginInvoke((MethodInvoker)delegate { ApplyCommand(command); });
                return;
            }

            if (command.Type == "shutdown")
            {
                Close();
                return;
            }

            if (command.Action == "set-images")
            {
                ApplyOptions(command.Options);
                return;
            }

            if (command.Action == "next")
            {
                ShowNext();
                return;
            }

            if (command.Action == "previous")
            {
                ShowPrevious();
                return;
            }

            if (command.Action == "clear")
            {
                ClearFrames();
            }
        }

        private void ApplyOptions(CarouselOptions options)
        {
            slideTimer.Stop();
            fadeTimer.Stop();
            Interlocked.Increment(ref requestId);
            Interlocked.Increment(ref preloadRequestId);

            sources.Clear();
            sources.AddRange(options.Images);
            if (options.Shuffle)
            {
                ShuffleItems(sources);
            }

            slideTimer.Interval = Math.Max(1, options.IntervalSeconds) * 1000;
            fadeMilliseconds = Math.Max(0, options.FadeMilliseconds);
            fitMode = options.FitMode;
            index = -1;

            DisposeImage(fadingFrame);
            DisposeImage(preloadedFrame);
            fadingFrame = null;
            preloadedFrame = null;
            preloadedIndex = -1;
            fadeProgress = 1f;

            if (sources.Count == 0)
            {
                ClearFrames();
                return;
            }

            ShowNext();
            if (sources.Count > 1)
            {
                slideTimer.Start();
            }
        }

        private void ClearFrames()
        {
            slideTimer.Stop();
            fadeTimer.Stop();
            fadeWatch.Reset();
            Interlocked.Increment(ref requestId);
            Interlocked.Increment(ref preloadRequestId);

            sources.Clear();
            index = -1;
            preloadedIndex = -1;
            fadeProgress = 1f;

            DisposeImage(currentFrame);
            DisposeImage(fadingFrame);
            DisposeImage(preloadedFrame);
            currentFrame = null;
            fadingFrame = null;
            preloadedFrame = null;

            Hide();
            Invalidate();
        }

        private void ShowNext()
        {
            ShowAt(index + 1);
        }

        private void ShowPrevious()
        {
            ShowAt(index - 1);
        }

        private void ShowAt(int nextIndex)
        {
            if (sources.Count == 0)
            {
                return;
            }

            index = NormalizeIndex(nextIndex);
            int currentRequest = Interlocked.Increment(ref requestId);
            Interlocked.Increment(ref preloadRequestId);

            Bitmap readyFrame = TakePreloadedFrame(index);
            if (readyFrame != null)
            {
                BeginFade(readyFrame);
                StartPreload(NormalizeIndex(index + 1));
                return;
            }

            string source = sources[index];
            Size frameSize = ClientSize;
            ImageFitMode currentFitMode = fitMode;

            ThreadPool.QueueUserWorkItem(delegate
            {
                Bitmap frame = null;

                try
                {
                    frame = LoadFrame(source, frameSize, currentFitMode);
                }
                catch
                {
                    frame = null;
                }

                if (IsDisposed || !IsHandleCreated)
                {
                    DisposeImage(frame);
                    return;
                }

                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (currentRequest != requestId)
                        {
                            DisposeImage(frame);
                            return;
                        }

                        if (frame == null)
                        {
                            return;
                        }

                        BeginFade(frame);
                        StartPreload(NormalizeIndex(index + 1));
                    });
                }
                catch (ObjectDisposedException)
                {
                    DisposeImage(frame);
                }
                catch (InvalidOperationException)
                {
                    DisposeImage(frame);
                }
            });
        }

        private Bitmap TakePreloadedFrame(int targetIndex)
        {
            if (preloadedFrame != null && preloadedIndex == targetIndex)
            {
                Bitmap frame = preloadedFrame;
                preloadedFrame = null;
                preloadedIndex = -1;
                return frame;
            }

            DisposeImage(preloadedFrame);
            preloadedFrame = null;
            preloadedIndex = -1;
            return null;
        }

        private void StartPreload(int targetIndex)
        {
            if (sources.Count < 2 || targetIndex == index)
            {
                return;
            }

            if (preloadedFrame != null && preloadedIndex == targetIndex)
            {
                return;
            }

            DisposeImage(preloadedFrame);
            preloadedFrame = null;
            preloadedIndex = -1;

            string source = sources[targetIndex];
            Size frameSize = ClientSize;
            ImageFitMode currentFitMode = fitMode;
            int preloadId = Interlocked.Increment(ref preloadRequestId);

            ThreadPool.QueueUserWorkItem(delegate
            {
                Bitmap frame = null;

                try
                {
                    frame = LoadFrame(source, frameSize, currentFitMode);
                }
                catch
                {
                    frame = null;
                }

                if (IsDisposed || !IsHandleCreated)
                {
                    DisposeImage(frame);
                    return;
                }

                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (preloadId != preloadRequestId || targetIndex == index)
                        {
                            DisposeImage(frame);
                            return;
                        }

                        DisposeImage(preloadedFrame);
                        preloadedFrame = frame;
                        preloadedIndex = targetIndex;
                    });
                }
                catch (ObjectDisposedException)
                {
                    DisposeImage(frame);
                }
                catch (InvalidOperationException)
                {
                    DisposeImage(frame);
                }
            });
        }

        private void BeginFade(Bitmap frame)
        {
            if (fadeMilliseconds == 0 || currentFrame == null)
            {
                DisposeImage(currentFrame);
                DisposeImage(fadingFrame);
                currentFrame = frame;
                fadingFrame = null;
                fadeProgress = 1f;
                fadeTimer.Stop();
                if (!Visible)
                {
                    EnsureDesktopAttached();
                    Show();
                }
                Invalidate();
                return;
            }

            if (fadingFrame != null)
            {
                DisposeImage(currentFrame);
                currentFrame = fadingFrame;
            }

            fadingFrame = frame;
            fadeProgress = 0f;
            fadeWatch.Restart();
            fadeTimer.Start();
            if (!Visible)
            {
                EnsureDesktopAttached();
                Show();
            }
            Invalidate();
        }

        private void EnsureDesktopAttached()
        {
            if (desktopAttached)
            {
                return;
            }

            DesktopHost.Attach(Handle);
            Rectangle screen = SystemInformation.VirtualScreen;
            SetBounds(0, 0, screen.Width, screen.Height);
            desktopAttached = true;
        }

        private void UpdateFade()
        {
            double rawProgress = Math.Min(1d, fadeWatch.Elapsed.TotalMilliseconds / fadeMilliseconds);
            fadeProgress = EaseInOut((float)rawProgress);

            if (rawProgress >= 1d)
            {
                Bitmap old = currentFrame;
                currentFrame = fadingFrame;
                fadingFrame = null;
                fadeProgress = 1f;
                fadeTimer.Stop();
                fadeWatch.Reset();
                DisposeImage(old);
            }

            Invalidate();
        }

        private int NormalizeIndex(int value)
        {
            int count = sources.Count;
            return ((value % count) + count) % count;
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            slideTimer.Stop();
            fadeTimer.Stop();
            DisposeImage(currentFrame);
            DisposeImage(fadingFrame);
            DisposeImage(preloadedFrame);
        }

        private void OnFormClosed(object sender, FormClosedEventArgs e)
        {
            if (desktopAttached)
            {
                DesktopHost.Restore();
            }
        }

        private static Bitmap LoadFrame(string source, Size frameSize, ImageFitMode mode)
        {
            if (frameSize.Width <= 0 || frameSize.Height <= 0)
            {
                return null;
            }

            Image image = null;
            try
            {
                image = ImageLoader.Load(source);
                return RenderFrame(image, frameSize, mode);
            }
            finally
            {
                DisposeImage(image);
            }
        }

        private static void DrawFrame(Graphics graphics, Bitmap frame, float opacity)
        {
            if (opacity >= 0.999f)
            {
                graphics.DrawImageUnscaled(frame, 0, 0);
                return;
            }

            ColorMatrix matrix = new ColorMatrix();
            matrix.Matrix33 = Math.Max(0f, Math.Min(1f, opacity));

            using (ImageAttributes attributes = new ImageAttributes())
            {
                attributes.SetColorMatrix(matrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                graphics.DrawImage(
                    frame,
                    new Rectangle(0, 0, frame.Width, frame.Height),
                    0,
                    0,
                    frame.Width,
                    frame.Height,
                    GraphicsUnit.Pixel,
                    attributes);
            }
        }

        private static Bitmap RenderFrame(Image image, Size size, ImageFitMode mode)
        {
            Bitmap frame = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppPArgb);

            using (Graphics graphics = Graphics.FromImage(frame))
            {
                graphics.Clear(Color.Black);
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.SmoothingMode = SmoothingMode.HighQuality;
                graphics.DrawImage(image, GetImageBounds(image, size, mode));
            }

            return frame;
        }

        private static Rectangle GetImageBounds(Image image, Size size, ImageFitMode mode)
        {
            double scaleX = size.Width / (double)image.Width;
            double scaleY = size.Height / (double)image.Height;
            double scale = mode == ImageFitMode.Cover
                ? Math.Max(scaleX, scaleY)
                : Math.Min(scaleX, scaleY);

            int width = Math.Max(1, (int)Math.Round(image.Width * scale));
            int height = Math.Max(1, (int)Math.Round(image.Height * scale));
            int x = (size.Width - width) / 2;
            int y = (size.Height - height) / 2;
            return new Rectangle(x, y, width, height);
        }

        private static float EaseInOut(float value)
        {
            value = Math.Max(0f, Math.Min(1f, value));
            return value * value * (3f - 2f * value);
        }

        private static void DisposeImage(Image image)
        {
            if (image != null)
            {
                image.Dispose();
            }
        }

        private static void ShuffleItems(List<string> items)
        {
            Random random = new Random();
            for (int i = items.Count - 1; i > 0; i--)
            {
                int j = random.Next(i + 1);
                string temp = items[i];
                items[i] = items[j];
                items[j] = temp;
            }
        }
    }

    internal sealed class NativeCommand
    {
        public string Type = "";
        public string Action = "";
        public CarouselOptions Options = new CarouselOptions();
    }

    internal static class NativeCommandReader
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        public static void Start(WallpaperForm form)
        {
            Thread thread = new Thread(new ThreadStart(delegate { ReadLoop(form); }));
            thread.IsBackground = true;
            thread.Start();
        }

        private static void ReadLoop(WallpaperForm form)
        {
            using (Stream input = Console.OpenStandardInput())
            using (StreamReader reader = new StreamReader(input, Encoding.UTF8))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    NativeCommand command = Parse(line);
                    if (command != null)
                    {
                        form.ApplyCommand(command);
                    }
                }
            }
        }

        private static NativeCommand Parse(string line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                return null;
            }

            Dictionary<string, object> message = Serializer.DeserializeObject(line) as Dictionary<string, object>;
            if (message == null)
            {
                return null;
            }

            string type = ReadString(message, "type");
            if (type == "shutdown")
            {
                return new NativeCommand { Type = type };
            }

            Dictionary<string, object> payload = ReadMap(message, "payload");
            if (type != "message" || payload == null)
            {
                return null;
            }

            string action = ReadString(payload, "action");
            NativeCommand command = new NativeCommand();
            command.Type = type;
            command.Action = action;

            if (action == "set-images")
            {
                command.Options = ReadOptions(payload);
            }

            return command;
        }

        private static CarouselOptions ReadOptions(Dictionary<string, object> payload)
        {
            CarouselOptions options = new CarouselOptions();
            object[] images = ReadArray(payload, "images");
            for (int i = 0; i < images.Length; i++)
            {
                string source = images[i] as string;
                if (!string.IsNullOrWhiteSpace(source))
                {
                    options.Images.Add(source);
                }
            }

            options.IntervalSeconds = ReadInt(payload, "intervalSeconds", options.IntervalSeconds);
            options.FadeMilliseconds = ReadInt(payload, "fadeMilliseconds", options.FadeMilliseconds);
            options.Shuffle = ReadBool(payload, "shuffle");
            options.FitMode = ReadString(payload, "fit") == "contain"
                ? ImageFitMode.Contain
                : ImageFitMode.Cover;

            return options;
        }

        private static Dictionary<string, object> ReadMap(Dictionary<string, object> source, string key)
        {
            object value;
            return source.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }

        private static object[] ReadArray(Dictionary<string, object> source, string key)
        {
            object value;
            return source.TryGetValue(key, out value) && value is object[]
                ? (object[])value
                : new object[0];
        }

        private static string ReadString(Dictionary<string, object> source, string key)
        {
            object value;
            return source.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }

        private static int ReadInt(Dictionary<string, object> source, string key, int fallback)
        {
            object value;
            int result;
            return source.TryGetValue(key, out value) && int.TryParse(Convert.ToString(value), out result)
                ? result
                : fallback;
        }

        private static bool ReadBool(Dictionary<string, object> source, string key)
        {
            object value;
            return source.TryGetValue(key, out value) && value is bool && (bool)value;
        }
    }

    internal static class DesktopHost
    {
        private const int WM_CLOSE = 0x0010;
        private const int WM_SPAWN_WORKER = 0x052C;
        private const int SMTO_NORMAL = 0x0000;
        private const int GWL_STYLE = -16;
        private const int WS_VISIBLE = 0x10000000;
        private const int WS_CHILD = 0x40000000;
        private const int WS_POPUP = unchecked((int)0x80000000);
        private const int SWP_NOACTIVATE = 0x0010;
        private const int SWP_FRAMECHANGED = 0x0020;
        private const int SWP_SHOWWINDOW = 0x0040;
        private const int SW_SHOW = 5;
        private const int SW_HIDE = 0;
        private const int RDW_INVALIDATE = 0x0001;
        private const int RDW_ERASE = 0x0004;
        private const int RDW_ALLCHILDREN = 0x0080;
        private const int RDW_UPDATENOW = 0x0100;
        private static readonly IntPtr HwndBottom = new IntPtr(1);

        private static IntPtr attachedHost;
        private static bool attachedHostIsWorkerW;

        public static void Attach(IntPtr handle)
        {
            bool isWorkerW;
            IntPtr host = FindHostWindow(out isWorkerW);
            if (host == IntPtr.Zero)
            {
                return;
            }

            attachedHost = host;
            attachedHostIsWorkerW = isWorkerW;

            if (isWorkerW)
            {
                ShowWindow(host, SW_SHOW);
            }

            SetParent(handle, host);

            int style = GetWindowLong(handle, GWL_STYLE);
            style &= ~WS_POPUP;
            style |= WS_CHILD | WS_VISIBLE;
            SetWindowLong(handle, GWL_STYLE, style);

            Rectangle screen = SystemInformation.VirtualScreen;
            SetWindowPos(
                handle,
                HwndBottom,
                0,
                0,
                screen.Width,
                screen.Height,
                SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        }

        public static void Restore()
        {
            IntPtr host = attachedHost;
            bool canCloseHost = attachedHostIsWorkerW &&
                                host != IntPtr.Zero &&
                                IsWindow(host) &&
                                FindWindowEx(host, IntPtr.Zero, "SHELLDLL_DefView", null) == IntPtr.Zero;

            attachedHost = IntPtr.Zero;
            attachedHostIsWorkerW = false;

            if (canCloseHost)
            {
                IntPtr result;
                SendMessageTimeout(
                    host,
                    WM_CLOSE,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    SMTO_NORMAL,
                    1000,
                    out result);

                if (IsWindow(host))
                {
                    ShowWindow(host, SW_HIDE);
                }
            }

            RedrawWindow(
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);
        }

        private static IntPtr FindHostWindow(out bool isWorkerW)
        {
            isWorkerW = false;
            IntPtr progman = FindWindow("Progman", null);
            if (progman == IntPtr.Zero)
            {
                return IntPtr.Zero;
            }

            IntPtr result;
            SendMessageTimeout(
                progman,
                WM_SPAWN_WORKER,
                IntPtr.Zero,
                IntPtr.Zero,
                SMTO_NORMAL,
                1000,
                out result);

            IntPtr worker = IntPtr.Zero;
            EnumWindows(delegate(IntPtr topHandle, IntPtr topParam)
            {
                IntPtr shellView = FindWindowEx(topHandle, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (shellView == IntPtr.Zero)
                {
                    return true;
                }

                worker = FindWindowEx(IntPtr.Zero, topHandle, "WorkerW", null);
                return worker == IntPtr.Zero;
            }, IntPtr.Zero);

            if (worker != IntPtr.Zero)
            {
                isWorkerW = true;
                return worker;
            }

            return progman;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int command);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hWnd, int index);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int SetWindowLong(IntPtr hWnd, int index, int newLong);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr hWndInsertAfter,
            int x,
            int y,
            int cx,
            int cy,
            int flags);

        [DllImport("user32.dll")]
        private static extern bool RedrawWindow(
            IntPtr hWnd,
            IntPtr updateRect,
            IntPtr updateRegion,
            int flags);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr hWnd,
            int msg,
            IntPtr wParam,
            IntPtr lParam,
            int flags,
            int timeout,
            out IntPtr result);
    }

    internal static class ImageLoader
    {
        public static Image Load(string source)
        {
            byte[] bytes;

            if (IsRemote(source))
            {
                using (WebClient client = new WebClient())
                {
                    client.Headers[HttpRequestHeader.UserAgent] = "MoeKoeDesktopCoverCarousel/1.0";
                    bytes = client.DownloadData(source);
                }
            }
            else
            {
                bytes = File.ReadAllBytes(Environment.ExpandEnvironmentVariables(source));
            }

            using (MemoryStream stream = new MemoryStream(bytes))
            using (Image image = Image.FromStream(stream))
            {
                return new Bitmap(image);
            }
        }

        private static bool IsRemote(string source)
        {
            Uri uri;
            return Uri.TryCreate(source, UriKind.Absolute, out uri) &&
                   (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);
        }
    }
}
