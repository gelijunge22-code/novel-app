package com.nbapp.desk;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * 服务器后端的 HTTP 客户端。
 *
 * 为什么有这么个东西：用户拍板「App 只做前端壳，后端在服务器上跑」（2026-09-20，见
 * docs/决策记录 D13）。前端是**内嵌在安装包里**的（assets/www），打开是秒开、不是加载网页；
 * 但数据得从服务器拿 —— 页面是 file:// 来源、服务器是 http://来源，两边不同源，
 * 直接 fetch 会撞跨源那一套（cookie 也不发）。
 *
 * 所以数据这条路走**安卓的 JS 桥**：前端把请求交给 Java，Java 代它去请求服务器，
 * 会话 cookie 由 Java 拿着（前端看不见、也不需要在 URL 里裸奔）。
 * 好处：① 没有跨源问题；② 前端那份 api.js 一行都不用改（桥那条路本来就在）；
 * ③ 断网/服务器挂了能拿到一个**确切**的错误，而不是让界面去猜。
 *
 * ⚠️ 这个类**不许 import 任何 android.* 的东西** —— 它要能在桌面上用 javac/java 直接跑单测
 * （tools/java/ServerClientTest.java）。真机上那些"只有插上手机才暴露"的坑，
 * 能提前在桌面上证明的，就提前证明掉。
 */
public class ServerClient {

    /** 日志出口：安卓端写进 ondevice.log，桌面单测写 stdout。 */
    public interface Log { void line(String s); }

    /** 一次调用的结果。 */
    public static class Env {
        public int status;          // HTTP 状态码；0 = 压根没连上
        public String body = "";    // 原始返回体（字符串）
        public String error = "";   // 连不上时的原因（人话）
    }

    private volatile String base = "";
    private volatile String token = "";
    private volatile String lastError = "";
    private final Log log;
    private String ua = "novelapp-android";

    public ServerClient(Log log) { this.log = log; }

    private void logLine(String s) { if (log != null) { try { log.line(s); } catch (Throwable ignored) { } } }

    public void setUserAgent(String v) { if (v != null && v.length() > 0) ua = v; }

    public void setBase(String raw) {
        this.base = normalizeBase(raw);
        logLine("[server] 后端地址：" + this.base);
    }

    public String base() { return base; }

    /** 会话口令：登录时从 Set-Cookie 里抠出来的。媒体/SSE 的 URL 上要带它。 */
    public String token() { return token; }

    public String lastError() { return lastError; }

    public boolean hasBackend() { return base != null && base.length() > 0; }

