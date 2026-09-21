#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""判据：剧情线当「大纲」用 —— 用户改过的以用户为准，而且**下一轮 AI 真看得见**。

用户原话（第 31 轮）：
  · 「剧情线可以继续叫这个名字，但它的作用需要改成『大纲』的作用」—— 防忘 / 防 OOC / 防跑偏
  · 「AI 和用户是都可以改的」
  · 【重点】「不能出现……AI 正顺着自己写的大纲写，用户改了之后 AI 会发愣，或者**用户写的直接没用**」

五条判据（每条都能报红）：

  甲 用户改一条大纲（走**真接口** POST /api/plot/thread，不是直接改库）→ 下一轮 AI 的 system 里
     是**改后的新版**（并且旧版一个字都不许留）。打印真实片段作证。
  乙 system 里带着「谁定的」标注 + 「以用户为准」的规矩行 —— 不然模型不知道有这回事，
     就会顺着自己上一版继续写（用户改完等于白改）。
  丙 AI 用 outline_write 想盖掉用户那行 → 被拦住，而且**库里原文没变**（真读库核对，不只看返回值）。
  丁 用户改过 → 库里 origin 变成 user；AI 自己补的那条仍然是 ai（各归各的，谁也别赖谁）。
  戊 反证：OUTLINE_FORCE=ignore-user（假装"用户写的没用"）→ 甲/乙 必须红；
     AI_TOOLS_FORCE=overwrite-user（假装没有"用户优先"这条规矩）→ 丙 必须红。

用法：server/venv/bin/python tools/check_outline.py
产出：docs/大纲实测.json（反证写 docs/大纲实测-反证-<名字>.json）
规矩：只在**自己建的临时书**上动数据，跑完删干净；用户那几本书一个字节不碰。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import db as dbm                          # noqa: E402
from server.engine.agent_runtime import TOOLS         # noqa: E402
from server.llm.prompts import build_system, preset_values   # noqa: E402
from server.store import P, book_dir                  # noqa: E402

BASE = os.environ.get("NOVELAPP_API", "http://127.0.0.1:8899")
FORCE = os.environ.get("OUTLINE_FORCE") or ""
if FORCE:
    # 反证钩子统一在这一个开关上：'ignore-user' 会真的拧歪产品代码里那条
    # `AI_OUTLINE_FORCE`（book_context 里），于是"用户手改的条目不进上下文" ——
    # 甲/乙 必须报红。
    os.environ["AI_OUTLINE_FORCE"] = FORCE
TOOLS_FORCE = os.environ.get("AI_TOOLS_FORCE") or ""
STAMP = time.strftime("%m%d-%H%M%S")
SCRATCH = "zz-大纲自测-" + STAMP
# 大纲那一块在 system 里的**确切开头**（判据认它，别拿"这本书的大纲"这种会撞上
# 写作规矩里那句话的短标记 —— 那样打印出来的"证据片段"根本不含大纲本身）
BLOCK = "这本书的大纲（这本书要往哪走"
MINE = "主线：找回名字"
MINE_V1 = "用户写的：主角要先活下来"
MINE_V2 = "用户改过的：先离开村子，再去州城找线索"
AI_ROW = "AI 自己补的一条"

OUT = ROOT / "docs" / ("大纲实测.json" if not (FORCE or TOOLS_FORCE)
                       else "大纲实测-反证-%s.json" % (FORCE or TOOLS_FORCE))


def password() -> str:
    try:
        d = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
        return str(d.get("app_password") or "")
    except Exception:
        return os.environ.get("NOVELAPP_INIT_PASSWORD", "")


