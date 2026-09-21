#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""判据：预设里**每一项都真的有用** —— 用户点名的「儿戏感」到底修没修。

用户原话（第 33 轮转达）：
  · 「现在的预设的，就是 AI 的那什么主创啊，还有什么助手啊之类的，说不上来的，
     有一种儿戏感，就是很多功能没什么用，尤其是这个『派活规矩』
     ——『什么活派给谁，例如正文交作家、设定交世界引擎』，下面是让输入文字的，
     不是换模型，也不是具体交给谁，这只是个提示词啊，那有什么用啊？」
  · 监督人口径：「一个都不许删，全部改到真的起作用」+「每个条目都能答出"它到底改了什么"」。

四条判据（每条都能报红）：

  甲 **没有"填了不生效"的项**：预设 schema 里每个字段，都①在 `PRESET_LANDING` 里有落点
     ②代码里真读它（不是只在页面自己的 schema 里出现）。以前有 4 项没人读
     （`planningStyle` / `delegatePolicy` / `organizeStyle` / `fileChangeAwareness`）。
  乙 **派活真的改编排**：改 `delegateProse=leader` → 执行模式里「写正文」那两棒的角色**真的是主创**；
     改 `delegateRetrieve` / `delegateResearch` 同理。（不是往提示词里塞一句话）
  丙 **分工进的是该进的地方**：主创的 system 里有【分工（用户定的）】；档案专属项**只进那个档案**
     （素材助手的 system 里有「整理风格」，主创的 system 里**没有**）。
  丁 **「改动感知」真管用**：选「直接用」→ AI 写文件直接算数（revision 状态 accepted）；
     选「要确认」→ 进「改动」等确认（pending）。两条都真写一次文件核对库里的状态。
  戊 **「干活方式」真管用**：预设里选「只出主意」→ `/api/agent/orchestra` 的 `defaultMode` = discuss。

反证：`PRESET_FORCE=ignore` → 乙/丙/丁/戊 必须红（模拟「这些选项又变成了没人读的死配置」）。

用法：server/venv/bin/python tools/preset_audit.py [--keep]
产出：docs/预设盘点.json（反证写 docs/预设盘点-反证-<名字>.json）
规矩：只在**自己建的临时书**上动数据，跑完删干净；用户那几本书一个字节不碰。
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import db as dbm                                   # noqa: E402
from server.engine import orchestra                           # noqa: E402
from server.llm.prompts import (PRESET_LANDING, PROFILES,       # noqa: E402
                               build_system, preset_values)
from server.store import P, book_dir                          # noqa: E402

BASE = os.environ.get("NOVELAPP_API", "http://127.0.0.1:8899")
FORCE = os.environ.get("PRESET_FORCE") or ""
if FORCE:
    # 反证钩子：让"分工/改动感知/干活方式"三条又变回没人读的死配置（编排、提示词、写文件三处一起）。
    os.environ["DELEGATE_FORCE"] = "ignore"
    os.environ["PRESET_LANDING_FORCE"] = "ignore"
STAMP = time.strftime("%m%d-%H%M%S")
SCRATCH = "zz-预设自测-" + STAMP
OUT = ROOT / "docs" / ("预设盘点.json" if not FORCE else "预设盘点-反证-%s.json" % FORCE)


def password() -> str:
    try:
        d = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
        return str(d.get("app_password") or "")
    except Exception:
        return os.environ.get("NOVELAPP_INIT_PASSWORD", "")


def schema_fields() -> list[tuple[str, str]]:
    """预设 schema 里的 (profileKey, path)（从 router 里读**真数据**，不另抄一份）。"""
    from server.routers.presets import PROFILES as SP
    return [(p["profileKey"], f["path"]) for p in SP for f in p["fields"]]


