package com.nbapp.desk;

import android.webkit.JavascriptInterface;

/**
 * 前端 ↔ 后端的 **JS 桥**（真 App 里那条主路）。
 *
 * 前端是从 APK 的 assets 里加载的（`file:///android_asset/www/index.html`），
 * 它调 `window.NBApp.request(...)` → 这里 → 后端。
 *
 * **后端在哪，这里有两个可能**（用户 2026-09-20 拍板：默认走服务器，见 docs/决策记录 D13）：
 *   1. **服务器上的那份自研后端**（默认，唯一真身）→ 交给 ServerClient 发 HTTP。
 *      为什么要绕 Java 这一道：页面是 file:// 来源、服务器是 http:// 来源，不同源，
 *      前端直接 fetch 会撞跨源那一套（cookie 也不发）。交给 Java 发就没有这回事。
 *   2. 手机里的本机后端（Chaquopy）→ 只在用户**显式打开**「本机离线后端」时才用得上。
 *      这条路 2026-09-20 出过事故：它一起来就接管，而它自己那份数据是**空的** ——
 *      用户看到的是"书没了、设定没了、设置也没了"。所以现在它**默认不启动**。
 *
 * 只有必须走"字节流"的东西（听书音频、封面图、导出下载）才用 URL，
 * 因为 JS 桥是同步返回字符串的，塞不了几个 MB 的音频（见 base()/token()）。
 *
 * 注意：@JavascriptInterface 是安全边界，别在这个类里暴露任何文件/命令能力。
 */
public class ApiBridge {

    /** JSON 信封：{"status":200,"body":"<接口原始返回体>","error":""} */
    @JavascriptInterface
    public String request(String method, String path, String body) {
        // ① 本机离线后端起来了（用户显式开的）→ 进程内直调，断网也能用
        if (MainActivity.localReady()) {
            try {
                com.chaquo.python.PyObject fn = com.chaquo.python.Python.getInstance()
                        .getModule("main");
                return fn.callAttr("bridge", method == null ? "GET" : method,
                        path == null ? "" : path, body == null ? "" : body).toString();
            } catch (Throwable t) {
                // 本机后端半路挂了：**别把界面扔进"连不上"** —— 记一笔，接着走服务器那条路
                MainActivity.noteLocalBridgeFail(t);
            }
        }
        // ② 服务器后端（默认）
        ServerClient sc = MainActivity.server();
        if (sc == null || !sc.hasBackend()) {
            return "{\"status\":0,\"body\":\"\",\"error\":\"还没配置服务器地址（设置 → 服务器设置）\"}";
        }
        try {
            return sc.request(method, path, body);
        } catch (Throwable t) {
            return "{\"status\":0,\"body\":\"\",\"error\":\"" + ServerClient.esc(String.valueOf(t)) + "\"}";
        }
    }

    /** 媒体（音频/封面/下载）用的本机地址前缀；起不来时返回空串，前端会退回事先缓存的资源。 */
    @JavascriptInterface
    public String base() {
        /* **当前真正在用的后端前缀**：本机离线后端起来了就是 127.0.0.1:端口，
           没起来就是服务器地址（路线乙的保底）。前端所有"发得出去的地址"都靠它。
           以前这里只返回本机前缀 —— 本机没起来时是空串，于是 file:// 下的相对路径
           全军覆没（EventSource / 上传 / 封面的老 bug 就是这么来的）。 */
        return MainActivity.effectiveBase();
    }

    /** 媒体请求带的令牌（跨源拿不到 cookie，只能放 URL 上）。 */
    @JavascriptInterface
    public String token() {
        return MainActivity.effectiveToken();
    }

    /**
     * 桥**这会儿能不能干活**（前端据此决定"走桥"还是"走 HTTP"）。
     * 以前前端看的是 localReady() —— 那是"本机 Python 起没起"。
     * 现在默认后端在服务器上，本机 Python 根本不启动，只看 localReady 的话
     * 前端会以为桥没用、于是去发跨源 fetch —— 那条路在 file:// 下是要撞墙的。
     */
    @JavascriptInterface
    public boolean ready() {
        return MainActivity.bridgeReady();
    }

    /**
     * 本机离线后端**这会儿**能不能用（端口已经起来了）。
     *
     * 前端据它决定"走桥"还是"走 HTTP"：
     *   本机好后端 → 桥（进程内直调，不出网卡，断网照用）
     *   其它情况 → 走服务器（见 ready()：那条路**也是走桥**，只是桥的另一头在服务器上）
     * 设置页用它显示"本机离线后端 起没起来"这一行。
     */
    @JavascriptInterface
    public boolean localReady() {
        return MainActivity.localReady();
    }

    /** 看看桥活没活：前端开屏自检用。 */
    @JavascriptInterface
    public String ping() {
        return "{\"ok\":true,\"bridge\":true}";
    }
}
