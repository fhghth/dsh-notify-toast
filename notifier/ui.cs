using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DshNotify
{
    // ---------------------------------------------------------------- config
    public class Cfg
    {
        public int Width = 400;
        public int Height = 104;
        public double Scale = 1.0;
        public int Margin = 16;
        public int Gap = 8;
        public int MaxCards = 4;
        public int DurationMs = 8000;
        public string Position = "bottom-right";
        public string ApprovalPosition = "bottom-right";
        public string Screen = "primary";
        public string BgColor = "#FFFFFF";
        public string BorderColor = "#000000";
        public string TitleColor = "#111111";
        public string SubtitleColor = "#787878";
        public string AccentComplete = "#16A34A";
        public string AccentApproval = "#D97706";
        public string AccentError = "#DC2626";
        public string AccentQuestion = "#111111";
        public string IconStyle = "vector";
        public string IconComplete = "";
        public string IconApproval = "";
        public string IconError = "";
        public string IconQuestion = "";
        public string FontFamily = "Microsoft YaHei UI";
        /** Plugin directory: relative custom sound paths resolve against it. */
        public string BaseDir = "";
        public bool SoundEnabled = true;
        public string SoundComplete = "system:asterisk";
        public string SoundApproval = "system:exclamation";
        public string SoundError = "system:hand";
        public string SoundQuestion = "system:question";
        public string CustomSoundComplete = "";
        public string CustomSoundApproval = "";
        public string CustomSoundError = "";
        public string CustomSoundQuestion = "";
        public int AnimateMs = 160;
        public int SlidePx = 16;
        public int ExitRisePx = 8;
    }

    public class Card
    {
        public string Id = "";
        public string Kind = "complete";
        public string Title = "";
        public string Subtitle = "";
        public string SessionId = "";
        public int DurationMs = 8000;
        public string Sound = "";
    }

    // ---------------------------------------------------------------- win32
    public static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(int idAttach, int idAttachTo, bool attach);
        [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();

        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const int SW_RESTORE = 9;

        public static bool EnableDpiAware()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
            try { return SetProcessDPIAware(); } catch { }
            return false;
        }

        public static void Activate(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
            bool ok = SetForegroundWindow(hwnd);
            if (!ok)
            {
                int pid;
                int fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                int me = GetCurrentThreadId();
                if (fgThread != 0 && fgThread != me)
                {
                    AttachThreadInput(me, fgThread, true);
                    SetForegroundWindow(hwnd);
                    BringWindowToTop(hwnd);
                    AttachThreadInput(me, fgThread, false);
                }
            }
            BringWindowToTop(hwnd);
        }
    }

    // ---------------------------------------------------------------- json
    public static class Json
    {
        public static Dictionary<string, object> Obj(string text)
        {
            int i = 0;
            object v = Value(text, ref i);
            Dictionary<string, object> d = v as Dictionary<string, object>;
            if (d == null) throw new FormatException("expected json object");
            return d;
        }

        static void Ws(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end");
            char c = s[i];
            if (c == '{') return ObjInner(s, ref i);
            if (c == '[') return Arr(s, ref i);
            if (c == '"') return Str(s, ref i);
            if (c == 't') { i += 4; return true; }
            if (c == 'f') { i += 5; return false; }
            if (c == 'n') { i += 4; return null; }
            return Num(s, ref i);
        }

        static Dictionary<string, object> ObjInner(string s, ref int i)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            i++;
            Ws(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return d; }
            while (true)
            {
                Ws(s, ref i);
                string key = Str(s, ref i);
                Ws(s, ref i);
                if (s[i] != ':') throw new FormatException("expected ':'");
                i++;
                d[key] = Value(s, ref i);
                Ws(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == '}') { i++; break; }
                throw new FormatException("expected ',' or '}'");
            }
            return d;
        }

        static List<object> Arr(string s, ref int i)
        {
            List<object> list = new List<object>();
            i++;
            Ws(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return list; }
            while (true)
            {
                list.Add(Value(s, ref i));
                Ws(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == ']') { i++; break; }
                throw new FormatException("expected ',' or ']'");
            }
            return list;
        }

        static string Str(string s, ref int i)
        {
            if (s[i] != '"') throw new FormatException("expected string");
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c == '\\')
                {
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                            i += 4;
                            break;
                        default: throw new FormatException("bad escape");
                    }
                }
                else sb.Append(c);
            }
            throw new FormatException("unterminated string");
        }

        static double Num(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && "0123456789+-.eE".IndexOf(s[i]) >= 0) i++;
            return double.Parse(s.Substring(start, i - start), CultureInfo.InvariantCulture);
        }

        public static string S(Dictionary<string, object> d, string k, string def)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v is string ? (string)v : def;
        }

        public static int I(Dictionary<string, object> d, string k, int def)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v)) return def;
            if (v is double) return (int)Math.Round((double)v);
            return def;
        }

        public static bool B(Dictionary<string, object> d, string k, bool def)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v)) return def;
            if (v is bool) return (bool)v;
            return def;
        }

        public static double D(Dictionary<string, object> d, string k, double def)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v)) return def;
            if (v is double) return (double)v;
            return def;
        }
    }

    // ---------------------------------------------------------------- card window
    public class CardForm : Form
    {
        readonly NotifierApp app;
        readonly Cfg cfg;
        readonly Card card;
        readonly double k;
        readonly int W;
        readonly int H;

        readonly Font fontTitle;
        readonly Font fontSub;
        readonly Font fontX;
        readonly Font fontGlyph;

        bool hover;
        bool leaving;
        public string CloseReason = "timeout";
        int baseLeft;
        int baseTop;
        int animStart;
        int animFromY;
        int animToY;
        int animFromOpacity; // 0..100
        int animToOpacity;
        Timer animTimer;
        Timer dismissTimer;
        Image imageIcon;

        public string CardId { get { return card.Id; } }

        public string CardKind { get { return card.Kind; } }

        public CardForm(NotifierApp app, Cfg cfg, Card card, double dpiScale)
        {
            this.app = app;
            this.cfg = cfg;
            this.card = card;
            k = dpiScale * cfg.Scale;
            W = (int)Math.Round(cfg.Width * k);
            H = (int)Math.Round(cfg.Height * k);

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = ParseColor(cfg.BgColor, Color.White);
            DoubleBuffered = true;
            Width = W;
            Height = H;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);

            fontTitle = MakeFont(FontStyle.Bold, 15);
            fontSub = MakeFont(FontStyle.Regular, 13);
            fontX = MakeFont(FontStyle.Regular, 14);
            fontGlyph = new Font("Segoe UI Emoji", (float)S(20), FontStyle.Regular, GraphicsUnit.Pixel);

            if (cfg.IconStyle == "image")
            {
                string p = IconPath();
                if (!string.IsNullOrEmpty(p))
                {
                    try { imageIcon = Image.FromFile(p); } catch { imageIcon = null; }
                }
            }

            dismissTimer = new Timer();
            dismissTimer.Interval = Math.Max(1000, card.DurationMs > 0 ? card.DurationMs : cfg.DurationMs);
            dismissTimer.Tick += delegate { dismissTimer.Stop(); StartLeave(); };
            FormClosed += delegate { app.SendClosed(card.Id, CloseReason); app.RemoveCard(this); };
        }

        Font MakeFont(FontStyle style, double px)
        {
            string family = string.IsNullOrEmpty(cfg.FontFamily) ? "Microsoft YaHei UI" : cfg.FontFamily;
            try { return new Font(family, (float)(px * k), style, GraphicsUnit.Pixel); }
            catch { return new Font("Segoe UI", (float)(px * k), style, GraphicsUnit.Pixel); }
        }

        int S(double v)
        {
            return (int)Math.Round(v * k);
        }

        static Color ParseColor(string s, Color def)
        {
            if (string.IsNullOrEmpty(s)) return def;
            try { return ColorTranslator.FromHtml(s); }
            catch { return def; }
        }

        string IconPath()
        {
            if (card.Kind == "approval") return cfg.IconApproval;
            if (card.Kind == "error") return cfg.IconError;
            if (card.Kind == "question") return cfg.IconQuestion;
            return cfg.IconComplete;
        }

        string IconGlyph()
        {
            if (card.Kind == "approval") return string.IsNullOrEmpty(cfg.IconApproval) ? "\uD83D\uDD12" : cfg.IconApproval;
            if (card.Kind == "error") return string.IsNullOrEmpty(cfg.IconError) ? "!" : cfg.IconError;
            if (card.Kind == "question") return string.IsNullOrEmpty(cfg.IconQuestion) ? "?" : cfg.IconQuestion;
            return string.IsNullOrEmpty(cfg.IconComplete) ? "\u2713" : cfg.IconComplete;
        }

        Color Accent()
        {
            if (card.Kind == "approval") return ParseColor(cfg.AccentApproval, Color.FromArgb(217, 119, 6));
            if (card.Kind == "error") return ParseColor(cfg.AccentError, Color.FromArgb(220, 38, 38));
            if (card.Kind == "question") return ParseColor(cfg.AccentQuestion, Color.FromArgb(37, 99, 235));
            return ParseColor(cfg.AccentComplete, Color.FromArgb(22, 163, 74));
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
                return cp;
            }
        }

        public void SetBase(int left, int top)
        {
            baseLeft = left;
            baseTop = top;
            if (animTimer == null)
            {
                Location = new Point(left, top);
            }
        }

        public void ReassertTopmost()
        {
            if (IsDisposed) return;
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
        }

        public void ShowAt()
        {
            Location = new Point(baseLeft, baseTop + S(cfg.SlidePx));
            Opacity = 0;
            Show();
            StartAnim(baseTop + S(cfg.SlidePx), baseTop, 0, 100);
            if (cfg.SoundEnabled) app.PlaySound(card);
            dismissTimer.Start();
        }

        void StartAnim(int fromY, int toY, int fromOpacity, int toOpacity)
        {
            animFromY = fromY;
            animToY = toY;
            animFromOpacity = fromOpacity;
            animToOpacity = toOpacity;
            animStart = Environment.TickCount;
            if (animTimer == null)
            {
                animTimer = new Timer();
                animTimer.Interval = 15;
                animTimer.Tick += delegate { TickAnim(); };
            }
            animTimer.Start();
        }

        void TickAnim()
        {
            int elapsed = Environment.TickCount - animStart;
            double t = cfg.AnimateMs <= 0 ? 1.0 : Math.Min(1.0, (double)elapsed / cfg.AnimateMs);
            double e = 1 - Math.Pow(1 - t, 3); // ease-out cubic
            int y = (int)Math.Round(animFromY + (animToY - animFromY) * e);
            int o = (int)Math.Round(animFromOpacity + (animToOpacity - animFromOpacity) * e);
            try
            {
                Location = new Point(baseLeft, y);
                Opacity = Math.Max(0.0, Math.Min(1.0, o / 100.0));
            }
            catch { }
            if (t >= 1.0)
            {
                animTimer.Stop();
                if (leaving)
                {
                    try { Close(); } catch { }
                }
                else
                {
                    animTimer = null;
                }
            }
        }

        public void StartLeave()
        {
            if (leaving || IsDisposed) return;
            leaving = true;
            dismissTimer.Stop();
            StartAnim(Location.Y, Location.Y - S(cfg.ExitRisePx), 100, 0);
        }

        bool InCloseHit(int x, int y)
        {
            Rectangle r = CloseRect();
            return r.Contains(x, y);
        }

        Rectangle CloseRect()
        {
            int size = S(30);
            return new Rectangle(W - S(14) - size, S(10), size, size);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            hover = true;
            dismissTimer.Stop();
            Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hover = false;
            if (!leaving) dismissTimer.Start();
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            if (InCloseHit(e.X, e.Y))
            {
                CloseReason = "dismiss";
                StartLeave();
                return;
            }
            CloseReason = "click";
            app.RaiseAndClick(card);
            StartLeave();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            Color bg = ParseColor(cfg.BgColor, Color.White);
            using (SolidBrush b = new SolidBrush(bg)) g.FillRectangle(b, ClientRectangle);
            if (hover)
            {
                using (SolidBrush hb = new SolidBrush(Color.FromArgb(18, 0, 0, 0))) g.FillRectangle(hb, 1, 1, W - 2, H - 2);
            }
            using (Pen p = new Pen(ParseColor(cfg.BorderColor, Color.Black), 1f))
            {
                g.DrawRectangle(p, 0, 0, W - 1, H - 1);
            }

            // icon box
            int pad = S(18);
            int box = S(28);
            Rectangle iconRect = new Rectangle(pad, (H - box) / 2, box, box);
            DrawIcon(g, iconRect);

            // texts
            int textX = pad + box + S(14);
            int textW = W - textX - S(40);
            int blockH = S(22) + S(6) + S(20);
            int textTop = (H - blockH) / 2;
            Rectangle titleRect = new Rectangle(textX, textTop, textW, S(22));
            Rectangle subRect = new Rectangle(textX, textTop + S(22) + S(6), textW, S(20));

            Color titleColor = ParseColor(cfg.TitleColor, Color.FromArgb(17, 17, 17));
            Color subColor = ParseColor(cfg.SubtitleColor, Color.FromArgb(120, 120, 120));

            TextFormatFlags flags = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine
                | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix;
            TextRenderer.DrawText(g, card.Title, fontTitle, titleRect, titleColor, flags);
            TextRenderer.DrawText(g, card.Subtitle, fontSub, subRect, subColor, flags);

            // close glyph
            Color xColor = hover ? Color.FromArgb(40, 40, 40) : Color.FromArgb(160, 160, 160);
            TextFormatFlags xf = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix;
            TextRenderer.DrawText(g, "\u2715", fontX, CloseRect(), xColor, xf);
        }

        void DrawIcon(Graphics g, Rectangle r)
        {
            Color accent = Accent();
            if (cfg.IconStyle == "image" && imageIcon != null)
            {
                float scale = Math.Min((float)r.Width / imageIcon.Width, (float)r.Height / imageIcon.Height);
                int w = (int)(imageIcon.Width * scale);
                int h = (int)(imageIcon.Height * scale);
                g.DrawImage(imageIcon, new Rectangle(r.X + (r.Width - w) / 2, r.Y + (r.Height - h) / 2, w, h));
                return;
            }
            if (cfg.IconStyle == "glyph")
            {
                TextFormatFlags f = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix;
                TextRenderer.DrawText(g, IconGlyph(), fontGlyph, r, accent, f);
                return;
            }
            if (card.Kind == "approval") DrawLock(g, r, accent);
            else if (card.Kind == "question") DrawQuestion(g, r, accent);
            else DrawCheck(g, r, accent);
        }

        /** Filled disc with a white question mark: legible at any DPI. */
        /** A standalone question mark: no disc, just the glyph in the accent color.
         *  Bold in the card's own font matches the previous look; the box comes
         *  from the measured line height so the dot under the hook cannot be
         *  clipped. */
        void DrawQuestion(Graphics g, Rectangle r, Color c)
        {
            float size = r.Height * 1.35f;
            string family = string.IsNullOrEmpty(cfg.FontFamily) ? "Microsoft YaHei UI" : cfg.FontFamily;
            Font font;
            try { font = new Font(family, size, FontStyle.Bold, GraphicsUnit.Pixel); }
            catch { font = new Font("Segoe UI", size, FontStyle.Bold, GraphicsUnit.Pixel); }
            using (font)
            {
                TextFormatFlags flags = TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix
                    | TextFormatFlags.SingleLine | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter;
                Size measured = TextRenderer.MeasureText(g, "?", font, new Size(short.MaxValue, short.MaxValue), flags);

                int pad = Math.Max(2, (int)Math.Round(3 * k));
                int w = measured.Width + pad * 2;
                int h = measured.Height + pad * 2;
                // The glyph's ink sits above the line box centre; nudge down so the
                // visual centre matches the neighbouring check/lock icons.
                int nudge = (int)Math.Round(size * 0.10);
                Rectangle box = new Rectangle(
                    r.X + (r.Width - w) / 2,
                    r.Y + (r.Height - h) / 2 + nudge,
                    w,
                    h);
                TextRenderer.DrawText(g, "?", font, box, c, flags);
            }
        }

        void DrawCheck(Graphics g, Rectangle r, Color c)
        {
            float w = (float)Math.Max(2.0, 3.2 * k);
            using (Pen pen = new Pen(c, w))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                PointF[] pts = new PointF[]
                {
                    new PointF(r.X + r.Width * 0.14f, r.Y + r.Height * 0.54f),
                    new PointF(r.X + r.Width * 0.41f, r.Y + r.Height * 0.80f),
                    new PointF(r.X + r.Width * 0.88f, r.Y + r.Height * 0.20f),
                };
                g.DrawLines(pen, pts);
            }
        }

        void DrawLock(Graphics g, Rectangle r, Color c)
        {
            float w = (float)Math.Max(1.8, 2.3 * k);
            using (Pen pen = new Pen(c, w))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                float bw = r.Width * 0.64f;
                float bh = r.Height * 0.46f;
                float left = r.X + (r.Width - bw) / 2f;
                float top = r.Y + r.Height * 0.46f;
                using (GraphicsPath path = RoundedRect(new RectangleF(left, top, bw, bh), 3f * (float)k))
                {
                    g.DrawPath(pen, path);
                }
                float sw = r.Width * 0.40f;
                g.DrawArc(pen, r.X + (r.Width - sw) / 2f, r.Y + r.Height * 0.10f, sw, r.Height * 0.46f, 180f, 180f);
            }
            using (SolidBrush b = new SolidBrush(c))
            {
                float cx = r.X + r.Width / 2f;
                float cy = r.Y + r.Height * 0.69f;
                float rr = Math.Max(1.4f, r.Width * 0.055f);
                g.FillEllipse(b, cx - rr, cy - rr, rr * 2, rr * 2);
            }
        }

        static GraphicsPath RoundedRect(RectangleF r, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { if (dismissTimer != null) dismissTimer.Dispose(); } catch { }
                try { if (animTimer != null) animTimer.Dispose(); } catch { }
                try { if (fontTitle != null) fontTitle.Dispose(); } catch { }
                try { if (fontSub != null) fontSub.Dispose(); } catch { }
                try { if (fontX != null) fontX.Dispose(); } catch { }
                try { if (fontGlyph != null) fontGlyph.Dispose(); } catch { }
                try { if (imageIcon != null) imageIcon.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }
    }

    // ---------------------------------------------------------------- app
    public class NotifierApp : ApplicationContext
    {
        readonly Cfg cfg = new Cfg();
        readonly List<CardForm> cards = new List<CardForm>();
        readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
        readonly StreamWriter output;
        readonly Timer pump;
        readonly Timer topmost;
        double dpiScale = 1.0;
        bool quitting;
        SoundPlayer activePlayer;
        public bool DemoMode;

        public NotifierApp()
        {
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.AutoFlush = true;
            dpiScale = DetectDpi();

            pump = new Timer();
            pump.Interval = 40;
            pump.Tick += delegate { PumpQueue(); };
            pump.Start();

            topmost = new Timer();
            topmost.Interval = 2000;
            topmost.Tick += delegate { foreach (CardForm c in cards) c.ReassertTopmost(); };
            topmost.Start();
        }

        static double DetectDpi()
        {
            try
            {
                using (Graphics g = Graphics.FromHwnd(IntPtr.Zero))
                {
                    double d = g.DpiX / 96.0;
                    return d <= 0 ? 1.0 : d;
                }
            }
            catch { return 1.0; }
        }

        public void Start()
        {
            if (DemoMode) return;
            System.Threading.Thread t = new System.Threading.Thread(ReadLoop);
            t.IsBackground = true;
            t.Start();
        }

        void ReadLoop()
        {
            try
            {
                StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = reader.ReadLine()) != null) inbox.Enqueue(line);
            }
            catch { }
            inbox.Enqueue("{\"t\":\"eof\"}");
        }

        public void Send(Dictionary<string, object> msg)
        {
            if (DemoMode) return;
            try
            {
                output.WriteLine(ToJson(msg));
                output.Flush();
            }
            catch { }
        }

        public void SendClosed(string id, string reason)
        {
            Dictionary<string, object> m = new Dictionary<string, object>();
            m["t"] = "closed";
            m["id"] = id;
            m["reason"] = reason;
            Send(m);
        }

        static string ToJson(Dictionary<string, object> d)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append('{');
            bool first = true;
            foreach (KeyValuePair<string, object> kv in d)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('"').Append(kv.Key).Append("\":");
                if (kv.Value == null) sb.Append("null");
                else if (kv.Value is bool) sb.Append(((bool)kv.Value) ? "true" : "false");
                else if (kv.Value is int) sb.Append(((int)kv.Value).ToString(CultureInfo.InvariantCulture));
                else sb.Append('"').Append(Escape(Convert.ToString(kv.Value))).Append('"');
            }
            sb.Append('}');
            return sb.ToString();
        }

        static string Escape(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder();
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        void PumpQueue()
        {
            string line;
            int n = 0;
            while (n < 32 && inbox.TryDequeue(out line))
            {
                n++;
                Handle(line);
            }
        }

        void Handle(string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            Dictionary<string, object> msg;
            try { msg = Json.Obj(line); }
            catch { return; }
            string t = Json.S(msg, "t", "");
            if (t == "show") ShowCard(msg);
            else if (t == "dismiss") Dismiss(Json.S(msg, "id", ""));
            else if (t == "quit" || t == "eof") Quit();
            else if (t == "ping") { Dictionary<string, object> p = new Dictionary<string, object>(); p["t"] = "pong"; Send(p); }
            else if (t == "sound") PlaySpec(Json.S(msg, "sound", ""), Json.S(msg, "custom", ""));
        }

        void ShowCard(Dictionary<string, object> msg)
        {
            if (quitting) return;
            object incomingCfg;
            if (msg.TryGetValue("cfg", out incomingCfg))
            {
                Dictionary<string, object> patch = incomingCfg as Dictionary<string, object>;
                if (patch != null) ApplyConfig(patch);
            }
            Card c = new Card();
            c.Id = Json.S(msg, "id", "");
            c.Kind = Json.S(msg, "kind", "complete");
            c.Title = Json.S(msg, "title", "");
            c.Subtitle = Json.S(msg, "subtitle", "");
            c.SessionId = Json.S(msg, "sessionId", "");
            c.DurationMs = Json.I(msg, "durationMs", cfg.DurationMs);
            c.Sound = Json.S(msg, "sound", "");

            while (cards.Count >= Math.Max(1, cfg.MaxCards))
            {
                CardForm oldest = cards[cards.Count - 1];
                cards.RemoveAt(cards.Count - 1);
                try { oldest.Close(); } catch { }
                try { oldest.Dispose(); } catch { }
            }

            CardForm form = new CardForm(this, cfg, c, dpiScale);
            cards.Insert(0, form);
            LayoutCards();
            form.ShowAt();

            Dictionary<string, object> shown = new Dictionary<string, object>();
            shown["t"] = "shown";
            shown["id"] = c.Id;
            Send(shown);
        }

        void Dismiss(string id)
        {
            CardForm c = Find(id);
            if (c != null) c.StartLeave();
        }

        CardForm Find(string id)
        {
            foreach (CardForm c in cards) if (c.CardId == id) return c;
            return null;
        }

        void LayoutCards()
        {
            if (cards.Count == 0) return;
            Rectangle wa = ScreenArea();
            int w = (int)Math.Round(cfg.Width * dpiScale * cfg.Scale);
            int h = (int)Math.Round(cfg.Height * dpiScale * cfg.Scale);
            int margin = (int)Math.Round(cfg.Margin * dpiScale * cfg.Scale);
            int gap = (int)Math.Round(cfg.Gap * dpiScale * cfg.Scale);

            // One stack for every kind: index 0 is the newest card and sits at
            // the anchor; older cards move up. Splitting the stack per kind made
            // two cards share the anchor and cover each other.
            bool right = cfg.Position == "bottom-right" || cfg.Position == "top-right";
            bool bottom = cfg.Position == "bottom-right" || cfg.Position == "bottom-left";
            int left = right ? wa.Right - margin - w : wa.Left + margin;

            for (int i = 0; i < cards.Count; i++)
            {
                int top = bottom
                    ? wa.Bottom - margin - h - i * (h + gap)
                    : wa.Top + margin + i * (h + gap);
                cards[i].SetBase(left, top);
            }
        }

        Rectangle ScreenArea()
        {
            if (cfg.Screen == "cursor")
            {
                try { return Screen.FromPoint(Cursor.Position).WorkingArea; } catch { }
            }
            return Screen.PrimaryScreen.WorkingArea;
        }

        public void PlaySound(Card card)
        {
            string spec = card.Sound;
            if (string.IsNullOrEmpty(spec))
            {
                if (card.Kind == "approval") spec = cfg.SoundApproval;
                else if (card.Kind == "error") spec = cfg.SoundError;
                else if (card.Kind == "question") spec = cfg.SoundQuestion;
                else spec = cfg.SoundComplete;
            }
            string custom = "";
            if (card.Kind == "approval") custom = cfg.CustomSoundApproval;
            else if (card.Kind == "error") custom = cfg.CustomSoundError;
            else if (card.Kind == "question") custom = cfg.CustomSoundQuestion;
            else custom = cfg.CustomSoundComplete;

            PlaySpec(spec, custom);
        }

        /** The one playback path: a custom file wins, then `media:<file>` from the
         *  Windows Media folder, then the legacy SystemSounds set. The player is
         *  kept alive because Play() is asynchronous. */
        public void PlaySpec(string spec, string custom)
        {
            try
            {
                if (!string.IsNullOrEmpty(custom))
                {
                    string resolved = ResolveSoundPath(custom);
                    if (File.Exists(resolved))
                    {
                        activePlayer = new SoundPlayer(resolved);
                        activePlayer.Play();
                        return;
                    }
                }
            }
            catch (Exception customError)
            {
                LogSoundError("custom", customError);
            }

            try
            {
                if (string.IsNullOrEmpty(spec) || spec == "none") return;

                // A bare path (absolute, or relative to the plugin directory)
                // plays that file; this is how the bundled sounds are addressed.
                if (spec.EndsWith(".wav", StringComparison.OrdinalIgnoreCase))
                {
                    string resolved = ResolveSoundPath(spec);
                    if (File.Exists(resolved))
                    {
                        activePlayer = new SoundPlayer(resolved);
                        activePlayer.Play();
                    }
                    else
                    {
                        System.Media.SystemSounds.Asterisk.Play();
                    }
                    return;
                }

                if (spec.StartsWith("media:", StringComparison.OrdinalIgnoreCase))
                {
                    string name = spec.Substring(6);
                    string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Media", name + ".wav");
                    if (File.Exists(file))
                    {
                        activePlayer = new SoundPlayer(file);
                        activePlayer.Play();
                    }
                    else
                    {
                        System.Media.SystemSounds.Asterisk.Play();
                    }
                    return;
                }

                if (spec == "system:beep") { System.Media.SystemSounds.Beep.Play(); return; }
                if (spec == "system:exclamation") { System.Media.SystemSounds.Exclamation.Play(); return; }
                if (spec == "system:hand") { System.Media.SystemSounds.Hand.Play(); return; }
                if (spec == "system:question") { System.Media.SystemSounds.Question.Play(); return; }
                System.Media.SystemSounds.Asterisk.Play();
            }
            catch (Exception specError)
            {
                LogSoundError(spec, specError);
            }
        }

        /** A failed playback is otherwise silent: leave a diagnostic on stderr. */
        static void LogSoundError(string subject, Exception error)
        {
            try
            {
                Console.Error.WriteLine("[notify] sound failed (" + subject + "): " + (error == null ? "unknown" : error.Message));
                Console.Error.Flush();
            }
            catch { }
        }

        /** Absolute paths stay; relative ones resolve against the plugin directory. */
        string ResolveSoundPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            if (Path.IsPathRooted(path)) return path;
            if (!string.IsNullOrEmpty(cfg.BaseDir)) return Path.Combine(cfg.BaseDir, path);
            return path;
        }

        public void RaiseAndClick(Card card)
        {
            try
            {
                IntPtr hwnd = DshWindow.Find();
                Native.Activate(hwnd);
            }
            catch { }
            Dictionary<string, object> m = new Dictionary<string, object>();
            m["t"] = "click";
            m["id"] = card.Id;
            m["sessionId"] = card.SessionId;
            Send(m);
        }

        public void RemoveCard(CardForm form)
        {
            if (form == null) return;
            if (cards.Remove(form)) LayoutCards();
        }

        public void ApplyConfig(Dictionary<string, object> d)
        {
            cfg.Width = Json.I(d, "width", cfg.Width);
            cfg.Height = Json.I(d, "height", cfg.Height);
            cfg.Scale = Json.D(d, "scale", cfg.Scale);
            cfg.Margin = Json.I(d, "margin", cfg.Margin);
            cfg.Gap = Json.I(d, "gap", cfg.Gap);
            cfg.MaxCards = Json.I(d, "maxCards", cfg.MaxCards);
            cfg.DurationMs = Json.I(d, "durationMs", cfg.DurationMs);
            cfg.Position = Json.S(d, "position", cfg.Position);
            cfg.ApprovalPosition = Json.S(d, "approvalPosition", cfg.ApprovalPosition);
            cfg.Screen = Json.S(d, "screen", cfg.Screen);
            cfg.BgColor = Json.S(d, "bgColor", cfg.BgColor);
            cfg.BorderColor = Json.S(d, "borderColor", cfg.BorderColor);
            cfg.TitleColor = Json.S(d, "titleColor", cfg.TitleColor);
            cfg.SubtitleColor = Json.S(d, "subtitleColor", cfg.SubtitleColor);
            cfg.AccentComplete = Json.S(d, "accentComplete", cfg.AccentComplete);
            cfg.AccentApproval = Json.S(d, "accentApproval", cfg.AccentApproval);
            cfg.AccentError = Json.S(d, "accentError", cfg.AccentError);
            cfg.AccentQuestion = Json.S(d, "accentQuestion", cfg.AccentQuestion);
            cfg.IconStyle = Json.S(d, "iconStyle", cfg.IconStyle);
            cfg.IconComplete = Json.S(d, "iconComplete", cfg.IconComplete);
            cfg.IconApproval = Json.S(d, "iconApproval", cfg.IconApproval);
            cfg.IconError = Json.S(d, "iconError", cfg.IconError);
            cfg.IconQuestion = Json.S(d, "iconQuestion", cfg.IconQuestion);
            cfg.FontFamily = Json.S(d, "fontFamily", cfg.FontFamily);
            cfg.BaseDir = Json.S(d, "baseDir", cfg.BaseDir);
            cfg.SoundEnabled = Json.B(d, "soundEnabled", cfg.SoundEnabled);
            cfg.SoundComplete = Json.S(d, "soundComplete", cfg.SoundComplete);
            cfg.SoundApproval = Json.S(d, "soundApproval", cfg.SoundApproval);
            cfg.SoundError = Json.S(d, "soundError", cfg.SoundError);
            cfg.SoundQuestion = Json.S(d, "soundQuestion", cfg.SoundQuestion);
            cfg.CustomSoundComplete = Json.S(d, "customSoundComplete", cfg.CustomSoundComplete);
            cfg.CustomSoundApproval = Json.S(d, "customSoundApproval", cfg.CustomSoundApproval);
            cfg.CustomSoundError = Json.S(d, "customSoundError", cfg.CustomSoundError);
            cfg.CustomSoundQuestion = Json.S(d, "customSoundQuestion", cfg.CustomSoundQuestion);
            cfg.AnimateMs = Json.I(d, "animateMs", cfg.AnimateMs);
            cfg.SlidePx = Json.I(d, "slidePx", cfg.SlidePx);
            cfg.ExitRisePx = Json.I(d, "exitRisePx", cfg.ExitRisePx);
        }

        public void Quit()
        {
            if (quitting) return;
            quitting = true;
            try
            {
                CardForm[] snapshot = cards.ToArray();
                cards.Clear();
                foreach (CardForm c in snapshot)
                {
                    try { c.Close(); } catch { }
                }
            }
            catch { }
            try { if (pump != null) pump.Stop(); } catch { }
            try { if (topmost != null) topmost.Stop(); } catch { }
            try { output.Flush(); } catch { }
            try { ExitThread(); } catch { }
            try { Application.Exit(); } catch { }
            Environment.Exit(0);
        }

        public Cfg Config { get { return cfg; } }

        public void DemoShow(Card c)
        {
            Dictionary<string, object> m = new Dictionary<string, object>();
            m["t"] = "show";
            m["id"] = c.Id;
            m["kind"] = c.Kind;
            m["title"] = c.Title;
            m["subtitle"] = c.Subtitle;
            m["sessionId"] = c.SessionId;
            m["durationMs"] = c.DurationMs;
            m["sound"] = c.Sound;
            ShowCard(m);
        }
    }

    public static class DshWindow
    {
        public static IntPtr Find()
        {
            try
            {
                System.Diagnostics.Process[] all = System.Diagnostics.Process.GetProcessesByName("DeepSeek Harness");
                foreach (System.Diagnostics.Process p in all)
                {
                    try
                    {
                        if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle;
                    }
                    catch { }
                }
            }
            catch { }
            return IntPtr.Zero;
        }
    }

    // ---------------------------------------------------------------- entry
    public static class Program
    {
        static Timer demoTick;
        static Timer demoQuit;

        /** Never let a stray UI exception surface a modal .NET dialog over the user's work. */
        static void InstallGuards()
        {
            try
            {
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e)
                {
                    try
                    {
                        Console.Error.WriteLine("[notify] ui exception: " + (e.Exception == null ? "unknown" : e.Exception.Message));
                        Console.Error.Flush();
                    }
                    catch { }
                };
                AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
                {
                    try
                    {
                        Console.Error.WriteLine("[notify] fatal: " + Convert.ToString(e.ExceptionObject));
                        Console.Error.Flush();
                    }
                    catch { }
                };
            }
            catch { }
        }

        [STAThread]
        public static void Main()
        {
            Native.EnableDpiAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            InstallGuards();
            NotifierApp app = new NotifierApp();
            app.Start();
            Dictionary<string, object> ready = new Dictionary<string, object>();
            ready["t"] = "ready";
            app.Send(ready);
            Application.Run(app);
        }

        [STAThread]
        public static void Demo(string path)
        {
            Native.EnableDpiAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            InstallGuards();
            NotifierApp app = new NotifierApp();
            app.DemoMode = true;
            string json = File.ReadAllText(path, Encoding.UTF8);
            Dictionary<string, object> root = Json.Obj(json);
            object cfgObj = null;
            root.TryGetValue("cfg", out cfgObj);
            Dictionary<string, object> cfg = cfgObj as Dictionary<string, object>;
            if (cfg != null) app.ApplyConfig(cfg);

            object listObj;
            List<object> list = root.TryGetValue("cards", out listObj) ? listObj as List<object> : null;
            if (list == null) list = new List<object>();

            List<Card> cards = new List<Card>();
            foreach (object o in list)
            {
                Dictionary<string, object> d = o as Dictionary<string, object>;
                if (d == null) continue;
                Card c = new Card();
                c.Id = Json.S(d, "id", "demo-" + cards.Count);
                c.Kind = Json.S(d, "kind", "complete");
                c.Title = Json.S(d, "title", "");
                c.Subtitle = Json.S(d, "subtitle", "");
                c.DurationMs = Json.I(d, "durationMs", 9000);
                c.Sound = Json.S(d, "sound", "");
                cards.Add(c);
            }

            demoTick = new Timer();
            demoTick.Interval = 260;
            int index = 0;
            demoTick.Tick += delegate
            {
                if (index < cards.Count)
                {
                    app.DemoShow(cards[index]);
                    index++;
                }
                else
                {
                    demoTick.Stop();
                    demoQuit = new Timer();
                    demoQuit.Interval = 12000;
                    demoQuit.Tick += delegate { demoQuit.Stop(); app.Quit(); };
                    demoQuit.Start();
                }
            };
            demoTick.Start();
            Application.Run(app);
        }
    }
}
