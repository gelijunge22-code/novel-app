#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""预设实测：选了「文风 / 参考写法」之后，AI 到底看没看到那篇范文。

以前 `build_system` 把资源 key（`克制白描.md`）当内容拼进提示词 —— 选了等于没选。
这个脚本真改一次预设、真去 `GET /api/write/context` 把喂给模型的东西拿出来看，
确认范文正文在里面；跑完把书级预设删回原样、把自测复制进去的资源文件也清掉。

产出：docs/预设注入实测.json
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
BOOK = "example-book"
CH = "manuscript/第001章-荒原雪夜.md"
STYLE = "克制白描.md"
REF = "第一人称.md"

results: list[dict] = []


def check(name: str, ok: bool, extra: str = "") -> None:
    results.append({"name": name, "ok": bool(ok), "extra": extra})
    print(("  ✓ " if ok else "  ✗ ") + name + (("  " + extra) if extra else ""))


def password() -> str:
    d = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
    return str(d["app_password"])


def main() -> int:
    cli = httpx.Client(base_url=BASE, timeout=60)
    cli.post("/api/app/login", json={"password": password()})
    book_preset_dir = ROOT / "data" / "books" / BOOK / "agents" / "writer"
    made: list[Path] = []

    # 先看起点：这本书有没有自己的预设
    before = cli.get("/api/presets", params={"scope": "book", "slug": BOOK}).json()
    check("起始能读到书级预设", isinstance(before.get("profiles"), list))

    # 文风 / 参考写法的选项里有没有内置范文（中文文件名）
    fields = before["profiles"][0]["fields"]
    f_style = next(f for f in fields if f["path"] == "writingStylePreset")
    f_ref = next(f for f in fields if f["path"] == "writingReferencePreset")
    opt_keys = [o["value"] for o in f_style["options"]]
    check("文风选项里有内置范文", STYLE in opt_keys, str(opt_keys))
    check("参考写法选项里有内置范文", REF in [o["value"] for o in f_ref["options"]])

    # 预览接口：中文文件名要能原样取回正文
    r = cli.get("/api/presets/resource", params={"profileKey": "writer", "path": "writingStylePreset",
                                                 "key": STYLE, "scope": "book", "slug": BOOK})
    check("预览接口能取到中文范文", r.status_code == 200 and len(r.json().get("content") or "") > 30,
          "status=%s" % r.status_code)
    r404 = cli.get("/api/presets/resource", params={"profileKey": "writer", "path": "writingStylePreset",
                                                    "key": "没有这条.md"})
    check("预览不存在的资源 → 404 且说人话",
          r404.status_code == 404 and "没找到" in json.dumps(r404.json(), ensure_ascii=False))

    # 改书级预设：选上文风 + 参考写法
    vals = dict((before["profiles"][0].get("values") or {}))
    vals["writingStylePreset"] = STYLE
    vals["writingReferencePreset"] = REF
    saved = cli.post("/api/presets/save", json={"profileKey": "writer", "values": vals,
                                               "model": before["profiles"][0].get("model") or {},
                                               "scope": "book", "slug": BOOK})
    check("保存书级预设", saved.status_code == 200, str(saved.text)[:120])

    # 资源应该被复制进书里（老平台行为）—— 记下来待会儿清理
    for rel in ("styles/" + STYLE, "references/" + REF):
        f = book_preset_dir / rel
        if f.exists():
            made.append(f)

    # 关键：喂给模型的东西里得有范文正文
    ctx = cli.get("/api/write/context", params={"slug": BOOK, "path": CH, "mode": "continue"})
    check("写作上下文接口 200", ctx.status_code == 200, "status=%s" % ctx.status_code)
    system = json.dumps(ctx.json(), ensure_ascii=False)
    check("文风范文正文真的进了提示词", "动词优先" in system or "克制白描" in system
          and "形容词" in system)
    check("参考写法范文正文真的进了提示词", "三十七级" in system or "台阶" in system,
          "命中前 80 字：" + system[system.find("参考写法"):][:120])

    # 书里那份优先：改掉书里的副本，提示词要跟着变
    local = book_preset_dir / "styles" / STYLE
    if local.exists():
        old = local.read_text("utf-8")
        local.write_text(old + "\n\n【自测标记】这一行只应该出现在自测里。\n", encoding="utf-8")
        ctx2 = cli.get("/api/write/context", params={"slug": BOOK, "path": CH, "mode": "continue"})
        check("书里自己改过的那份优先（提示词跟着变）", "【自测标记】" in
              json.dumps(ctx2.json(), ensure_ascii=False))
        local.write_text(old, encoding="utf-8")

    # 收拾干净：书级预设删回原样（reset 会先备份），自测复制进来的资源文件删掉
    reset = cli.post("/api/presets/reset", json={"scope": "book", "slug": BOOK})
    check("收尾：书级预设删回原样", reset.status_code == 200, str(reset.text)[:100])
    after = cli.get("/api/presets", params={"scope": "book", "slug": BOOK}).json()
    check("收尾：值回到默认（没选文风）",
          not (after["profiles"][0].get("values") or {}).get("writingStylePreset"))
    for f in made:
        try:
            f.unlink()
        except Exception:
            pass
    check("收尾：自测复制进书里的资源文件已删", all(not f.exists() for f in made))

    rep = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "book": BOOK,
           "total": len(results), "passed": sum(1 for r in results if r["ok"]),
           "failed": sum(1 for r in results if not r["ok"]), "items": results}
    out = ROOT / "docs" / "预设注入实测.json"
    out.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n合计 %d：通过 %d，失败 %d → %s" % (rep["total"], rep["passed"], rep["failed"], out))
    return 0 if rep["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