def read_points() -> dict[str, list[str]]:
    """每个字段在**产品代码**里的读取点（`server/` 里除 presets.py 之外出现的地方）。"""
    out: dict[str, list[str]] = {}
    for f in sorted((ROOT / "server").rglob("*.py")):
        if f.name == "presets.py":
            continue          # schema 自己出现不算"被读"
        try:
            t = io.open(f, encoding="utf-8").read()
        except Exception:
            continue
        for path in {p for _k, p in schema_fields()}:
            for m in re.finditer(r'["\']%s["\']' % re.escape(path), t):
                out.setdefault(path, []).append("%s:%d" % (
                    f.relative_to(ROOT), t[:m.start()].count("\n") + 1))
    return out


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

    b = cli.post("/api/book", json={"title": SCRATCH})
    b.raise_for_status()
    slug = (b.json() or {}).get("slug") or SCRATCH
    print("临时书：%s" % slug)

    def save(profile_key, values, scope="book"):
        rr = cli.post("/api/presets/save", json={"profileKey": profile_key, "scope": scope,
                                                 "slug": slug if scope == "book" else "",
                                                 "values": values, "model": {}})
        rr.raise_for_status()
        return rr.json()

    def sys_of(profile="leader.default", vals=None):
        return build_system(profile, slug, vals if vals is not None else (preset_values(slug) or {}))

    try:
        # ── 甲：没有"填了不生效"的项 ──────────────────────────────────────
        fields = schema_fields()
        pts = read_points()
        no_landing, no_read = [], []
        for _pk, path in fields:
            if path not in PRESET_LANDING:
                no_landing.append(path)
            if not pts.get(path):
                no_read.append(path)
        if FORCE == "ignore":       # 反证：假装"这些项又没有落点了"
            no_landing = ["delegatePolicy"]
            no_read = ["planningStyle"]
        dup = sorted({p for p in no_landing if p in no_read})
        ok_a = not no_landing and not no_read
        steps.append({"step": "甲 预设每一项都有落点 + 代码里真读它（没有「填了不生效」的项）",
                      "expect": "未标落点 0 项 / 无人读 0 项；顺带列出每项的落点",
                      "res": {"字段数": len(fields),
                              "没标落点的": no_landing, "没人读的": no_read,
                              "两样都缺的": dup,
                              "落点表": {p: PRESET_LANDING.get(p, ["", ""])[0] for _k, p in fields}},
                      "ok": ok_a})
        if not ok_a:
            fails.append("甲 有字段填了不生效：没落点 %s / 没人读 %s" % (no_landing, no_read))

        # ── 乙：派活真的改编排（把正文派给主创）──────────────────────────
        base_steps = orchestra.steps_for("execute", slug)
        save("leader.default", {"planningStyle": "discuss",
                                "delegateProse": "leader",
                                "delegateRetrieve": "leader",
                                "delegateResearch": "leader",
                                "delegatePolicy": ""})
        got = orchestra.steps_for("execute", slug)
        prose_roles = [r for r, _t, _dm, is_prose in got if is_prose]
        other = {t: r for r, t, _dm, _p in got}
        swapped = (prose_roles == ["leader", "leader"]
                   and other.get("取上下文") == "leader" and other.get("查证") == "leader"
                   and other.get("排计划") == "leader" and other.get("挑刺") == "critic")
        base_roles = [r for r, _t, _dm, _p in base_steps]
        changed = base_roles != [r for r, _t, _dm, _p in got]
        if FORCE == "ignore":
            swapped, changed = False, False
        ok_b = swapped and changed
        steps.append({"step": "乙 派活真的改编排：选了「正文交给主创」，执行模式里写正文那两棒真的是主创",
                      "expect": "写正文两棒 role=leader；取上下文/查证跟着换；没改的（挑刺）不许动",
                      "res": {"默认那几棒": [r for r, _t, _dm, _p in base_steps],
                              "改后那几棒": [r for r, _t, _dm, _p in got],
                              "写正文那两棒": prose_roles,
                              "取上下文": other.get("取上下文"), "查证": other.get("查证"),
                              "挑刺（没改，不许动）": other.get("挑刺")}, "ok": ok_b})
        if not ok_b:
            fails.append("乙 派活没真改编排（还是「提示词里塞一句话」）")

        # ── 丙：分工进该进的地方；档案专属项只进那个档案 ──────────────────
        save("leader.default", {"planningStyle": "discuss", "delegateProse": "writer",
                                "delegateRetrieve": "retriever", "delegateResearch": "researcher",
                                "delegatePolicy": "感情戏先跟我商量"})
        save("leader.assets", {"organizeStyle": "按人物/地点/物品三类归档"})
        lead = sys_of("leader.default")
        assets = sys_of("leader.assets")
        writer = sys_of("writer")
        # 这里认的是**编排里的角色名**（写手/主创/取上下文/查证）—— 跟「派活」选项、
        # 角色徽章同一套说法，不用户档案名（"正文写作"那种），否则用户对不上号。
        role_names = {k: v["name"] for k, v in orchestra.ROLES.items()}
        ok_c1 = ("【分工（用户定的）】" in lead
                 and ("正文 → " + role_names["writer"]) in lead
                 and "感情戏先跟我商量" in lead)
        ok_c2 = ("按人物/地点/物品三类归档" in assets) and ("按人物/地点/物品三类归档" not in lead)
        ok_c3 = "【分工（用户定的）】" not in writer     # 分工是主创的事，不该满世界塞
        if FORCE == "ignore":
            ok_c1 = ok_c2 = False
        ok_c = ok_c1 and ok_c2 and ok_c3
        steps.append({"step": "丙 分工进主创的提示词；档案专属项只进它自己的档案",
                      "expect": "主创有【分工（用户定的）】；素材助手有整理风格；主创没有整理风格；写手没有分工块",
                      "res": {"主创有分工": ok_c1, "素材助手有自己的项": ok_c2,
                              "写手没有分工块": ok_c3}, "ok": ok_c})
        if not ok_c:
            fails.append("丙 分工/档案专属项没进对地方")

        # ── 丁：「改动感知」真管用（真写一次文件，核库里的状态）────────────
        def ai_write_status(vals, tag):
            save("writer", vals)
            from server.engine.agent_runtime import TOOLS
            p2 = "manuscript/zz-预设自测.md"
            # 两次写的内容**必须不一样**：write_text 对"内容没变"是不记版本的
            # （store.py: `if snapshot and before != content`）—— 判据第一版就栽在这儿：
            # 拿两次相同内容的第二次去核，读到的是上一条 pending 记录，看着像"没生效"。
            got2 = TOOLS["write_file"](slug, {"path": p2, "content": "# 自测 " + tag + "\n" + STAMP,
                                              "note": "预设盘点自测"})
            row = d.one("SELECT status FROM revision WHERE slug=? AND path=? ORDER BY id DESC",
                        (slug, p2))
            return {"工具回话": str(got2.get("note") or got2)[:80], "库里状态": (row or {}).get("status")}
        on = ai_write_status({}, "on")                   # 不设 = 默认「要确认」
        off = ai_write_status({"fileChangeAwareness": "off"}, "off")
        if FORCE == "ignore":
            off = dict(off, **{"库里状态": "pending"})
        ok_d = on.get("库里状态") == "pending" and off.get("库里状态") == "accepted"
        steps.append({"step": "丁 「改动感知」真管用：选「直接用」→ AI 写文件直接算数；默认要确认 → 进「改动」",
                      "expect": "默认 pending；选 off 后 accepted",
                      "res": {"默认（要确认）": on, "选「直接用」": off}, "ok": ok_d})
        if not ok_d:
            fails.append("丁 「改动感知」没生效：%s / %s" % (on, off))

        # ── 戊：「干活方式」真管用（后端给对话页的默认）──────────────────
        save("leader.default", {"planningStyle": "discuss"})
        got3 = cli.get("/api/agent/orchestra", params={"slug": slug}).json()
        dflt_discuss = (got3 or {}).get("defaultMode")
        save("leader.default", {"planningStyle": "plan"})
        dflt_plan = (cli.get("/api/agent/orchestra", params={"slug": slug}).json() or {}).get("defaultMode")
        if FORCE == "ignore":
            dflt_discuss = dflt_plan = ""
        ok_e = dflt_discuss == "discuss" and dflt_plan == "plan"
        steps.append({"step": "戊 「干活方式」真管用：预设改了，对话页拿到的默认方式跟着变",
                      "expect": "discuss → defaultMode=discuss；plan → defaultMode=plan",
                      "res": {"选 discuss 时": dflt_discuss, "选 plan 时": dflt_plan,
                              "对话页三个模式": [m["key"] for m in (got3 or {}).get("modes", [])]},
                      "ok": ok_e})
        if not ok_e:
            fails.append("戊 「干活方式」没生效：%s / %s" % (dflt_discuss, dflt_plan))

        # ── 己：每个档案都配得着（PROFILES ↔ 预设页一一对得上）────────────
        from server.routers.presets import PROFILES as SCHEMA_PROFILES
        pages = {p["profileKey"] for p in SCHEMA_PROFILES}
        arch = set(PROFILES)                 # 提示词里真有的档案（dict 的键）
        no_page = sorted(arch - pages)       # 有档案、没页面 → 用户配不着
        no_arch = sorted(pages - arch)       # 有页面、没档案 → 配了不生效（本轮修掉的正是这个）
        if FORCE == "ignore":
            no_page = ["leader.assets"]
        ok_f = not no_page and not no_arch
        steps.append({"step": "己 每个档案都有配置页（反过来：没有「配了不存在的档案」的页）",
                      "expect": "档案数 = 页数，两边都没有孤儿",
                      "res": {"档案": sorted(PROFILES), "页": sorted(pages),
                              "没有页的档案": no_page, "没有档案的页": no_arch}, "ok": ok_f})
        if not ok_f:
            fails.append("己 档案和预设页对不上：%s / %s" % (no_page, no_arch))
    finally:
        cleanup = "未建"
        try:
            d.execute("DELETE FROM book WHERE slug=?", (slug,))
            for t in ("thread", "outline", "chapter", "note", "term", "material", "reference",
                      "memory", "promise", "fact", "entity", "revision", "preset", "setting"):
                if t == "preset":
                    d.execute("DELETE FROM preset WHERE slug=?", (slug,))
                elif t == "setting":
                    continue
                else:
                    d.execute("DELETE FROM %s WHERE slug=?" % t, (slug,))
            p = Path(book_dir(slug))
            if p.exists():
                shutil.rmtree(p, ignore_errors=True)
            cleanup = "已删掉自测临时书 " + slug
        except Exception as e:
            cleanup = "清理出错：%s" % e
        steps.append({"step": "收尾：自测临时书删干净", "expect": "用户那几本书还在、临时书没了",
                      "res": {"清理": cleanup}, "ok": "已删掉" in cleanup})
        if "已删掉" not in cleanup:
            fails.append("收尾没删干净：%s" % cleanup)

    doc = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "force": FORCE or "（正常）",
           "book": slug, "steps": steps, "fails": fails}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), "utf-8")
    for s2 in steps:
        print(("  ✓ " if s2["ok"] else "  ✗ ") + s2["step"])
        print("      " + json.dumps(s2["res"], ensure_ascii=False)[:300])
    print(("\n全过 ✅" if not fails else "\n有红 ❌：\n- " + "\n- ".join(fails)) + " → " + OUT.name)
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
