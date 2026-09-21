package com.nbapp.desk;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 黑匣子：把崩溃和关键步骤都写到手机存储里，用户能看见、能复制。
 *
 * 为什么要它：用户报「一点就闪退 / 一片黄，什么都没有」的时候，
 * logcat 我们是拿不到的（手机在用户手上，我们连不上）。所以 App 必须自己留证据：
 *
 *   files/ondevice.log      关键步骤流水（启动到哪一步了），排"卡住"用
 *   files/crash-<时间>.log  Java 未捕获异常堆栈，排"闪退"用
 *   files/last-crash.txt    最近一次崩溃的摘要；**下次启动弹一个能复制/分享的页面**
 *
 * 全部写在 App 私有目录里（Android/data/com.nbapp.desk/files/），不申请任何存储权限。
 */
public final class CrashLog {

    private CrashLog() { }

    private static File dir(Context c) {
        File d = c.getFilesDir();
        if (!d.exists()) d.mkdirs();
        return d;
    }

    public static File logFile(Context c) { return new File(dir(c), "ondevice.log"); }
    public static File lastCrashFile(Context c) { return new File(dir(c), "last-crash.txt"); }

    private static void append(Context c, File f, String text) {
        FileOutputStream fos = null;
        try {
            fos = new FileOutputStream(f, true);
            fos.write(text.getBytes(StandardCharsets.UTF_8));
            fos.flush();
        } catch (Throwable ignored) {
        } finally {
            if (fos != null) { try { fos.close(); } catch (Throwable ignored) { } }
        }
    }

    private static String stamp() {
        return new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
    }

    /** 关键步骤流水（哪一步到了、哪一步没到 —— 排「卡在黄屏」全靠这个）。 */
    public static void step(Context c, String msg) {
        try {
            android.util.Log.i("novelapp", msg);
        } catch (Throwable ignored) { }
        if (c == null) return;
        append(c, logFile(c), stamp() + "  " + msg + "\n");
    }

    /** 非致命异常也记一笔（不崩，但要知道发生过）。 */
    public static void warn(Context c, String where, Throwable t) {
        try {
            android.util.Log.w("novelapp", where + "：" + t);
        } catch (Throwable ignored) { }
        if (c == null) return;
        append(c, logFile(c), stamp() + "  ! " + where + "：" + t + "\n");
    }

    /**
     * 装全局未捕获异常处理器。
     * 崩了先把堆栈落盘（下一个启动能读到），再交回系统原本的处理器 —— 不能把系统流程吞掉，
     * 否则表现成"点一下没反应"，比直接崩还难查。
     *
     * 注意：这条**兜不住** native 崩溃（.so 里段错误）和 Application.onCreate 里更早的异常，
     * 所以那两类由打包校验 + 启动步骤日志兜底。
     */
    public static void install(final Context ctx) {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread th, Throwable ex) {
                try {
                    StringWriter sw = new StringWriter();
                    PrintWriter pw = new PrintWriter(sw);
                    pw.println("时间：" + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()));
                    pw.println("线程：" + (th == null ? "?" : th.getName()));
                    pw.println("机型：Build.MANUFACTURER " + Build.MANUFACTURER);
                    pw.println("      Build.MODEL        " + Build.MODEL);
                    pw.println("      Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
                    pw.println("      ABI " + android.os.Build.SUPPORTED_ABIS[0]);
                    pw.println("App   " + ctx.getPackageName() + "  版本 " + versionOf(ctx));
                    pw.println();
                    ex.printStackTrace(pw);
                    String text = sw.toString();
                    String name = "crash-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".log";
                    File f = new File(dir(ctx), name);
                    FileOutputStream fos = new FileOutputStream(f, false);
                    fos.write(text.getBytes(StandardCharsets.UTF_8));
                    fos.flush();
                    fos.close();
                    // 只留最近 5 份，别把用户手机塞满
                    File[] all = dir(ctx).listFiles();
                    if (all != null) {
                        int n = 0;
                        for (File x : all) if (x.getName().startsWith("crash-")) n++;
                        if (n > 5) {
                            java.util.Arrays.sort(all, new java.util.Comparator<File>() {
                                @Override public int compare(File a, File b) { return a.getName().compareTo(b.getName()); }
                            });
                            for (File x : all) {
                                if (n <= 5) break;
                                if (x.getName().startsWith("crash-")) { x.delete(); n--; }
                            }
                        }
                    }
                    // 摘一段给"下次启动"用（首行 + 异常类名 + 前几行堆栈）
                    StringBuilder brief = new StringBuilder();
                    brief.append(text.length() > 4000 ? text.substring(0, 4000) : text);
                    File lc = lastCrashFile(ctx);
                    FileOutputStream f2 = new FileOutputStream(lc, false);
                    f2.write(brief.toString().getBytes(StandardCharsets.UTF_8));
                    f2.flush();
                    f2.close();
                    append(ctx, logFile(ctx), stamp() + "  ✗ 未捕获异常，已写 " + name + "\n");
                } catch (Throwable ignored) { }
                if (prev != null) prev.uncaughtException(th, ex);
            }
        });
    }

    private static String versionOf(Context ctx) {
        try {
            android.content.pm.PackageInfo pi = ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0);
            return pi.versionName + "/" + (Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
        } catch (Throwable t) {
            return "?";
        }
    }

    /** 上次是不是崩过？崩过就把摘要读出来（读完删掉，别每次都弹）。 */
    public static String takeLastCrash(Context ctx) {
        try {
            File f = lastCrashFile(ctx);
            if (!f.exists()) return "";
            byte[] buf = new byte[(int) f.length()];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            int off = 0, r;
            while (off < buf.length && (r = in.read(buf, off, buf.length - off)) > 0) off += r;
            in.close();
            f.delete();
            return new String(buf, 0, off, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return "";
        }
    }
}
