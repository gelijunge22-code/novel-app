package com.nbapp.desk;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.database.Cursor;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.Resources;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 写作台 — Android WebView shell for the NB writing web app.
 *
 * No Gradle / no AndroidX: plain framework Activity, built with aapt2 + javac + d8 + apksigner.
 */
public class MainActivity extends Activity {

    /* 版本号一律从「安装包自己」读 —— AndroidManifest.xml 是唯一出处。
       以前这儿写死 1.1 / 2，清单早升到 1.2 / 3，于是：
       JS 问到的版本永远是旧的 → 关于页永远提示「有新版本」，
       用户升到最新了还一直被告知要更新，看着莫名其妙。
       兜底常量只在 PackageManager 取不到时才用。 */
    public static final String VERSION_NAME = "0.0";
    public static final int VERSION_CODE = 0;

    private String apkVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) { return VERSION_NAME; }
    }

    private int apkVersionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return (int) pi.getLongVersionCode();
            return pi.versionCode;
        } catch (Exception e) { return VERSION_CODE; }
    }

    private static final String PREFS = "nbapp_prefs";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_IMMERSIVE = "immersive";
    /** 主题底色：网页那边每次换主题就把它推过来。WebView 自己的底色必须跟主题一致 ——
        硬写死成米黄的话，夜间模式下"没被内容盖住的像素"会亮成一片白（用户截图里
        弹层弧线外侧那片白就是它）。冷启动第一帧也读它，免得先闪一下浅色。 */
    private static final String KEY_THEME_PAPER = "theme_paper";
    /** 默认底（米黄）：网页还没推过主题时用它。 */
    private static final String DEFAULT_PAPER = "#F3EAD9";
    /* 服务器地址（路线乙的保底后端）。
       2026-09-20 用户拍板：手机里跑 Python（Chaquopy）这条路**只在真机上暴露问题**，
       而开发这边既没有真机也起不了模拟器（这台机器没有 KVM），每修一轮都要用户装一次、
       再截图回来 —— 这条路折腾不起。所以改成：
         · **默认走服务器上那份自研后端**（和网页版同一个 `server/`，245 个接口一个不少）
         · 手机里那份 Python 后端**降级成"能用就用"**：后台悄悄起，起来了就自动接管（离线全功能），
           起不来就安静地留在服务器模式，绝不白屏、绝不闪退。
       地址可以在「设置 → 服务器设置」里改；填的是这台机器上的 Caddy 前缀。 */
    private static final String DEFAULT_SERVER = "http://[REDACTED-HOST]/novel/";

    /**
     * 给 JS 桥（ApiBridge）读的两个静态值：
     * 媒体（音频/封面/导出）走本机 127.0.0.1 时用的前缀与口令。
     * 页面本身是从 APK 的 assets 里加载的，**不经过这里**。
     */
    static volatile String mediaBase = "";
    static volatile String mediaToken = "";
    private static final long EXIT_WINDOW_MS = 2000L;

    private FrameLayout root;
    private WebView webView;
    private SharedPreferences sp;
    private long lastBackPress = 0L;
    private boolean errorShown = false;
    private boolean bridgeInstalled = false;
    private boolean immersive = false;   // 默认保留状态栏：全隐藏反而更像「奇怪的工具」
    private String barColor = "#F3EAD9";
    private boolean darkIcons = true;
    /* 手机内后端（Chaquopy 嵌入式 Python）：端口和本次会话的本地口令。
       端口 0 = 还没起来（界面先给"正在启动"）。 */
    private int localPort = 0;
    private String localToken = "";
    private String localError = "";
    private android.widget.TextView bootView;
    /* 启动流程的看门狗：到点必须把界面放出来（真机"一片黄、什么都没有"就是少了它）。 */
    private volatile boolean shellLoaded = false;
    private volatile String backendMode = "starting";   // starting / local / server / down
    private volatile String backendWhy = "";
    private static final String KEY_LOCAL_FAILS = "local_fails";
    /* 上一次本机离线后端成功过吗：成功过就值得多等它一会儿（换来断网可用）。 */
    private static final String KEY_PREFER_LOCAL = "prefer_local";
    /* 用户**显式**打开「本机离线后端」才为真。默认 false。
       2026-09-20 的事故：它一起来就自动接管，而它自己那份数据是**空的** ——
       用户装完 2.0.2 看到的是"设置没了、设定没了、书也没了"（其实服务器上一点没丢）。
       改完之后：它不再默认启动，也不许在服务器可用时抢过去。 */
    private static final String KEY_LOCAL_MODE = "local_mode_v1";
    /* 偏好设置格式版本：用来把 2.0.2 留下的脏状态（prefer_local / local_fails）一次性收掉。 */
    private static final String KEY_SCHEMA = "prefs_schema";
    private static final int SCHEMA_NOW = 2;
    /* 服务器后端客户端（纯 Java，不依赖 Python）。会话口令在它手里。 */
    private static volatile ServerClient SERVER = null;
    private volatile boolean localFinished = false;
    /* 本机后端最多等这么久。超了就先用服务器模式把界面放出来，本机后端起好了再切。
       真机冷启动要 Chaquopy 起解释器 + import FastAPI/uvicorn + 跑迁移，慢的时候好几秒；
       让它无限等 = 用户对着黄屏发呆。 */
    private static final long BOOT_WAIT_MS = 6000L;
    private android.webkit.ValueCallback<Uri[]> filePathCallback;
    private static final int REQ_FILE = 1001;

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 黑匣子要装在最前面：这里之后的任何崩溃都能留下证据。
        attach(this);
        CrashLog.install(this);
        CrashLog.step(this, "onCreate 开始（版本 " + apkVersionName() + "/" + apkVersionCode() + "）");
        try {
            boot(savedInstanceState);
        } catch (Throwable t) {
            // 启动这一步就炸：绝不能白屏/闪退，把原因摆到屏幕上。
            CrashLog.warn(this, "onCreate 失败", t);
            try { showFatalPage(t); } catch (Throwable ignored) { }
        }
    }

    /** 主题底色（#RRGGBB）。网页没推过就用默认米黄。 */
    private String themePaperHex() {
        String v = sp == null ? null : sp.getString(KEY_THEME_PAPER, null);
        if (v != null && v.matches("^#[0-9a-fA-F]{6}$")) return v;
        return DEFAULT_PAPER;
    }

    private int themePaperColor() {
        try { return Color.parseColor(themePaperHex()); }
        catch (Throwable t) { return Color.parseColor(DEFAULT_PAPER); }
    }

    /** 把 root / 启动页 / WebView 三处底色一起刷成当前主题色。 */
    private void applyThemePaper(final String hex) {
        if (hex == null || !hex.matches("^#[0-9a-fA-F]{6}$")) return;
        try { sp.edit().putString(KEY_THEME_PAPER, hex).apply(); } catch (Throwable ignored) { }
        final int c;
        try { c = Color.parseColor(hex); } catch (Throwable t) { return; }
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try { if (root != null) root.setBackgroundColor(c); } catch (Throwable ignored) { }
                try { if (webView != null) webView.setBackgroundColor(c); } catch (Throwable ignored) { }
            }
        });
    }

    private void boot(Bundle savedInstanceState) {
        sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        migratePrefs();
        immersive = sp.getBoolean(KEY_IMMERSIVE, false);
        SERVER = new ServerClient(new ServerClient.Log() {
            @Override public void line(String m) { CrashLog.step(MainActivity.this, m); }
        });
        SERVER.setUserAgent("novelapp-android/" + apkVersionName());
        SERVER.setBase(syncServerUrl());

        root = new FrameLayout(this);
        root.setBackgroundColor(themePaperColor());

        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        applyImmersive(immersive);
        setupWebView();
        CrashLog.step(this, "WebView 就绪");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        // 桥先装上：api.js 是在解析那一刻判断 window.NBApp 有没有的，装晚了就用不上。
        // 桥上的方法在本机后端没起来时会规规矩矩返回 status:0，前端会据此走 HTTP，
        // 所以"早装"是安全的（以前要等 Python 就绪才装，等于把界面和 Python 绑死了）。
        installBridge();
        showBootView();
        maybeShowCrashReport();
        /* 本机 Python 后端**默认不启动**（见 docs/决策记录 D13）。
           它只在用户显式打开「本机离线后端」时才起 —— 它一起来就会接管后端，
           而它自己那份数据是空的，用户看到的就是"东西全没了"。 */
        if (localModeOn()) startLocalBackend(); else localFinished = true;
        chooseBackendAndShow();
    }

    /**
     * 定后端 → 放界面（**一次会话只认一个后端，中途绝不切换**）。
     *
     * 为什么中途不切：本机后端和服务器后端是**两份不同的数据**（手机私有目录 vs 服务器），
     * 中途换后端会让书架突然变一个样，用户会以为"书丢了"。所以宁可启动时多等一会儿。
     *
     * 为什么一定要有这一步：以前壳要等本机 Python 就绪才加载，Python 一卡住
     * 就是真机上那个"一片黄、什么都没有"。现在无论本机成不成，**到这里一定会把界面放出来**。
     */
    private void chooseBackendAndShow() {
        final boolean wantLocal = localModeOn();
        /* ① 界面先放出来：**永远从安装包里加载**（assets/www）——
              秒开、不是"加载网页"，而且断网也打得开。
              后端地址随后再敲给前端（见 notifyBackend），前端等着这一下。 */
        runOnUiThread(new Runnable() {
            @Override public void run() {
                backendMode = wantLocal ? "starting" : "server";
                loadShellFromAssets();
                notifyBackend(backendMode);
                webView.postDelayed(new Runnable() {
                    @Override public void run() { dropBootView(); }
                }, 420);
            }
        });
        /* ② 后台定后端：要么用户显式开的本机离线，要么服务器（默认，唯一真身）。 */
        new Thread(new Runnable() {
            @Override public void run() {
                if (wantLocal) {
                    long end = System.currentTimeMillis() + 10000L;
                    while (System.currentTimeMillis() < end && localPort <= 0 && !localFinished) {
                        try { Thread.sleep(120); } catch (InterruptedException e) { break; }
                    }
                    if (localPort > 0) {
                        CrashLog.step(MainActivity.this, "定后端：本机离线（用户显式开启）");
                        runOnUiThread(new Runnable() { @Override public void run() {
                            refreshMediaBase();
                            backendMode = "local"; backendWhy = "";
                            notifyBackend(backendMode);
                        }});
                        return;
                    }
                }
                ServerClient sc = SERVER;
                int st = sc == null ? 0 : sc.health();
                final boolean up = st >= 200 && st < 500;
                final String why = up ? "" : (sc == null ? "没有服务器地址" : sc.lastError());
                CrashLog.step(MainActivity.this, "定后端：服务器 " + (sc == null ? "?" : sc.base())
                        + " → " + (up ? ("通（HTTP " + st + "）") : ("连不上（" + why + "）")));
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        backendMode = up ? "server" : "server-down";
                        backendWhy = why;
                        notifyBackend(backendMode);
                    }
                });
            }
        }, "novelapp-choose").start();
    }

    /** 用户显式开过「本机离线后端」吗（默认关）。 */
    private boolean localModeOn() {
        return sp != null && sp.getBoolean(KEY_LOCAL_MODE, false);
    }

    /**
     * 升上来的一次性收拾：把 2.0.2 留下的脏状态收掉。
     *
     * 2.0.2 的毛病是"本机 Python 起来了就接管"，而它那份数据是空的 —— 用户看到一片空白。
     * 升上来之后：**默认走服务器**；prefer_local / local_fails 这两个开关直接清掉
     * （不清的话下次启动还会"多等本机 10 秒"）；服务器地址没设过就补上默认的那台。
     */
    private void migratePrefs() {
        /* 服务器地址纠偏（**每次启动都查**）：
           老版本可能把地址存成了旧前缀 `/nbapp/`（旧 App 的反代），
           或者用户手输过一个已经不用的地址 —— 那样 App 会一直跟**错的后端**说话，
           表现就是「密码怎么输都不对」（旧后端当然不认新口令）。
           只纠"明显是旧前缀"的那种，用户自己填的其它地址不动。 */
        try {
            String su = sp.getString(KEY_SERVER, "");
            if (su != null && su.contains("/nbapp")) {
                CrashLog.step(this, "服务器地址纠偏：" + su + " → " + DEFAULT_SERVER);
                sp.edit().putString(KEY_SERVER, normalize(DEFAULT_SERVER)).apply();
            }
        } catch (Throwable ignored) {}
        int schema = sp.getInt(KEY_SCHEMA, 1);
        if (schema >= SCHEMA_NOW) {
            // 老版本留的 prefer_local 也要保证是关的（这一版它不该再起作用）
            if (sp.getBoolean(KEY_PREFER_LOCAL, false)) sp.edit().putBoolean(KEY_PREFER_LOCAL, false).apply();
            return;
        }
        CrashLog.step(this, "配置升级 v" + schema + " → v" + SCHEMA_NOW
                + "：默认改走服务器后端，清掉 2.0.2 的本机优先状态");
        sp.edit()
          .putInt(KEY_SCHEMA, SCHEMA_NOW)
          .putBoolean(KEY_PREFER_LOCAL, false)
          .putBoolean(KEY_LOCAL_MODE, false)
          .putInt(KEY_LOCAL_FAILS, 0)
          .apply();
    }

    private void markShellLoaded() {
        shellLoaded = true;
        /* 页面 DOM 起来之后再敲一次"后端定下来了"。
           为什么要**这么早**：前端 boot() 会等这一下才决定怎么渲染，等不到就要耗满它的超时，
           表现就是"打开 App 先盯着启动页"（用户 2.0.1 报的"一片黄"）。所以两路一起上：
             · onPageFinished（页面脚本已经执行完的那一刻，最准，见 NovelWebClient）
             · 再加一个 250ms 的兜底定时（onPageFinished 偶发不回调时不至于干等）
           250ms 足够 DOM + JS 就位；以前写 1000ms 是白等。 */
        webView.postDelayed(new Runnable() {
            @Override public void run() {
                notifyBackend(backendMode);
            }
        }, 250);
    }

    /**
     * 看门狗：到点无论如何把"正在启动"那层撤掉、把壳放出来。
     * 黄屏空白的根因就是这条缺失 —— 启动链条上任何一环慢/挂，用户就只能干等。
     */
    private void startBootWatchdog() {
        new Thread(new Runnable() {
            @Override public void run() {
                try { Thread.sleep(BOOT_WAIT_MS + 1500); } catch (InterruptedException e) { return; }
                if (shellLoaded) return;
                CrashLog.step(MainActivity.this, "看门狗：等了 " + (BOOT_WAIT_MS + 1500)
                        + "ms 界面还没稳定，强制放出来（backendMode=" + backendMode + "）");
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        dropBootView();
                        // 兜底也要真的把界面放出来 —— 只撤启动页不管用，撤完还是空的。
                        // 兜底一律走**安装包里那份前端**：它不依赖任何服务器，一定出得来。
                        if (!shellLoaded) {
                            backendMode = "server";
                            loadShellFromAssets();
                        }
                        notifyBackend(backendMode);
                    }
                });
            }
        }, "novelapp-watchdog").start();
    }

    /** 上次崩过就把摘要摆出来（可选中复制 / 可分享），别让用户只能干瞪眼。 */
    private void maybeShowCrashReport() {
        final String brief = CrashLog.takeLastCrash(this);
        if (brief == null || brief.length() == 0) return;
        CrashLog.step(this, "上次崩溃过，弹报告（" + brief.length() + " 字）");
        try {
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setText("上次没能正常启动。下面是原因，可长按复制／点「分享」发给开发：\n\n" + brief);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
            tv.setTextIsSelectable(true);
            tv.setPadding(dp(18), dp(18), dp(18), dp(18));
            tv.setBackgroundColor(themePaperColor());
            tv.setTextColor(Color.parseColor("#3B2A1C"));
            android.widget.ScrollView sv = new android.widget.ScrollView(this);
            sv.addView(tv);
            new AlertDialog.Builder(this)
                    .setTitle("启动故障报告")
                    .setView(sv)
                    .setPositiveButton("继续用", null)
                    .setNeutralButton("分享", new DialogInterface.OnClickListener() {
                        @Override public void onClick(DialogInterface d, int w) {
                            try {
                                Intent i = new Intent(Intent.ACTION_SEND);
                                i.setType("text/plain");
                                i.putExtra(Intent.EXTRA_TEXT, brief);
                                startActivity(Intent.createChooser(i, "把故障报告发出去"));
                            } catch (Throwable ignored) { }
                        }
                    })
                    .show();
        } catch (Throwable ignored) { }
    }

    /** 启动就炸时的兜底页面：白屏/闪退换成一句人话 + 可复制的堆栈。 */
    private void showFatalPage(Throwable t) {
        StringWriter0 sw = new StringWriter0();
        java.io.PrintWriter pw = new java.io.PrintWriter(sw.buf);
        t.printStackTrace(pw);
        pw.flush();
        String detail = sw.buf.toString();
        if (detail.length() > 6000) detail = detail.substring(0, 6000);
        String html = "<html><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<body style='background:#F3EAD9;color:#3B2A1C;font-family:sans-serif;padding:22px;line-height:1.7'>"
                + "<h3>App 启动出错</h3><p>数据没丢。下面是原因，长按可以复制：</p>"
                + "<pre style='font-size:11px;white-space:pre-wrap;word-break:break-all;color:#8A6A4F'>"
                + android.text.TextUtils.htmlEncode(detail) + "</pre>"
                + "<p style='font-size:12px;color:#8A6A4F'>日志：Android/data/com.nbapp.desk/files/ondevice.log</p>"
                + "</body></html>";
        try {
            webView.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "UTF-8", null);
        } catch (Throwable ignored) { }
    }

    /** 只为 showFatalPage 里拼字符串用的小火柴盒（省一个 import）。 */
    private static final class StringWriter0 {
        final java.io.StringWriter buf = new java.io.StringWriter();
    }

    /**
     * 原生启动画面。
     *
     * 用户的要求是「点开给人的感觉就是个 APP，不是网页」。所以这里**不是**一句
     * "正在启动本机服务…"（那读起来像个加载网页的进度条），而是跟 App 里那块启动页
     * 长得一模一样的一屏：一个大「书」字 + 手 机 写 作 台 + 一根细线。
     * 两层长得一样，交接的时候用户看不出换过手（也就没有"网页加载"那一下闪）。
     *
     * 它现在只会在冷启动的头一两百毫秒里出现 —— 前端壳是**立刻**加载的，
     * 不再等 Python（等 Python 就是真机上"一片黄、什么都没有"的来源）。
     */
    private void showBootView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(themePaperColor());

        android.widget.TextView mark = new android.widget.TextView(this);
        mark.setText("书");
        mark.setTextSize(TypedValue.COMPLEX_UNIT_SP, 64);
        mark.setTextColor(Color.parseColor("#8B5E34"));
        mark.setGravity(Gravity.CENTER);
        android.widget.LinearLayout.LayoutParams lp1 =
                new android.widget.LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp1.bottomMargin = dp(14);
        box.addView(mark, lp1);

        android.widget.TextView sub = new android.widget.TextView(this);
        sub.setText("手 机 写 作 台");
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        sub.setTextColor(Color.parseColor("#A08A72"));
        sub.setLetterSpacing(0.34f);
        sub.setGravity(Gravity.CENTER);
        box.addView(sub);

        // 一根细细的、来回走的线（跟网页启动页同一套观感；不是"转圈读秒"）
        final android.widget.ProgressBar bar = new android.widget.ProgressBar(
                this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setIndeterminate(true);
        android.widget.LinearLayout.LayoutParams lp2 =
                new android.widget.LinearLayout.LayoutParams(dp(96), dp(2));
        lp2.topMargin = dp(20);
        box.addView(bar, lp2);

        bootView = new android.widget.TextView(this);   // 占位，真正的容器是 box
        bootView.setVisibility(View.GONE);
        box.addView(bootView, new FrameLayout.LayoutParams(0, 0));
        bootContainer = box;
        root.addView(box, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private View bootContainer;

    private void dropBootView() {
        if (bootContainer != null) {
            final View v = bootContainer;
            bootContainer = null;
            try {
                v.animate().alpha(0f).setDuration(180).withEndAction(new Runnable() {
                    @Override public void run() { try { root.removeView(v); } catch (Throwable ignored) { } }
                }).start();
            } catch (Throwable t) {
                try { root.removeView(v); } catch (Throwable ignored) { }
            }
            return;
        }
        if (bootView == null) return;
        final android.widget.TextView v = bootView;
        bootView = null;
        try {
            v.animate().alpha(0f).setDuration(180).withEndAction(new Runnable() {
                @Override public void run() { try { root.removeView(v); } catch (Throwable ignored) { } }
            }).start();
        } catch (Throwable t) {
            try { root.removeView(v); } catch (Throwable ignored) { }
        }
    }

    /**
     * 把整份后端跑在手机里（Chaquopy 的 CPython），WebView 直接连本机 127.0.0.1。
     *
     * 这一步是"本体是个 App"的关键：飞行模式下 App 打开就是**完整的后端 + 前端**，
     * 只有调模型写正文那一步需要联网。
     */
    /**
     * 后台尝试把后端跑在手机里（**能起来就用，起不来就安静地留在服务器模式**）。
     *
     * 三条纪律（都是真机踩出来的）：
     *  1. **绝不挡界面**：壳早就放出来了，这里慢/挂都影响不到用户看到东西。
     *  2. **绝不把异常漏到主线程**：整条链子包在 try/catch 里，失败只写日志 + 告诉前端。
     *  3. **连续失败就记住**：下次启动直接跳过（否则每次开 App 都要白等几秒），
     *     用户在「设置 → 本机离线后端」里点一下可以重试。
     */
    private void startLocalBackend() {
        final int fails = sp.getInt(KEY_LOCAL_FAILS, 0);
        if (fails >= 2) {
            backendMode = "down";
            backendWhy = "本机离线后端连续失败 " + fails + " 次，已先跳过（设置里可以重试）";
            CrashLog.step(this, backendWhy);
            localFinished = true;
            return;
        }
        new Thread(new Runnable() {
            @Override public void run() {
                long t0 = System.currentTimeMillis();
                try {
                    final java.io.File dir = getFilesDir();
                    CrashLog.step(MainActivity.this, "本机后端：开始（第 " + (fails + 1) + " 次尝试）");
                    // Chaquopy 要求先用 AndroidPlatform 启动运行时。
                    // **清单里刻意没有声明 PyApplication**：放在 Application.onCreate 里就等于
                    // 把"手机能不能跑 Python"绑死在"App 能不能启动"上 —— 它一抛，进程直接死，
                    // 我们连 catch 的机会都没有（用户报的"一点就闪退"就是这一类）。
                    // 放到这个后台线程里显式启动，出问题就只是"本机后端用不了"，App 照开。
                    com.chaquo.python.Python.start(
                            new com.chaquo.python.android.AndroidPlatform(MainActivity.this));
                    CrashLog.step(MainActivity.this, "本机后端：Python 运行时起来了");
                    java.io.File www = new java.io.File(dir, "www");
                    java.io.File seed = new java.io.File(dir, "seed");
                    int n = copyAssetTree("www", www);
                    int seeded = unzipAsset("seed.zip", seed);
                    n += seeded;
                    CrashLog.step(MainActivity.this, "本机后端：资源就位 " + n + " 个文件");
                    com.chaquo.python.PyObject main = com.chaquo.python.Python.getInstance()
                            .getModule("main");
                    String out = main.callAttr("start", dir.getAbsolutePath(),
                            www.getAbsolutePath(), seed.getAbsolutePath(), 0).toString();
                    org.json.JSONObject jo = new org.json.JSONObject(out);
                    if (jo.has("error")) { localFailed(jo.optString("error")); return; }
                    localPort = jo.optInt("port");
                    localToken = jo.optString("token");
                    CrashLog.step(MainActivity.this, "本机后端就绪 port=" + localPort
                            + "，用时 " + (System.currentTimeMillis() - t0) + "ms");
                    sp.edit().putInt(KEY_LOCAL_FAILS, 0).apply();
                    final boolean late = shellLoaded;
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            backendMode = "local";
                            backendWhy = "";
                            dropBootView();
                            notifyBackend("local");
                            if (late) Toast.makeText(MainActivity.this,
                                    "本机离线后端已就绪（断网也能用）", Toast.LENGTH_SHORT).show();
                        }
                    });
                } catch (Throwable t) {
                    CrashLog.warn(MainActivity.this, "本机后端起不来", t);
                    sp.edit().putInt(KEY_LOCAL_FAILS, sp.getInt(KEY_LOCAL_FAILS, 0) + 1).apply();
                    localFailed(String.valueOf(t));
                } finally {
                    localFinished = true;   // 告诉 chooseBackendAndShow：别等了，定下来吧
                }
            }
        }, "novelapp-python").start();
    }

    /**
     * 告诉前端"后端定下来了"：走本机（离线全功能）还是走服务器。
     * 前端 boot() 等这一下再决定怎么显示（见 api.js 的 __backendReady）。
     */
    private void notifyBackend(final String mode) {
        if (mode != null && !"slow".equals(mode)) backendMode = mode;
        final String info = "{\"mode\":\"" + backendMode + "\",\"base\":\""
                + jsStr(mediaBase) + "\",\"server\":\"" + jsStr(syncServerUrl())
                + "\",\"local\":" + (localPort > 0) + ",\"why\":\"" + jsStr(backendWhy) + "\"}";
        CrashLog.step(this, "告诉前端后端定下来了：" + info);
        try {
            webView.evaluateJavascript("window.__backendReady&&window.__backendReady(" + info + ")", null);
        } catch (Throwable ignored) { }
    }

    private static String jsStr(String v) {
        if (v == null) return "";
        return v.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ");
    }

    /**
     * 装 JS 桥 + 把媒体前缀告诉前端。
     *
     * 前端页面来自 `assets/www/`，所以 **打开 App 不需要任何服务器**；
     * 只有音频/封面/下载这些"字节流"回落到本机 127.0.0.1（见 ApiBridge.base()）。
     */
    private void installBridge() {
        if (bridgeInstalled) return;
        // 桥**必须在页面加载之前**装好：api.js 是在解析那一刻判断 window.NBApp 有没有的。
        // 桥上的方法在本机后端还没起来时会规规矩矩返回 status:0，前端会据此退回 HTTP，
        // 所以"早装"是安全的（以前要等 Python 就绪才装，等于把界面和 Python 绑死了）。
        webView.addJavascriptInterface(new ApiBridge(), "NBApp");
        bridgeInstalled = true;
        refreshMediaBase();
        CrashLog.step(this, "JS 桥已装好（mediaBase=" + mediaBase + "）");
    }

    /** 本机后端起来之后才有的东西：媒体前缀 + 一次性口令。 */
    private void refreshMediaBase() {
        if (localPort <= 0) return;
        mediaBase = "http://127.0.0.1:" + localPort + "/";
        try {
            com.chaquo.python.PyObject fn = com.chaquo.python.Python.getInstance().getModule("main");
            mediaToken = String.valueOf(fn.callAttr("mediaToken"));
        } catch (Throwable t) {
            CrashLog.warn(this, "媒体口令没取到", t);
            mediaToken = localToken;
        }
    }

    /** 壳页面走 assets（file://），不是从服务器拉的 —— 断网也是这一条路。 */
    private void loadShellFromAssets() {
        errorShown = false;
        CrashLog.step(this, "加载内嵌前端（assets/www/index.html）");
        try {
            webView.loadUrl("file:///android_asset/www/index.html");
        } catch (Throwable t) {
            CrashLog.warn(this, "壳页面加载失败", t);
        }
        markShellLoaded();
    }

    private void localFailed(final String why) {
        localError = why == null ? "未知错误" : why;
        backendMode = "server";
        backendWhy = localError;
        CrashLog.step(MainActivity.this, "本机后端起不来：" + localError + "（改用服务器后端，界面照用）");
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (shellLoaded) { notifyBackend("server"); return; }
                dropBootView();
                String html = "<html><meta name='viewport' content='width=device-width,initial-scale=1'>"
                        + "<body style='background:#F3EAD9;color:#3B2A1C;font-family:sans-serif;padding:26px;line-height:1.7'>"
                        + "<h3>本机服务没起来</h3><p>App 自带的后端启动失败，书稿都在手机里，没丢。</p>"
                        + "<p style='color:#8A6A4F;font-size:13px;word-break:break-all'>原因："
                        + android.text.TextUtils.htmlEncode(localError) + "</p>"
                        + "<p style='font-size:13px;color:#8A6A4F'>排错日志：手机文件 "
                        + "Android/data/com.nbapp.desk/files/ondevice.log</p>"
                        + "<p><a style='color:#8B5E34' href='javascript:location.reload()'>重试</a></p>"
                        + "</body></html>";
                webView.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "UTF-8", null);
            }
        });
    }

    /** 把 assets 下的目录整棵复制到手机私有目录（只复制变了大小的文件）。 */
    /**
     * 把打包进来的 seed.zip 解到手机私有目录（首启那一次，只补缺、不覆盖）。
     *
     * 为什么走 zip 而不是一堆散文件：用户的书名、章节名全是中文。
     * aapt2 打进 assets 的中文名**不带 UTF-8 标记**（zip 里 flag_bits=0），
     * 读出来是不是原样得看系统实现怎么猜；换成我们自己打的 zip（UTF-8 标记写死正确）
     * 再显式按 UTF-8 解码，这条路上就没有"猜"的成分了。
     * 验证脚本 tools/verify_seed_zip.java 就是拿同一套 Java API 在桌面上比对的。
     */
    private int unzipAsset(String assetName, java.io.File dst) {
        int n = 0, skipped = 0;
        try {
            java.io.InputStream raw = getAssets().open(assetName);
            java.util.zip.ZipInputStream zin = new java.util.zip.ZipInputStream(
                    raw, java.nio.charset.StandardCharsets.UTF_8);
            byte[] buf = new byte[16384];
            java.util.zip.ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if (name.contains("..")) { zin.closeEntry(); continue; }   // 防目录穿越
                java.io.File out = new java.io.File(dst, name);
                if (e.isDirectory()) { out.mkdirs(); zin.closeEntry(); continue; }
                // 手机上已经有的文件一律不动：用户在设备上写/改过的稿子不许被快照盖掉
                if (out.exists()) { skipped++; zin.closeEntry(); continue; }
                out.getParentFile().mkdirs();
                java.io.FileOutputStream fos = new java.io.FileOutputStream(out);
                int r;
                while ((r = zin.read(buf)) > 0) fos.write(buf, 0, r);
                fos.close();
                n++;
                zin.closeEntry();
            }
            zin.close();
            if (skipped > 0) android.util.Log.i("novelapp", "seed 跳过已存在 " + skipped + " 个");
        } catch (java.io.IOException ex) {
            android.util.Log.w("novelapp", "seed.zip 解包失败：" + ex);
        }
        return n;
    }

    private int copyAssetTree(String assetDir, java.io.File dst) {
        int n = 0;
        try {
            java.util.ArrayDeque<String> queue = new java.util.ArrayDeque<>();
            queue.add(assetDir);
            while (!queue.isEmpty()) {
                String cur = queue.poll();
                String[] kids = getAssets().list(cur);
                if (kids == null || kids.length == 0) continue;
                for (String kid : kids) {
                    String path = cur + "/" + kid;
                    String[] sub = getAssets().list(path);
                    if (sub != null && sub.length > 0) {
                        queue.add(path);
                        continue;
                    }
                    java.io.File out = new java.io.File(dst,
                            path.substring(assetDir.length() + 1));
                    java.io.InputStream in = getAssets().open(path);
                    int size = in.available();
                    if (out.exists() && out.length() == size) { in.close(); continue; }
                    out.getParentFile().mkdirs();
                    java.io.FileOutputStream fos = new java.io.FileOutputStream(out);
                    byte[] buf = new byte[16384];
                    int r;
                    while ((r = in.read(buf)) > 0) fos.write(buf, 0, r);
                    fos.close();
                    in.close();
                    n++;
                }
            }
        } catch (Throwable t) {
            android.util.Log.w("novelapp", "复制 assets 失败 " + assetDir + "：" + t);
        }
        return n;
    }

    @Override
    protected void onDestroy() {
        KeepAliveService.stop(this);
        if (webView != null) {
            try {
                webView.stopLoading();
                webView.setWebChromeClient(null);
                webView.loadUrl("about:blank");
                webView.destroy();
            } catch (Throwable ignored) { }
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive(immersive);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            if (filePathCallback != null) {
                Uri[] out = null;
                if (res == RESULT_OK && data != null && data.getData() != null) {
                    out = new Uri[]{ data.getData() };
                }
                filePathCallback.onReceiveValue(out);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(req, res, data);
    }

    // ------------------------------------------------------------- back button

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) { handleBack(); return true; }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            lastBackPress = 0L;
            return;
        }
        // 网页里没得退了，先问页面：抽屉开着？不在书架？交给它处理。
        if (webView != null) {
            try {
                webView.evaluateJavascript(
                        "(function(){try{return String(!!(window.AndroidBack&&window.AndroidBack()));}"
                                + "catch(e){return 'false';}})()",
                        new android.webkit.ValueCallback<String>() {
                            @Override public void onReceiveValue(String v) {
                                if (v != null && v.indexOf("true") >= 0) { lastBackPress = 0L; return; }
                                confirmExit();
                            }
                        });
                return;
            } catch (Throwable ignored) { }
        }
        confirmExit();
    }

    private void confirmExit() {
        long now = System.currentTimeMillis();
        if (now - lastBackPress < EXIT_WINDOW_MS) {
            finish();
            return;
        }
        lastBackPress = now;
        Toast.makeText(this, getString(R.string.press_again_exit), Toast.LENGTH_SHORT).show();
    }

    // ---------------------------------------------------------------- webview

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        /* 内嵌界面是从 `file:///android_asset/` 加载的，而接口在 http:// 的服务器上 —— 跨源。
           Android **默认禁止** file:// 页面发跨源请求，被拦时是**静默**的：
           界面看着正常，点「进入」什么都不发生，服务器日志里一条请求都没有。
           （真机事故：用户装的 2.0.5 就是"怎么输密码都进不去"。）
           桥那条路已经由 ApiBridge.ready() 修好；这几行是给 fetch / 媒体 / SSE 兜底。 */
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setAllowFileAccessFromFileURLs(true);
        try { s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); } catch (Throwable ignored) {}
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= 26) {
            s.setSafeBrowsingEnabled(false);
        }
        webView.setBackgroundColor(themePaperColor());
        webView.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setHapticFeedbackEnabled(false);   // 去掉长按那一下「默认网页」震动
        if (Build.VERSION.SDK_INT >= 26) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        webView.addJavascriptInterface(new JsBridge(), "Android");
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView view, String title) { }

            /** 网页里报的错也写进黑匣子：真机上出问题，这是唯一的线索来源。 */
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                try {
                    if (m != null && m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) {
                        CrashLog.step(MainActivity.this, "JS 报错 "
                                + m.sourceId() + ":" + m.lineNumber() + " " + m.message());
                    }
                } catch (Throwable ignored) { }
                return false;
            }

            /** 网页里 <input type="file"> 要能真的选文件（上传封面之类）。 */
            @Override
            public boolean onShowFileChooser(WebView view,
                                             android.webkit.ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    startActivityForResult(Intent.createChooser(i, getString(R.string.pick_file)), REQ_FILE);
                    return true;
                } catch (Throwable t) {
                    filePathCallback = null;
                    return false;
                }
            }
        });
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String cd, String mime, long len) {
                // 安装包就地下载 + 直接弹安装；别丢给浏览器（手机没浏览器/被拦就毫无反应）。
                // 放在这一层，网页那边哪怕还是老写法（一个 <a href="apk"> 链接）也能生效。
                if (isApkDownload(url, cd, mime)) startApkDownload(url, null);
                else openExternally(url);
            }
        });
    }

    private class Client extends WebViewClient {
        /**
         * 前端整包内嵌在安装包里（assets/www）。
         * 页面地址仍然是服务器的地址 —— 这样 cookie、localStorage 都挂在服务器名下，
         * 跟浏览器版一模一样；但 index.html / js / css 这些静态文件不走网络，
         * 直接从包里给。断网时界面照样能打开，缓存的章节照样能读。
         * 只有 api/…、nb/api/… 这类动态请求才真的联网。
         */
        @Override
        public android.webkit.WebResourceResponse shouldInterceptRequest(
                WebView view, WebResourceRequest request) {
            try {
                Uri u = request == null ? null : request.getUrl();
                if (u == null) return null;
                String scheme = u.getScheme();
                if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
                String path = u.getPath();
                if (!isEmbeddedAsset(path)) return null;
                return assetResponse(path);
            } catch (Throwable t) {
                return null;   // 取不到就走网络，别把页面卡死
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl() == null ? "" : request.getUrl().toString());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(url == null ? "" : url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            errorShown = false;
            /* 页面脚本执行完的第一个时机：立刻把"后端定下来了"敲给前端。
               启动页什么时候退场基本就等于它 —— 早敲一点，用户就少盯一会儿黄底 logo
               （用户 2.0.1 报的"打开一片黄"，一半是这个）。 */
            try { CrashLog.step(MainActivity.this, "页面加载完：" + url); } catch (Throwable ignored) { }
            notifyBackend(backendMode);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            try {
                if (request != null && !request.isForMainFrame()) {
                    CrashLog.step(MainActivity.this, "子资源加载失败 "
                            + request.getUrl() + "：" + error.getDescription());
                }
            } catch (Throwable ignored) { }
            if (request != null && request.isForMainFrame()) showErrorPage();
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceResponse resp) {
            try {
                if (request != null && request.isForMainFrame()) {
                    CrashLog.step(MainActivity.this, "主页面 HTTP " + resp.getStatusCode()
                            + " " + request.getUrl());
                }
            } catch (Throwable ignored) { }
        }

        /** 渲染进程被系统回收了，别让 App 直接闪退，原地重建一个 WebView。 */
        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            try {
                if (root != null && webView != null) {
                    root.removeView(webView);
                    webView.destroy();
                    webView = null;
                }
                webView = new WebView(MainActivity.this);
                root.addView(webView, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                setupWebView();
                installBridge();
                loadShellFromAssets();          // 界面永远来自安装包：秒开、断网也开
            } catch (Throwable ignored) { }
            return true;
        }
    }

    // ------------------------------------------------------- 内嵌前端（离线也能开）

    private static final java.util.HashSet<String> EMBEDDED = new java.util.HashSet<>(
            java.util.Arrays.asList("/", "/index.html", "/manifest.webmanifest",
                    "/icon-192.png", "/icon-512.png", "/favicon.ico"));

    private static boolean isEmbeddedAsset(String path) {
        if (path == null || path.length() == 0) return false;
        if (EMBEDDED.contains(path)) return true;
        return path.startsWith("/js/") || path.startsWith("/css/");
    }

    private android.webkit.WebResourceResponse assetResponse(String path) {
        String name = (path == null || path.equals("/") || path.length() == 0)
                ? "index.html" : path.substring(1);
        java.io.InputStream in = null;
        try {
            in = getAssets().open("www/" + name);
        } catch (Throwable t) {
            return null;   // 包里没有这个文件 → 交给网络（例如以后加的图标）
        }
        String mime = "application/octet-stream";
        if (name.endsWith(".html")) mime = "text/html";
        else if (name.endsWith(".js")) mime = "application/javascript";
        else if (name.endsWith(".css")) mime = "text/css";
        else if (name.endsWith(".png")) mime = "image/png";
        else if (name.endsWith(".webmanifest")) mime = "application/manifest+json";
        else if (name.endsWith(".ico")) mime = "image/x-icon";
        java.util.Map<String, String> h = new java.util.HashMap<>();
        h.put("Cache-Control", "no-cache");
        h.put("Access-Control-Allow-Origin", "*");
        return new android.webkit.WebResourceResponse(mime, "utf-8", 200, "OK", h, in);
    }

    /** http(s) stays inside the WebView; everything else goes to the system. */
    private boolean handleUrl(String url) {
        if (url == null || url.length() == 0) return false;
        if (url.startsWith("http://") || url.startsWith("https://")) return false;
        if (url.startsWith("about:") || url.startsWith("javascript:") || url.startsWith("data:")) return false;
        openExternally(url);
        return true;
    }

    private void openExternally(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable t) {
            Toast.makeText(this, "无法打开链接：" + url, Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------- 应用内更新（下载+安装）

    /** 判断这次下载是不是「安装包」。看后缀、看响应头、看 MIME 三处都认。 */
    private boolean isApkDownload(String url, String cd, String mime) {
        String u = url == null ? "" : url.toLowerCase();
        String c = cd == null ? "" : cd.toLowerCase();
        String m = mime == null ? "" : mime.toLowerCase();
        if (m.contains("android.package-archive")) return true;
        if (c.contains(".apk")) return true;
        int q = u.indexOf('?');
        if (q >= 0) u = u.substring(0, q);
        return u.endsWith(".apk") || u.endsWith("/apk");
    }

    /**
     * 用系统下载器下载安装包，下完直接拉系统安装界面。
     * 以前是 Intent.ACTION_VIEW 丢给浏览器 —— 那条路在真机上太容易断
     * （没默认浏览器、被安全策略拦、或下载完用户根本找不着文件），
     * 表现就是「点了下载一点用都没有」。现在全程 App 自己管。
     */
    private void startApkDownload(String url, String name) {
        if (url == null || url.length() == 0) return;
        String fileName = (name != null && name.toLowerCase().endsWith(".apk"))
                ? name : "写作台-新版本.apk";
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) { openExternally(url); return; }

            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("写作台 新版本");
            req.setDescription("正在下载安装包…");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            final long id = dm.enqueue(req);
            Toast.makeText(this, "开始下载新版本…", Toast.LENGTH_SHORT).show();

            final DownloadManager fdm = dm;
            final String fUrl = url;
            new Thread(new Runnable() {
                @Override public void run() {
                    // 包很小（~150KB），轮询比注册广播稳 —— Android 13+ 动态注册广播
                    // 还要额外声明导出标志，不如直接查状态。
                    for (int i = 0; i < 240; i++) {
                        try { Thread.sleep(500); } catch (InterruptedException e) { return; }
                        int status;
                        try { status = downloadStatus(fdm, id); } catch (Throwable t) { return; }
                        if (status == DownloadManager.STATUS_SUCCESSFUL) {
                            Uri uri = null;
                            try { uri = fdm.getUriForDownloadedFile(id); } catch (Throwable ignored) { }
                            final Uri fUri = uri;
                            runOnUiThread(new Runnable() {
                                @Override public void run() { installApk(fUri, fUrl); }
                            });
                            return;
                        }
                        if (status == DownloadManager.STATUS_FAILED) {
                            runOnUiThread(new Runnable() {
                                @Override public void run() {
                                    Toast.makeText(MainActivity.this,
                                            "下载失败，改用浏览器打开", Toast.LENGTH_LONG).show();
                                    openExternally(fUrl);
                                }
                            });
                            return;
                        }
                    }
                }
            }).start();
        } catch (Throwable t) {
            openExternally(url);
        }
    }

    private int downloadStatus(DownloadManager dm, long id) {
        Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(id));
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                if (idx >= 0) return c.getInt(idx);
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
        }
        return DownloadManager.STATUS_PENDING;
    }

    /** 拉系统安装界面。没开「安装未知应用」的话，Android 会自己引导用户去开。 */
    private void installApk(Uri uri, String fallbackUrl) {
        if (uri == null) { openExternally(fallbackUrl); return; }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(i);
        } catch (Throwable t) {
            try {
                Intent i2 = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                i2.setData(uri);
                i2.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(i2);
            } catch (Throwable t2) {
                Toast.makeText(this, "已下载完成，请在「文件管理 → 下载」里打开安装包",
                        Toast.LENGTH_LONG).show();
            }
        }
    }

    // ------------------------------------------------------------- error page

    /**
     * 主页面加载不出来的时候怎么办。
     *
     * 以前是跳 `assets/error.html`（一张"加载失败 + 重试"的网页），那一眼就是"这是个网页" ——
     * 用户明确说了不要这个感觉。现在改成：**退到内嵌的那份壳**。
     * 壳本来就在包里，断网也有，界面长得一模一样；数据取不到时前端会自己说
     * 「连不上服务器：只看得到缓存过的书」。用户全程没离开 App，也没看见任何浏览器味的东西。
     */
    private void showErrorPage() {
        if (errorShown) return;
        errorShown = true;
        CrashLog.step(this, "主页面加载失败（backendMode=" + backendMode + "），退到内嵌壳");
        backendMode = "offline";
        loadShellFromAssets();
        notifyBackend("offline");
    }

    // -------------------------------------------------------------- js bridge

    public class JsBridge {
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() { setKeepScreenOn(on); }
            });
        }

        @JavascriptInterface
        public void setKeepAwake(final boolean on) { keepAwake(on); }

        /** 长任务在跑（AI 写正文、批量、流水线）：起前台服务，切后台别被系统收掉。
            跑完网页会调 keepAlive(false)，通知立刻撤掉。 */
        @JavascriptInterface
        public void keepAlive(final boolean on) {
            if (on) KeepAliveService.start(MainActivity.this);
            else KeepAliveService.stop(MainActivity.this);
        }

        @JavascriptInterface
        public String getVersion() { return apkVersionName(); }

        @JavascriptInterface
        public int getVersionCode() { return apkVersionCode(); }

        @JavascriptInterface
        public String getPlatform() { return "android"; }

        /** 网页换主题时推过来：WebView/原生底一起跟着换（夜间不许露白）。传 "#RRGGBB"。 */
        @JavascriptInterface
        public void setThemePaper(String hex) { applyThemePaper(hex); }

        @JavascriptInterface
        public String getThemePaper() { return themePaperHex(); }

        @JavascriptInterface
        public String getServerUrl() { return syncServerUrl(); }

        /** 前端设置页读它：现在是本机离线后端还是服务器，本机为什么没起来。 */
        @JavascriptInterface
        public String localStatus() { return localStatusJson(); }

        /**
         * 「重试本机离线后端」：清掉失败计数再起一遍。
         * 手机上没有 SSH、没有 logcat，用户唯一能自救的入口就是这个按钮。
         */
        @JavascriptInterface
        public void retryLocal() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    sp.edit().putInt(KEY_LOCAL_FAILS, 0).apply();
                    backendMode = "starting";
                    backendWhy = "";
                    Toast.makeText(MainActivity.this, "正在重试本机离线后端…",
                            Toast.LENGTH_SHORT).show();
                    startLocalBackend();
                }
            });
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(new Runnable() {
                @Override public void run() { reloadNow(); }
            });
        }

        /** 连通性自查（前端"连不上服务器"那一屏 + 设置页都用它）：返回一句人话。 */
        @JavascriptInterface
        public String serverCheck() {
            ServerClient c = SERVER;
            if (c == null) return "{\"ok\":false,\"error\":\"没有服务器地址\"}";
            int st = c.health();
            boolean up = st >= 200 && st < 500;
            return "{\"ok\":" + up + ",\"status\":" + st + ",\"base\":\"" + jsStr(c.base())
                    + "\",\"error\":\"" + jsStr(up ? "" : c.lastError()) + "\"}";
        }

        @JavascriptInterface
        public void reload() { retry(); }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(new Runnable() {
                @Override public void run() { showServerDialog(false); }
            });
        }

        /** 网页点「下载 / 更新」时直接调这个：App 自己下载 + 弹安装。 */
        @JavascriptInterface
        public void downloadApk(final String url, final String name) {
            runOnUiThread(new Runnable() {
                @Override public void run() { startApkDownload(url, name); }
            });
        }

        /** 分享（阅读器菜单里的「分享这一章」）：拉起系统「分享到」面板。 */
        @JavascriptInterface
        public void share(final String title, final String text) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        Intent i = new Intent(Intent.ACTION_SEND);
                        i.setType("text/plain");
                        i.putExtra(Intent.EXTRA_SUBJECT, title == null ? "" : title);
                        i.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                        startActivity(Intent.createChooser(i, "分享到"));
                    } catch (Throwable t) {
                        Toast.makeText(MainActivity.this, "这台设备没有可分享的应用",
                                Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        /** 网页问「你是 App 吗 / App 是哪个版本」，用来做版本比对。 */
        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, String.valueOf(msg), Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** 页面点按钮时的轻震动，走原生 Vibrator，比网页 navigator.vibrate 稳。 */
        @JavascriptInterface
        public void vibrate(final int ms) {
            try {
                android.os.Vibrator v;
                if (Build.VERSION.SDK_INT >= 31) {
                    android.os.VibratorManager vm =
                            (android.os.VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                    v = vm == null ? null : vm.getDefaultVibrator();
                } else {
                    v = (android.os.Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                }
                if (v == null || !v.hasVibrator()) return;
                int d = Math.max(1, Math.min(60, ms));
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(android.os.VibrationEffect.createOneShot(
                            d, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(d);
                }
            } catch (Throwable ignored) { }
        }

        /** 页面切主题时同步状态栏颜色；darkIcons=浅色背景（图标要变深）。 */
        @JavascriptInterface
        public void setStatusBar(final String hex, final boolean lightBg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (hex != null && hex.matches("(?i)#[0-9a-f]{6}")) barColor = hex;
                    darkIcons = lightBg;
                    if (!immersive) applySystemBars();
                }
            });
        }

        @JavascriptInterface
        public boolean canGoBack() {
            return webView != null && webView.canGoBack();
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(new Runnable() {
                @Override public void run() { finish(); }
            });
        }
    }

    private void setKeepScreenOn(boolean on) {
        if (webView == null) return;
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    // ------------------------------------------------------------------- prefs

    /**
     * **当前真正在用的后端前缀**（末尾带斜杠）。
     * 本机离线后端起来了 → 127.0.0.1:端口；没起来 → 服务器地址（路线乙的保底）。
     * 前端的 `API.abs()` / `API.media()` 全靠它把相对路径变成发得出去的地址。
     */
    static String effectiveBase() {
        MainActivity a = cur();
        if (a == null) return "";
        if (a.localPort > 0) return "http://127.0.0.1:" + a.localPort + "/";
        ServerClient sc = SERVER;
        return sc != null ? sc.base() : a.syncServerUrl();
    }

    /**
     * 字节流（封面 / 听书音频 / 导出下载）要带的口令。
     *
     * 页面是 file:// 来源，拿不到 http:// 服务器的 cookie（跨源不发、httponly 也读不到），
     * 所以只能挂在 URL 上（服务端认 `?token=`，见 server/security.py 的 token_from）。
     * 本机离线后端用的是另一套一次性口令。
     */
    static String effectiveToken() {
        MainActivity a = cur();
        if (a != null && a.localPort > 0) return mediaToken;
        ServerClient sc = SERVER;
        return sc == null ? "" : sc.token();
    }

    /**
     * 桥这会儿能不能干活（前端据此决定"走桥"还是走 HTTP）。
     *   · 本机离线后端起来了 → 能（进程内直调）
     *   · 否则只要有服务器地址 → 也能（桥的另一头在服务器上，见 ApiBridge.request）
     */
    static boolean bridgeReady() {
        MainActivity a = cur();
        if (a == null) return false;
        if (a.localPort > 0) return true;
        ServerClient sc = SERVER;
        return sc != null && sc.hasBackend();
    }

    /** 服务器客户端（桥用）。 */
    static ServerClient server() { return SERVER; }

    /** 本机后端半路挂了：记一笔，然后让桥改走服务器（别把界面卡在"加载中"）。 */
    static void noteLocalBridgeFail(Throwable t) {
        MainActivity a = cur();
        if (a == null) return;
        CrashLog.warn(a, "本机后端调用失败，这次改走服务器", t);
        a.runOnUiThread(new Runnable() { @Override public void run() {
            MainActivity b = cur();
            if (b != null) { b.backendWhy = "本机后端出错，已改走服务器"; b.notifyBackend("server"); }
        }});
    }

    /** 本机离线后端这会儿可用吗（前端据此决定走桥还是走 HTTP）。 */
    static boolean localReady() {
        MainActivity a = cur();
        return a != null && a.localPort > 0;
    }

    /** 前端问"我现在是哪种后端"（设置页会显示一行）。 */
    static String localStatusJson() {
        MainActivity a = cur();
        if (a == null) return "{\"mode\":\"starting\"}";
        ServerClient sc = SERVER;
        return "{\"mode\":\"" + a.backendMode + "\",\"local\":" + (a.localPort > 0)
                + ",\"port\":" + a.localPort + ",\"why\":\"" + jsStr(a.backendWhy)
                + "\",\"fails\":" + a.sp.getInt(KEY_LOCAL_FAILS, 0)
                + ",\"server\":\"" + jsStr(sc == null ? "" : sc.base())
                + "\",\"localMode\":" + a.localModeOn() + "}";
    }

    /* 桥方法是从 JavaBridge 线程调进来的，拿不到实例字段，所以要有个静态入口。
       用弱引用：Activity 销毁后不该被一个静态变量吊着不放（那样会漏内存）。 */
    private static java.lang.ref.WeakReference<MainActivity> CUR = null;

    static void attach(MainActivity a) { CUR = new java.lang.ref.WeakReference<>(a); }

    private static MainActivity cur() { return CUR == null ? null : CUR.get(); }

    /**
     * 服务器后端地址（**后端唯一真身就在这里**）。
     *
     * 没设过 / 被清空 → 用默认那台（DEFAULT_SERVER）。为什么不再允许"空"：
     * 空 = 没有后端 = 界面虽然打得开，但里面什么都读不到。
     * 2.0.2 那个"东西全没了"的事故里，这一条也是帮凶 —— `DEFAULT_SERVER` 这个常量
     * 当时只写在注释里、**一次都没被用过**，所以全新装的 App 根本不知道服务器在哪。
     */
    private String syncServerUrl() {
        String saved = sp == null ? "" : sp.getString(KEY_SERVER, "");
        if (saved == null || saved.trim().isEmpty()) return normalize(DEFAULT_SERVER);
        return normalize(saved);
    }

    private void saveServer(String raw) {
        sp.edit().putString(KEY_SERVER, normalize(raw)).apply();
    }

    private static String normalize(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.length() == 0) return "";      // 空 = 不设同步服务器（本机后端不受影响）
        if (!u.matches("(?i)^[a-z][a-z0-9+.\\-]*://.*")) u = "http://" + u;
        if (!u.endsWith("/") && u.indexOf('?') < 0 && u.indexOf('#') < 0) u = u + "/";
        return u;
    }

    /**
     * 「重试」：重新探一遍服务器 + 重装界面。
     *
     * 这条路上**没有"退回空数据"这个选项** —— 连不上就再探一遍，探到了就把后端地址
     * 敲给前端（前端自己会去登录/刷新），探不到就把原因写在设置页那一行里。
     */
    private void reloadNow() {
        errorShown = false;
        ServerClient sc = SERVER;
        if (sc != null) sc.setBase(syncServerUrl());
        backendMode = "starting";
        backendWhy = "";
        notifyBackend(backendMode);
        showBootView();
        new Thread(new Runnable() {
            @Override public void run() {
                ServerClient c = SERVER;
                int st = c == null ? 0 : c.health();
                final boolean up = st >= 200 && st < 500;
                final String why = up ? "" : (c == null ? "没有服务器地址" : c.lastError());
                CrashLog.step(MainActivity.this, "重试：服务器 " + (c == null ? "?" : c.base())
                        + " → " + (up ? ("通（HTTP " + st + "）") : ("连不上（" + why + "）")));
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        backendMode = up ? "server" : "server-down";
                        backendWhy = why;
                        dropBootView();
                        loadShellFromAssets();
                        notifyBackend(backendMode);
                        Toast.makeText(MainActivity.this,
                                up ? "已连上服务器" : ("连不上服务器：" + why),
                                Toast.LENGTH_SHORT).show();
                    }
                });
            }
        }, "novelapp-retry").start();
    }

    /** 设置：同步服务器地址（可空 —— 空就是纯离线用本机数据）+ 沉浸式开关。 */
    private void showServerDialog(final boolean firstRun) {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(syncServerUrl());
        input.setHint("http://你的服务器/nbapp/");
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSelectAllOnFocus(true);

        final CheckBox cb = new CheckBox(this);
        cb.setText(getString(R.string.immersive_label));
        cb.setChecked(immersive);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(6), dp(20), 0);

        TextView hint = new TextView(this);
        hint.setText(getString(R.string.server_hint));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        hint.setPadding(0, 0, 0, dp(4));
        box.addView(hint);
        box.addView(input);
        box.addView(cb);

        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle(getString(R.string.dialog_title));
        b.setView(box);
        b.setCancelable(!firstRun);
        b.setPositiveButton(getString(R.string.save_reload), new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface d, int w) {
                String typed = input.getText() == null ? "" : input.getText().toString().trim();
                saveServer(typed);
                immersive = cb.isChecked();
                sp.edit().putBoolean(KEY_IMMERSIVE, immersive).apply();
                applyImmersive(immersive);
                reloadNow();
                Toast.makeText(MainActivity.this,
                        typed.length() == 0 ? ("地址清空了，用默认那台：" + DEFAULT_SERVER)
                                : "服务器地址已保存，正在重连…",
                        Toast.LENGTH_SHORT).show();
            }
        });
        if (firstRun) {
            b.setNegativeButton(getString(R.string.use_default), new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface d, int w) {
                    saveServer(DEFAULT_SERVER);
                    reloadNow();
                }
            });
        } else {
            b.setNegativeButton(getString(R.string.cancel), null);
            b.setNeutralButton(getString(R.string.clear_login), new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface d, int w) {
                    CookieManager cm = CookieManager.getInstance();
                    cm.removeAllCookies(null);
                    cm.removeSessionCookies(null);
                    cm.flush();
                    webView.clearCache(true);
                    webView.clearFormData();
                    Toast.makeText(MainActivity.this, getString(R.string.cleared_login), Toast.LENGTH_SHORT).show();
                    reloadNow();
                }
            });
        }
        AlertDialog dlg = b.create();
        dlg.setCanceledOnTouchOutside(!firstRun);
        dlg.show();
    }

    // ---------------------------------------------------------------- helpers

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    /**
     * 状态栏 / 导航栏跟着页面主题走：页面切夜间模式时会通过桥调 setStatusBar()。
     * 状态栏可见（不隐藏）才能让 App 看起来像原生应用，而不是全屏网页。
     */
    @SuppressWarnings("deprecation")
    private void applySystemBars() {
        Window w = getWindow();
        try {
            w.setStatusBarColor(Color.parseColor(barColor));
            w.setNavigationBarColor(Color.parseColor(barColor));
        } catch (Throwable ignored) { }
        View decor = w.getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (darkIcons) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 26) {
            if (darkIcons) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    private void applyImmersive(boolean on) {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            Immersive30.apply(w, on);
        } else {
            applyLegacyImmersive(w, on);
        }
        if (!on) applySystemBars();
    }

    @SuppressWarnings("deprecation")
    private static void applyLegacyImmersive(Window w, boolean on) {
        View decor = w.getDecorView();
        if (on) {
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } else {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    /** API 30+ path lives in its own class so older ART never has to resolve it. */
    private static final class Immersive30 {
        static void apply(Window w, boolean on) {
            w.setDecorFitsSystemWindows(!on);
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.view.WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    if (on) {
                        c.setSystemBarsBehavior(
                                android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        c.hide(android.view.WindowInsets.Type.statusBars()
                                | android.view.WindowInsets.Type.navigationBars());
                    } else {
                        c.show(android.view.WindowInsets.Type.statusBars()
                                | android.view.WindowInsets.Type.navigationBars());
                    }
                }
            }
        }
    }
}
