#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为「后端装进 App」准备离线 wheel 仓库（`apk/libs/`）。

为什么要这一步：手机上跑 Python 用的是 Chaquopy 的嵌入式解释器（Android ABI），
x86_64 的普通 wheel 装不上。所以这里分两路取包：

1. **纯 Python 包** —— 从 PyPI 取 `py3-none-any` wheel（任何平台都能用）；
   `pydantic` 特意用 **1.10.x 的纯 Python 版**（2.x 依赖编译出来的 pydantic_core，Android 上装不了；
   FastAPI 同时支持 pydantic 1 和 2，所以降一版换「能在手机上跑」）。
   `pydantic` 的 sdist 只有在装了 Cython 时才会编译扩展，这里用 `SKIP_CYTHON=1` 打出纯 Python wheel。
2. **带 C 扩展的包** —— 从 Chaquopy 的 Android 包索引取 cp312 / android_24_{arm64_v8a,armeabi_v7a,x86_64} 的 wheel。

跑法：`server/venv/bin/python tools/make_apk_libs.py`
产出：`apk/libs/*.whl`（这些文件不进 git，用脚本随时重建）
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIBS = ROOT / "apk" / "libs"
PY = str(ROOT / "server" / "venv" / "bin" / "python")

# 目标 Python 版本：**必须是 3.11**（第 9 遍打磨定的）。
# 原因：Chaquopy 的 Android wheel 索引里，带 C 扩展的包（aiohttp/multidict/yarl/frozenlist）
# **没有 cp312 的 armeabi_v7a（32 位 ARM）轮子**，只有到 cp311 为止。
# 我们要支持 32 位手机，就只能跟着降到 3.11；降这一版对服务器代码没有影响
# （全仓库用 3.11 编译过一遍，0 个文件不过）。
PY_VER = "3.11"
CHAQUO_INDEX = "https://chaquo.com/pypi-13.1/"
# 目标 ABI：
#   arm64_v8a   现代安卓手机（主流）
#   armeabi_v7a 32 位老机器/廉价机（用户实测"装不上"就是缺这个 —— 第 9 遍打磨补的）
#   x86_64      模拟器/少数平板
ARCHS = ("arm64_v8a", "armeabi_v7a", "x86_64")

PURE = [  # 纯 Python，直接取 PyPI 的 py3-none-any
    "fastapi==0.115.6", "starlette==0.41.3", "uvicorn==0.32.1", "click==8.1.7",
    "h11==0.14.0", "httpx==0.28.1", "httpcore==1.0.7", "anyio==4.7.0",
    "sniffio==1.3.1", "idna==3.10", "certifi==2024.8.30",
    "typing_extensions==4.12.2", "python-multipart==0.0.20", "edge-tts==7.2.8",
    "tabulate==0.9.0", "attrs==24.2.0", "aiosignal==1.3.1", "async-timeout==4.0.3",
]
# aiohttp 固定在 3.9.1：3.10+ 多一个 propcache 依赖，而 Chaquopy 索引里没有它的 Android wheel。
# 3.9.1 的依赖（multidict / yarl / frozenlist / attrs / aiosignal / async-timeout）索引里都有。
# 版本号全部**钉死**：不同 ABI 上可用的版本不一样，不钉死就会挑到"某个 ABI 没有"的那版，
# 表现是构建时某个 ABI 少一个包（32 位机器上前端能用、听书炸）。
# multidict 钉 5.1.0：6.x 在这个索引里没有 cp311 轮子（4 个 ABI 全缺）。
NATIVE = ["aiohttp==3.9.1", "multidict==5.1.0", "yarl==1.9.3", "frozenlist==1.4.0"]
# 自己在本机打出来的纯 Python wheel（PyPI 上没有 py3-none-any 的版本）
LOCAL_PURE = ["pydantic==1.10.18"]


def run(cmd: list[str], **kw) -> None:
    print("  $", " ".join(cmd[:6]), ("…" if len(cmd) > 6 else ""))
    subprocess.run(cmd, check=True, **kw)


