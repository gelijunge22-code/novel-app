#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反证：verify_apk.sh 第 6 节（真机上才会暴露的坑）那批断言，是不是"空判据"。

做法：拿 verify_apk.sh 落下来的清单/dex 现实输出当"好输入"，
再逐条造一份"坏输入"（把那一项抠掉），确认：
  好输入 → 绿；坏输入 → 红。两者都成立，断言才算真的挡住了东西。

跑法：bash tools/verify_apk.sh >/dev/null && python3 tools/反证_真机断言.py
"""
import re
import sys
import pathlib

man = pathlib.Path("/tmp/apk-manifest.txt").read_text(encoding="utf-8", errors="replace")
dex = pathlib.Path("/tmp/apk-dex-check.txt").read_text(encoding="utf-8", errors="replace")

# (名字, 把好输入改坏, 该条断言在 verify_apk.sh 里的判据)
CASES = [
    # 2026-09-20 转向之后这条断言是**反向**的：清单里**不该**有 PyApplication
    # （有它 = Python 起不来会直接带走 App 启动 = 用户报的"一点就闪退"）。
    # 所以"坏输入" = 把 PyApplication 塞回 application，判据是"grep 不到它"。
    ("清单又把 PyApplication 设成应用类（闪退风险）",
     lambda m, d: (m.replace('android:name(0x01010003)="com.nbapp.desk.MainActivity"',
                             'android:name(0x01010003)="com.chaquo.python.PyApplication"', 1), d),
     lambda m, d: re.search(r'android:name\(0x01010003\)="com\.chaquo\.python\.PyApplication"', m) is None),
    ("dex 里没有 CrashLog 类",
     lambda m, d: (m, d.replace("CrashLog ", "XXCrashLog ")),
     lambda m, d: re.search(r"^CrashLog [1-9]", d, re.M) is not None),
    ("dex 里没有 setDefaultUncaughtExceptionHandler",
     lambda m, d: (m, d.replace("setDefaultUncaughtExceptionHandler ", "XXsetDefaultUncaughtExceptionHandler ")),
     lambda m, d: re.search(r"^setDefaultUncaughtExceptionHandler [1-9]", d, re.M) is not None),
    ("dex 里没有 retryLocal",
     lambda m, d: (m, d.replace("retryLocal ", "XXretryLocal ")),
     lambda m, d: re.search(r"^retryLocal [1-9]", d, re.M) is not None),
    ("dex 里没有 PyApplication",
     lambda m, d: (m, d.replace("PyApplication 3", "PyApplication 0")),
     lambda m, d: re.search(r"^PyApplication [1-9]", d, re.M) is not None),
    ("dex 里没有 AndroidPlatform",
     lambda m, d: (m, d.replace("AndroidPlatform 3", "AndroidPlatform 0")),
     lambda m, d: re.search(r"^AndroidPlatform [1-9]", d, re.M) is not None),
    ("清单没有 usesCleartextTraffic",
     lambda m, d: (m.replace("usesCleartextTraffic", "XXX"), d),
     lambda m, d: "usesCleartextTraffic" in m),
    ("清单没有 INTERNET 权限",
     lambda m, d: (m.replace('"android.permission.INTERNET"', '"android.permission.XXX"'), d),
     lambda m, d: "INTERNET" in m),
    ("清单没有 FOREGROUND_SERVICE_DATA_SYNC",
     lambda m, d: (m.replace("FOREGROUND_SERVICE_DATA_SYNC", "FOREGROUND_SERVICE"), d),
     lambda m, d: "FOREGROUND_SERVICE_DATA_SYNC" in m),
    ("清单没有 POST_NOTIFICATIONS",
     lambda m, d: (m.replace("POST_NOTIFICATIONS", "XXX"), d),
     lambda m, d: "POST_NOTIFICATIONS" in m),
    ("清单没有 REQUEST_INSTALL_PACKAGES",
     lambda m, d: (m.replace("REQUEST_INSTALL_PACKAGES", "XXX"), d),
     lambda m, d: "REQUEST_INSTALL_PACKAGES" in m),
]


def main() -> int:
    if not man.strip() or not dex.strip():
        print("先跑一遍 bash tools/verify_apk.sh（它会落盘 /tmp/apk-manifest.txt 和 /tmp/apk-dex-check.txt）")
        return 2
    bad = 0
    for name, mutate, check in CASES:
        m2, d2 = mutate(man, dex)
        good, broken = check(man, dex), check(m2, d2)
        if good and not broken:
            print(f"  ✓ 断言有效（好输入绿 / 坏输入红）  · {name}")
        else:
            bad += 1
            print(f"  ✗ 这条判据是空的！  · {name}（好输入={good} 坏输入={broken}）")
    print()
    print(f"反证结果：{len(CASES) - bad}/{len(CASES)} 条断言真的在挡东西"
          + (" ✅" if not bad else " ❌"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
