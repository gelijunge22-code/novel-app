#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 frontend/ 与 server/ 同步进 apk 的打包目录 —— **唯一出处**。

为什么把它单独拿出来（第 9 遍打磨）：
  · `apk/build.sh` 里原本有两段内联 python 干这件事，而 `tools/verify_peer_sync.py`
    起"对端服务器"时用的是**包内那份副本**（apk/src/main/python/server）。两边各写一份，
    就会出这种事：改了 `server/store.py` 只跑测试不打包 → 对端跑的还是旧代码 →
    测出来的现象（"同一本书同一章两边内容不同 → 冲突"）跟你的改动对不上，白排查半小时。
  · 现在两边都调这个文件：打包用 `python3 tools/sync_pkg.py`，测试前也调它刷新副本。

用法：
    python3 tools/sync_pkg.py            # 前后端都同步
    python3 tools/sync_pkg.py --backend  # 只同步后端
"""
from __future__ import annotations

import argparse
import filecmp
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PROJ = REPO / "apk"


def _sync(src: Path, dst: Path, skip_dirs=(), skip_files=()) -> int:
    """逐字节比，变了才拷；dst 里多的删掉（删源文件后包里不该留着旧件）。"""
    dst.mkdir(parents=True, exist_ok=True)
    keep = set()
    for f in sorted(src.iterdir()):
        if f.is_dir():
            if f.name in skip_dirs:
                continue
            _sync(f, dst / f.name, skip_dirs, skip_files)
            continue
        if f.name in skip_files or f.name.endswith((".pyc", ".log")):
            continue
        keep.add(f.name)
        t = dst / f.name
        if not t.exists() or not filecmp.cmp(f, t, shallow=False):
            shutil.copy2(f, t)
    for f in dst.iterdir():
        if f.is_file() and f.name not in keep:
            f.unlink()
    return len(keep)


def sync_frontend() -> int:
    n = _sync(REPO / "frontend", PROJ / "assets" / "www")
    print(f"   前端同步完（与 frontend/ 逐字节一致）")
    return n


def sync_backend() -> int:
    n = _sync(REPO / "server", PROJ / "src" / "main" / "python" / "server",
              skip_dirs={"venv", "__pycache__", ".pytest_cache"},
              skip_files={"config.json"})
    print("   后端源码同步完（venv / config.json 不进包）")
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", action="store_true", help="只同步后端（测试前刷新包内副本用）")
    a = ap.parse_args()
    if not a.backend:
        sync_frontend()
    sync_backend()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