def fetch_pure() -> None:
    print("· 纯 Python 包（PyPI）")
    run([PY, "-m", "pip", "download", "-q", "-d", str(LIBS), "--python-version", PY_VER,
         "--only-binary=:all:", "--no-deps", *PURE])
    # pydantic 1.10 的纯 Python 版：SKIP_CYTHON=1 时它的 setup.py 才不编译扩展
    env = {**os.environ, "SKIP_CYTHON": "1"}
    run([PY, "-m", "pip", "wheel", "-q", "-w", str(LIBS), "--no-deps",
         "--no-binary", ":all:", "pydantic==1.10.18"], env=env)
    prune()


UA = {"User-Agent": "Mozilla/5.0 (novelapp apk build)"}   # 不带 UA（或自造 UA）这个索引站回 404


def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def listing(pkg: str) -> list[str]:
    html = _get(CHAQUO_INDEX + pkg + "/", timeout=30).decode("utf-8", "ignore")
    return re.findall(r'href="([^"]+\.whl)"', html)


def _canon(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def _abi_of(fname: str) -> str:
    """这个 wheel 是给哪个 ABI 的：纯 Python 算 any，其余取 android_ 后面那段。"""
    if "py3-none-any" in fname:
        return "any"
    m = re.search(r"android_[0-9]+_([a-z0-9_]+)\.whl$", fname)
    return m.group(1) if m else "other"


def prune() -> None:
    """把 libs 收拾成"一套"：清单里点名的包、每个（包, ABI）只留一个版本。

    为什么必须收拾：多版本并存时 pip 会挑"最新"的那个，而新版本常常多出
    Android 上装不了的依赖（比如 aiohttp 3.10 要 propcache）。留一份干净的清单，
    构建结果才是可复现的。
    """
    allowed = {_canon(p.split("==")[0]): (p.split("==")[1] if "==" in p else None)
               for p in PURE + NATIVE + LOCAL_PURE}
    best: dict[tuple, pathlib.Path] = {}
    drop: list[tuple] = []
    for f in sorted(LIBS.glob("*.whl")):
        pkg = _canon(f.name.split("-")[0])
        if pkg not in allowed:
            drop.append((f, "不在清单里"))
            continue
        want = allowed[pkg]
        if want and f.name.split("-")[1] != want:
            drop.append((f, f"版本不是要的 {want}"))
            continue
        if _abi_of(f.name) == "other":
            drop.append((f, "不是 Android/纯 Python wheel"))
            continue
        key = (pkg, _abi_of(f.name))
        prev = best.get(key)
        if prev is None:
            best[key] = f
            continue
        keep, lose = (f, prev) if ver_key(f.name) > ver_key(prev.name) else (prev, f)
        best[key] = keep
        drop.append((lose, "同一包的旧版本"))
    for f, why in drop:
        print(f"  收拾掉 {f.name}（{why}）")
        if f.exists():
            f.unlink()


def ver_key(name: str) -> tuple:
    m = re.search(r"-([0-9][^-]*)-", name)
    ver = m.group(1) if m else "0"
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.+]", ver))


def fetch_native() -> None:
    print("· 带 C 扩展的包（Chaquopy Android 索引）")
    for pkg in NATIVE:
        name = pkg.split("==")[0]
        files = listing(name)
        for arch in ARCHS:
            cptag = "cp" + PY_VER.replace(".", "")
            cands = [f for f in files if cptag in f and f.endswith(arch + ".whl")]
            if "==" in pkg:                    # 钉了版本就只认那一版
                cands = [f for f in cands if f.startswith(name + "-" + pkg.split("==")[1] + "-")]
            if not cands:
                print(f"  ! {pkg} 没有 cp312/{arch} 的 wheel")
                continue
            pick = sorted(cands, key=ver_key)[-1]
            dst = LIBS / pick
            if dst.exists():
                print(f"  = {pick}")
                continue
            dst.write_bytes(_get(CHAQUO_INDEX + name + "/" + pick, timeout=180))
            print(f"  + {pick} ({dst.stat().st_size // 1024} KB)")


def main() -> int:
    LIBS.mkdir(parents=True, exist_ok=True)
    fetch_pure()
    fetch_native()
    prune()
    wheels = sorted(p.name for p in LIBS.glob("*.whl"))
    print(f"\napk/libs 共 {len(wheels)} 个 wheel：")
    for w in wheels:
        print("   ", w)
    (LIBS / "INDEX.txt").write_text("\n".join(wheels) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
