#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 APK 里抠出 classes.dex，查几个关键类/方法名在不在（verifier 用）。

为什么不用 dexdump -f：那个只打文件头，不打方法名 —— 会把「有」看成「没有」。

2026-09-20 补：加上 Chaquopy 运行时初始化的两条。
用户实机报「本机服务没起来 · java.lang.RuntimeException: Cannot use GenericPlatform on Android」，
根因是 `Python.getInstance()` 之前没有用 `AndroidPlatform` 启动过运行时。
这类坑**打出来是好的、装上才炸**，所以必须由打包校验挡住：
  - PyApplication   ：清单里 application 指的那个类（唯一自动初始化点）
  - AndroidPlatform ：MainActivity.startLocalBackend() 里的手动保险
"""
import sys
import zipfile

# 顺序和 verify_apk.sh 里的断言一一对应，别随便调。
KEYWORDS = (
    b"AndroidBack", b"share", b"downloadApk", b"setStatusBar", b"changePassword",
    b"keepAlive", b"KeepAliveService",
    # JS 桥（真 App 的主路：前端 → @JavascriptInterface → 进程内后端）
    b"ApiBridge", b"JavascriptInterface", b"NBApp",
    b"file:///android_asset/www/index.html", b"addJavascriptInterface",
    # Python 运行时初始化（漏了就"App 打不开"）
    b"PyApplication", b"AndroidPlatform",
    # 黑匣子（实机崩了，这是唯一取证手段）
    b"CrashLog", b"setDefaultUncaughtExceptionHandler", b"takeLastCrash",
    # 后端状态 / 重试（手机上用户唯一能自救的入口）
    b"localStatus", b"retryLocal", b"localReady",
)


def main() -> int:
    apk = sys.argv[1]
    d = zipfile.ZipFile(apk).read("classes.dex")
    print("classes.dex %d bytes" % len(d))
    for kw in KEYWORDS:
        print("%s %d" % (kw.decode(), d.count(kw)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