    /** 地址规整：补 scheme、补结尾斜杠。空串 = 没配（那就什么都干不了）。 */
    public static String normalizeBase(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.length() == 0) return "";
        if (!u.matches("(?i)^[a-z][a-z0-9+.\\-]*://.*")) u = "http://" + u;
        if (u.indexOf('?') < 0 && u.indexOf('#') < 0 && !u.endsWith("/")) u = u + "/";
        return u;
    }

    /** 健康探测：能连上就返回状态码，连不上返回 0。启动时用它决定"报不报连不上"。 */
    public int health() {
        Env e = call("GET", "api/health", null, 4000, 8000);
        return e.status;
    }

    /**
     * 桥的入口。返回 {"status":n,"body":"<原始返回体>","error":"<连不上时的原因>"}。
     * 前端拿到之后按 fetch 的语义解释（见 frontend/js/api.js 的 bridgeCall）。
     */
    public String request(String method, String path, String bodyJson) {
        Env e = call(method, path, bodyJson, 6000, 60000);
        /* 退出登录：服务器只把会话作废，**不会**回一个清 cookie 的头（它也不需要回）。
           那本地这份口令就得自己收掉 —— 否则退完还揣着一串已经作废的口令到处发，
           表现是"点了退出，下一屏还是 401 弹登录"，看着像没退干净。 */
        String p2 = path == null ? "" : path;
        if (e.status == 200 && p2.indexOf("app/logout") >= 0 && token.length() > 0) {
            token = "";
            logLine("[server] 退出登录 → 本地会话口令已清掉");
        }
        StringBuilder sb = new StringBuilder(64 + e.body.length());
        sb.append("{\"status\":").append(e.status)
          .append(",\"body\":\"").append(esc(e.body)).append("\"")
          .append(",\"error\":\"").append(esc(e.error)).append("\"}");
        return sb.toString();
    }

    /** 真正干活的那个。任何异常都收成 {status:0, error:"人话"}，绝不往外抛。 */
    public Env call(String method, String path, String body, int connectMs, int readMs) {
        Env e = new Env();
        if (!hasBackend()) {
            e.error = "还没配置服务器地址";
            lastError = e.error;
            return e;
        }
        String m = (method == null || method.length() == 0) ? "GET" : method.toUpperCase();
        String url = url(path);
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            c.setRequestMethod(m);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("Accept", "application/json, */*");
            c.setRequestProperty("User-Agent", ua);
            if (token.length() > 0) {
                c.setRequestProperty("Cookie", "nbauth=" + token);
                c.setRequestProperty("X-Token", token);
            }
            boolean sends = body != null && (m.equals("POST") || m.equals("PUT") || m.equals("PATCH")
                    || m.equals("DELETE"));
            if (sends) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] raw = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(raw.length);
                OutputStream os = c.getOutputStream();
                os.write(raw);
                os.flush();
                os.close();
            }
            int code = c.getResponseCode();
            e.status = code;
            e.body = read(code >= 400 ? c.getErrorStream() : c.getInputStream());
            absorbCookies(c);
            if (code >= 400) lastError = "HTTP " + code; else lastError = "";
            logLine("[server] " + m + " " + url + " → " + code + "（" + e.body.length() + " 字节）");
        } catch (Throwable t) {
            e.status = 0;
            e.error = speak(t, url);
            lastError = e.error;
            logLine("[server] " + m + " " + url + " → 没连上：" + e.error);
        } finally {
            if (c != null) { try { c.disconnect(); } catch (Throwable ignored) { } }
        }
        return e;
    }

    /** 把 java 的异常翻译成一句用户看得懂的话。 */
    private static String speak(Throwable t, String url) {
        String n = t.getClass().getSimpleName();
        String msg = t.getMessage() == null ? "" : t.getMessage();
        if (n.contains("UnknownHost")) return "连不上服务器（域名解析不了）：" + host(url);
        if (n.contains("Connect")) return "连不上服务器（网络不通）：" + host(url);
        if (n.contains("SocketTimeout") || n.contains("Timeout")) return "服务器没回应（超时）：" + host(url);
        if (n.contains("SSL") || n.contains("Cert")) return "HTTPS 证书有问题：" + host(url);
        return "连不上服务器（" + n + (msg.length() > 0 ? "：" + msg : "") + "）";
    }

    private static String host(String url) {
        try { return new URL(url).getHost(); } catch (Throwable t) { return url; }
    }

    private String url(String path) {
        String p = path == null ? "" : path;
        while (p.startsWith("/")) p = p.substring(1);
        return base + p;
    }

    /** 从 Set-Cookie 里把会话口令抠出来（登录时下发，退出登录时清掉）。 */
    private void absorbCookies(HttpURLConnection c) {
        try {
            Map<String, List<String>> hs = c.getHeaderFields();
            if (hs == null) return;
            for (Map.Entry<String, List<String>> en : hs.entrySet()) {
                String k = en.getKey();
                if (k == null || !k.equalsIgnoreCase("Set-Cookie")) continue;
                for (String v : en.getValue()) {
                    if (v == null) continue;
                    int semi = v.indexOf(';');
                    String pair = (semi < 0 ? v : v.substring(0, semi)).trim();
                    int eq = pair.indexOf('=');
                    if (eq <= 0) continue;
                    String name = pair.substring(0, eq).trim();
                    String val = pair.substring(eq + 1).trim();
                    if (!name.equals("nbauth")) continue;
                    boolean dead = val.length() == 0 || v.toLowerCase().contains("max-age=0");
                    if (dead) {
                        if (token.length() > 0) { token = ""; logLine("[server] 会话口令已清掉"); }
                    } else if (!val.equals(token)) {
                        token = val;
                        logLine("[server] 拿到会话口令（" + val.length() + " 字符）");
                    }
                }
            }
        } catch (Throwable t) {
            logLine("[server] Set-Cookie 没解析出来：" + t);
        }
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 最小 JSON 字符串转义（信封是手拼的，必须转义干净，否则前端 JSON.parse 会炸）。 */
    public static String esc(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
                    else sb.append(ch);
            }
        }
        return sb.toString();
    }
}