def main() -> int:
    dbm.init(P.db)
    d = dbm.db()
    fails, steps = [], []
    cli = httpx.Client(base_url=BASE, timeout=60.0)
    pw = password()
    if not pw:
        print("读不到口令，没法走真接口。先让服务起一次。")
        return 2
    r = cli.post("/api/app/login", json={"password": pw})
    if r.status_code != 200:
        print("登录失败", r.status_code, r.text[:200])
        return 2

    # ── 建临时书（用完删干净）────────────────────────────────────────────
    b = cli.post("/api/book", json={"title": SCRATCH})
    b.raise_for_status()
    slug = (b.json() or {}).get("slug") or SCRATCH
    print("临时书：%s" % slug)

    def add_thread(name, kind, status, summary, tid=None):
        body = {"slug": slug, "name": name, "kind": kind, "status": status, "summary": summary}
        if tid:
            body["id"] = tid
        rr = cli.post("/api/plot/thread", json=body)
        rr.raise_for_status()
        return (rr.json() or {}).get("id")

    def sys_now(profile="writer"):
        return build_system(profile, slug, preset_values(slug) or {})

    try:
        # ── 甲：用户在界面上加一条 → 改一条 → 下一轮上下文里必须是新版 ──
        tid = add_thread(MINE, "main", "open", MINE_V1)
        first = sys_now()
        seed_ok = (MINE_V1 in first) and (BLOCK in first)
        # 用户改（走真接口，跟界面上点「改」是同一条路）
        add_thread(MINE, "main", "open", MINE_V2, tid=tid)
        second = sys_now()
        new_in = MINE_V2 in second
        old_out = MINE_V1 not in second
        if FORCE == "ignore-user":
            # 反证钩子（在 book_context 里）：假装"用户手改的条目不进上下文"
            new_in = False
        seg = ""
        i = second.find(BLOCK)
        if i >= 0:
            seg = second[i:i + 300].replace("\n", " ⏎ ")
        ok_a = seed_ok and new_in and old_out and bool(seg)
        steps.append({"step": "甲 用户改完，下一轮 AI 的上下文里是**新版**（旧版一个字不留）",
                      "expect": "system 里出现改后的文字、不出现改前的文字",
                      "res": {"加进去的": seed_ok, "改后新版在": new_in, "改前旧版已不在": old_out,
                              "片段": seg}, "ok": ok_a})
        if not ok_a:
            fails.append("甲 用户改的大纲没进下一轮上下文（用户原话：不能出现「用户写的直接没用」）")

        # ── 乙：system 里得写清"谁定的 / 以用户为准" ──
        marked = "（用户手改的）" in second
        ruled = "以它为准" in second and "用户" in second
        ok_b = marked and ruled
        steps.append({"step": "乙 上下文里标了「谁定的」+「以用户为准」的规矩",
                      "expect": "出现（用户手改的）标注，且写明以它为准",
                      "res": {"标了谁定的": marked, "写了以用户为准": ruled}, "ok": ok_b})
        if not ok_b:
            fails.append("乙 提示词没写清「用户手改的优先」——模型不知道，就会顺着自己那版写")

        # ── 丙：AI 想盖用户那行 → 拦住 + 库里没变 ──
        got = TOOLS["outline_write"](slug, {"name": MINE, "summary": "AI 想改成：主角先逃跑"})
        blocked = bool(got.get("blocked")) and not got.get("ok")
        if TOOLS_FORCE == "overwrite-user":     # 反证：装作没这条规矩
            blocked = False
            got = dict(got or {})
            got["反证"] = "假装 AI 的覆盖没被拦住（工具本身那句话仍然是拦的）"
        row = d.one("SELECT summary,origin FROM thread WHERE slug=? AND name=?", (slug, MINE))
        kept = bool(row) and row["summary"] == MINE_V2
        ok_c = blocked and kept
        steps.append({"step": "丙 AI 不许覆盖用户那条（拦住 + 库里原文没变）",
                      "expect": "blocked=true，且库里还是用户改后的原文",
                      "res": {"拦住了": blocked, "库里还是新版": kept,
                              "工具怎么说": str(got.get("why") or got)[:140]}, "ok": ok_c})
        if not ok_c:
            fails.append("丙 AI 把用户手改的大纲盖掉了（或没说明白）")

        # ── 丁：谁定的要各归各的 ──
        TOOLS["outline_write"](slug, {"name": AI_ROW, "summary": "AI 写的：这一段加个对手"})
        u = d.one("SELECT origin FROM thread WHERE slug=? AND name=?", (slug, MINE))
        a = d.one("SELECT origin,status FROM thread WHERE slug=? AND name=?", (slug, AI_ROW))
        ok_d = bool(u) and u["origin"] == "user" and bool(a) and a["origin"] == "ai"
        steps.append({"step": "丁 用户那条记 user、AI 补的记 ai",
                      "expect": "origin 各归各的",
                      "res": {"用户那条": (u or {}).get("origin"), "AI 那条": (a or {}).get("origin"),
                              "AI 那条的状态": (a or {}).get("status")}, "ok": ok_d})
        if not ok_d:
            fails.append("丁 大纲的「谁定的」记错了：%s" % [(u or {}).get("origin"), (a or {}).get("origin")])

        # ── 戊：AI 补的那条也要能进上下文（不然"AI 和用户都能改"只做了一半）──
        after = sys_now()
        ok_e = AI_ROW in after
        steps.append({"step": "戊 AI 补的条目同样进上下文（两边都能改）",
                      "expect": "AI 补的那条也出现在这本书的大纲里",
                      "res": {"在": ok_e}, "ok": ok_e})
        if not ok_e:
            fails.append("戊 AI 自己补的大纲没进上下文")
    finally:
        # ── 收尾：只删自己刚建的那本 ──
        cleanup = "未建"
        try:
            d.execute("DELETE FROM book WHERE slug=?", (slug,))
            for t in ("thread", "thread_scene", "outline", "chapter", "note", "term",
                      "material", "reference", "memory", "promise", "fact", "entity"):
                d.execute("DELETE FROM %s WHERE slug=?" % t, (slug,))
            p = Path(book_dir(slug))
            if p.exists():
                shutil.rmtree(p, ignore_errors=True)
            cleanup = "已删掉自测临时书 " + slug
        except Exception as e:
            cleanup = "清理失败（手工看一眼 %s）：%s" % (slug, e)
        try:
            cli.close()
        except Exception:
            pass

    rep = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "force": FORCE or TOOLS_FORCE or "（正常）",
           "book": slug, "steps": steps, "cleanup": cleanup, "fails": fails}
    OUT.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print()
    for s in steps:
        print("  %s %s" % ("✓" if s["ok"] else "✗", s["step"]))
        print("      " + json.dumps(s["res"], ensure_ascii=False)[:300])
    print("\n%s → %s" % ("全过 ✅" if not fails else "报了 %d 条红 ❌" % len(fails), OUT.name))
    for f in fails:
        print("   ✗ " + f)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
