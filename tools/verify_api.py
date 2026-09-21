#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""接口实测：把后端每一个接口真打一遍，检查**返回字段名**是否跟前端要的一致。

用法：
    server/venv/bin/python tools/verify_api.py            # 全跑（含一次很小的模型调用）
    server/venv/bin/python tools/verify_api.py --no-llm   # 跳过要花钱的模型调用

产出：
    docs/接口实测.json（逐条结果） + 控制台通过/失败表 + 末尾一行汇总
规矩：口令、密钥一律从本机读，**不打印、不写进报告**。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx

BASE = os.environ.get("NOVELAPP_API", "http://127.0.0.1:8899")
ROOT = Path(__file__).resolve().parent.parent
NO_LLM = "--no-llm" in sys.argv
LLM_MODEL = os.environ.get("NOVELAPP_TEST_MODEL", "渠道/[渠道]某模型")
STAMP = time.strftime("%m%d-%H%M%S")
SCRATCH = f"zz-verify-{STAMP}"

results: list[dict] = []
cli = httpx.Client(base_url=BASE, timeout=120.0)


def password() -> str:
    for p in ("/home/ubuntu/nbapp/config.json",):
        try:
            d = json.loads(Path(p).read_text("utf-8"))
            if d.get("app_password"):
                return str(d["app_password"])
        except Exception:
            pass
    return os.environ.get("NOVELAPP_INIT_PASSWORD", "")


def check(name: str, method: str, path: str, *, ok=(200,), keys=(), body=None,
          params=None, files=None, data=None, raw=False, note="", skipif=None,
          code_only=False):
    """发一个请求并检查：状态码在 ok 里、返回体里有 keys 这些字段。"""
    if skipif:
        results.append({"name": name, "status": "skip", "why": skipif, "note": note})
        print(f"  -  {name}  (跳过：{skipif})")
        return None
    t0 = time.time()
    try:
        r = cli.request(method, path, json=body if (body is not None and files is None and data is None) else None,
                        params=params, files=files, data=data)
    except Exception as e:
        results.append({"name": name, "status": "fail", "why": f"请求异常：{e}", "note": note})
        print(f"  ✗  {name}  请求异常 {e}")
        return None
    ms = int((time.time() - t0) * 1000)
    detail = ""
    good = r.status_code in ok
    parsed = None
    if raw:
        parsed = {"bytes": len(r.content)}
        if good and len(r.content) == 0:
            good, detail = False, "返回是空的"
    else:
        try:
            parsed = r.json()
        except Exception:
            parsed = {"_text": r.text[:200]}
        if good and not code_only:
            if isinstance(parsed, dict):
                missing = [k for k in keys if k not in parsed]
                if missing:
                    good, detail = False, "缺字段 " + ",".join(missing)
            elif keys:
                good, detail = False, "期望是对象，实际是 " + type(parsed).__name__
    if not good and not detail:
        detail = f"HTTP {r.status_code}: " + (json.dumps(parsed, ensure_ascii=False)[:160]
                                              if parsed is not None else r.text[:160])
    results.append({"name": name, "method": method, "path": path, "http": r.status_code,
                    "ms": ms, "status": "ok" if good else "fail", "why": detail, "note": note,
                    "sample": (json.dumps(parsed, ensure_ascii=False)[:400] if parsed else "")})
    print(f"  {'✓' if good else '✗'}  {name}  {r.status_code} {ms}ms {detail}")
    return parsed


def _sse_head(url: str) -> bool:
    """连一下 SSE，看看有没有在 5 秒内吐第一帧（不读完整流，不然会一直挂着）。"""
    try:
        with cli.stream("GET", url, timeout=httpx.Timeout(5.0, read=5.0)) as r:
            if r.status_code != 200:
                return False
            for line in r.iter_lines():
                if line.strip():
                    return True
    except Exception:
        return False
    return False


def _shape_diff(shape: dict, got) -> tuple[list[str], list[str]]:
    """旧平台的形状 vs 我们的返回：返回 (缺的字段, 多出来的字段)。"""
    if not isinstance(shape, dict) or not isinstance(got, dict):
        return ([], [])
    want = set(shape.keys())
    have = set(got.keys())
    missing = sorted(want - have)
    extra = sorted(have - want)
    return missing, extra


def main() -> int:
    pw = password()
    if not pw:
        print("读不到口令，没法测。先跑一次服务让它初始化。")
        return 2
    print("\n== 登录 ==")
    r = cli.post("/api/app/login", json={"password": pw})
    if r.status_code != 200:
        print("登录失败", r.status_code, r.text[:200])
        return 2
    print("  登录 ok（口令不打印）")

    print("\n== App 层 ==")
    check("health", "GET", "/api/health", keys=("ok", "version"))
    check("app/info", "GET", "/api/app/info", keys=("name", "authEnabled", "voice"))
    check("app/status", "GET", "/api/app/status", keys=("loggedIn",))
    check("auth/me", "GET", "/api/auth/me", keys=("user",))
    check("app/version", "GET", "/api/app/version", keys=("versionLabel",))
    check("apk/version", "GET", "/api/apk/version", keys=("versionCode",))
    check("app/logs/status", "GET", "/api/app/logs/status", keys=("files", "directory"))
    check("notifications", "GET", "/api/notifications", keys=("items", "unread"))
    check("admin/users", "GET", "/api/admin/users", note="旧平台返回的就是一个数组")

    print("\n== 书架 / 作品 ==")
    shelf = check("shelf", "GET", "/api/shelf", keys=("projects",))
    proj = check("projects", "GET", "/api/projects", keys=("projects", "revision"))
    # 同一本书在 /api/shelf 里叫 slug、在 /api/projects 里叫 projectRoot —— 两个键都必须在，
    # 否则写脚本的人（哪怕是我自己）少看一行就取到 undefined（第 11 轮踩过）。
    _rows = ((proj or {}).get("projects") or [])
    _both = bool(_rows) and all(r.get("slug") and r.get("slug") == r.get("projectRoot") for r in _rows)
    _name = "projects 的 slug/projectRoot 两键一致"
    if _both:
        results.append({"name": _name, "method": "GET", "path": "/api/projects", "http": 200,
                        "status": "ok", "why": "", "note": "共 %d 本" % len(_rows)})
        print("  ✓  %s  共 %d 本" % (_name, len(_rows)))
    else:
        results.append({"name": _name, "method": "GET", "path": "/api/projects", "http": 200,
                        "status": "fail", "why": "有的行缺 slug 或两键不等", "note": ""})
        print("  ✗  %s" % _name)
    check("projects/open", "POST", "/api/projects/open", body={}, keys=("ok",))
    check("models", "GET", "/api/models", keys=("models",))
    check("doctor", "GET", "/api/doctor", keys=("ok",))
    real = (shelf or {}).get("projects") or []
    if not real:
        print("  没有真实作品，先用靶子书；")
    real_slug = real[0]["slug"] if real else ""

    print("\n== 靶子作品（自测用完会移进回收站）==")
    b = check("book 新建", "POST", "/api/book", body={"title": SCRATCH}, keys=("slug",))
    slug = (b or {}).get("slug") or SCRATCH
    check("book 详情", "GET", "/api/book", params={"slug": slug}, keys=("chapters", "totalWords"))
    check("chapter 新建", "POST", "/api/chapter/new",
          body={"slug": slug, "path": "manuscript/第001章-实测.md",
                "content": "# 实测\n\n他很累。她微微一笑，似乎意味着一切都结束了。\n"}, keys=("ok",))
    check("chapter 读", "GET", "/api/chapter",
          params={"slug": slug, "path": "manuscript/第001章-实测.md"}, keys=("content", "mtimeMs"))
    check("chapter 写", "PUT", "/api/chapter",
          body={"slug": slug, "path": "manuscript/第001章-实测.md",
                "content": "# 实测\n\n他推开门。屋里没有人。\n"}, keys=("ok",))
    check("chapter 改名", "POST", "/api/chapter/rename",
          body={"slug": slug, "from": "manuscript/第001章-实测.md", "to": "manuscript/第001章-实测改名.md"})
    check("chapter 删除", "POST", "/api/chapter/delete",
          body={"slug": slug, "path": "manuscript/第001章-实测改名.md"})
    check("search", "GET", "/api/search", params={"slug": slug, "q": "门"}, keys=("hits",))
    check("cover 上传", "POST", "/api/cover", params={"slug": slug},
          files={"file": ("c.png", _PNG, "image/png")}, keys=("ok",))
    check("cover 读", "GET", "/api/cover", params={"slug": slug}, raw=True)

    print("\n== 设定 ==")
    check("lore/tree", "GET", "/api/lore/tree", params={"slug": slug}, keys=("files",))
    check("lore 新建", "POST", "/api/lore/entry",
          body={"slug": slug, "path": "lorebook/character/测试.md", "title": "测试", "content": "内容"})
    check("lore/search", "GET", "/api/lore/search", params={"slug": slug, "q": "测试"}, keys=("hits",))
    check("lore/entry 读", "GET", "/api/lore/entry",
          params={"slug": slug, "path": "lorebook/character/测试.md"}, keys=("content",))
    check("lore 删除", "DELETE", "/api/lore/entry",
          params={"slug": slug, "path": "lorebook/character/测试.md"})

    print("\n== 世界引擎（阶段 3 / 13 / 14）==")
    check("world/overview", "GET", "/api/world/overview", params={"slug": slug},
          keys=("counts", "entities", "conflicts"))
    check("world/entities", "GET", "/api/world/entities", params={"slug": slug}, keys=("items", "kinds"))
    e = check("world/entity 新建", "POST", "/api/world/entity",
              body={"slug": slug, "kind": "character", "name": "林诺",
                    "data": {"外貌": "瘦", "目标": "活下去"}, "aliases": ["小诺"]}, keys=("id",))
    eid = (e or {}).get("id")
    check("world/entity 别名查询", "GET", "/api/world/entities",
          params={"slug": slug, "q": "小诺"}, keys=("items",))
    check("world/facts", "GET", "/api/world/facts", params={"slug": slug, "entityId": eid}, keys=("items",))
    check("world/fact 新增", "POST", "/api/world/fact",
          body={"slug": slug, "entityId": eid, "key": "状态", "value": "在荒原"})
    check("world/moment 新增（第一个）", "POST", "/api/world/moment",
          body={"slug": slug, "label": "旧事先", "timeText": "第一年夏"})
    mo = check("world/moment 新增（第二个）", "POST", "/api/world/moment",
               body={"slug": slug, "label": "入城那晚", "timeText": "第二年冬"}, keys=("id",))
    mid = (mo or {}).get("id")
    check("world/moments", "GET", "/api/world/moments", params={"slug": slug}, keys=("items",))
    check("world/state（某时刻状态）", "GET", "/api/world/state",
          params={"slug": slug, "name": "林诺", "at": "入城那晚"}, keys=("state", "facts"))
    check("world/state（更早的时刻，倒叙也算对）", "GET", "/api/world/state",
          params={"slug": slug, "name": "林诺", "at": "旧事先"}, keys=("state",))
    check("world/state（不存在的时刻要明确报错）", "GET", "/api/world/state",
          params={"slug": slug, "name": "林诺", "at": "根本没这个时刻"}, ok=(404,))
    check("world/relation 新增", "POST", "/api/world/relation",
          body={"slug": slug, "from": "林诺", "to": "林诺", "kind": "自省"} )
    check("world/relations", "GET", "/api/world/relations", params={"slug": slug}, keys=("items",))
    check("world/timeline", "GET", "/api/world/timeline", params={"slug": slug}, keys=("moments",))
    check("world/episode 新增", "POST", "/api/world/episode",
          body={"slug": slug, "momentId": mid, "title": "进城", "summary": "第一次进城"})
    check("world/arc 存", "POST", "/api/world/arc",
          body={"slug": slug, "entityId": eid, "goal": "活着", "motive": "不甘",
                "turningPoints": [{"at": "入城那晚", "what": "见到她"}]})
    check("world/arc 读", "GET", "/api/world/arc", params={"slug": slug, "entityId": eid}, keys=("arc",))
    check("world/conflicts", "GET", "/api/world/conflicts", params={"slug": slug}, keys=("items",))
    check("world/extract（从正文认人名）", "POST", "/api/world/extract", body={"slug": slug}, keys=("items",))
    check("world/import-lorebook", "POST", "/api/world/import-lorebook", body={"slug": slug}, keys=("ok",))

    # ── 事件溯源：历法 / 切面 / 回溯 / 审计（第 8 轮补） ──
    check("world/calendars（公历永远在）", "GET", "/api/world/calendars",
          params={"slug": slug}, keys=("items",))
    kong = {"name": "四时历", "months": [40] * 10, "leap_month": 5, "leap_days": 5,
            "leap_rule": {"every": 3}, "year_zero": True, "week": 5,
            "anchor": {"year": 1, "month": 1, "day": 1, "abs": 0},
            "eras": [{"name": "第三纪", "sign": 1}]}
    check("world/calendar 存（架空历）", "POST", "/api/world/calendar",
          body={"slug": slug, "name": "四时历", "def": kong, "note": "自造"}, keys=("name", "desc"))
    check("world/calendar/convert 文本→绝对序号", "POST", "/api/world/calendar/convert",
          body={"slug": slug, "text": "第三纪 4 年 1 月 1 日", "calendar": "四时历"},
          keys=("abs", "date_text"))
    check("world/calendar/convert 绝对序号→日期", "POST", "/api/world/calendar/convert",
          body={"slug": slug, "abs": 1205, "calendar": "四时历"}, keys=("year", "month", "day"))
    check("world/calendar/convert 公元前（公历）", "POST", "/api/world/calendar/convert",
          body={"slug": slug, "text": "公元前 221 年 3 月 5 日"}, keys=("abs",))
    check("world/calendar/convert 看不懂的时间要报错", "POST", "/api/world/calendar/convert",
          body={"slug": slug, "text": "某天傍晚"}, keys=("error",))
    check("world/moment/time（给时刻定时间）", "POST", "/api/world/moment/time",
          body={"slug": slug, "momentId": mid, "text": "第三纪 4 年 1 月 1 日",
                "calendar": "四时历"}, keys=("abs", "dateText"))
    check("world/moment/times", "GET", "/api/world/moment/times", params={"slug": slug},
          keys=("moments", "dated"))
    check("world/reorder（按时间重排）", "POST", "/api/world/reorder", body={"slug": slug},
          keys=("moved",))
    check("world/retro（带出处的回溯）", "GET", "/api/world/retro",
          params={"slug": slug, "at": "入城那晚", "subject": "林诺"}, keys=("entities", "cutoff"))
    check("world/snapshots（切面列表）", "GET", "/api/world/snapshots",
          params={"slug": slug, "entityId": eid}, keys=("items",))
    check("world/snapshots/rebuild", "POST", "/api/world/snapshots/rebuild",
          body={"slug": slug}, keys=("ok", "rows"))
    check("world/audit（审计留痕）", "GET", "/api/world/audit",
          params={"slug": slug, "limit": 20}, keys=("items", "count"))
    check("world/calendar 删（有人用的要先拦）", "DELETE", "/api/world/calendar",
          params={"slug": slug, "name": "四时历"}, ok=(200, 400))

    print("\n== 剧情工坊（阶段 4 / 15）==")
    check("plot/overview", "GET", "/api/plot/overview", params={"slug": slug},
          keys=("chapters", "threads", "promises", "acts", "counts"))
    check("plot/act 存", "POST", "/api/plot/act", body={"slug": slug, "number": 1, "title": "第一卷"})
    # 后面几步（workspace-files/download、tts/seg）要一章**有正文**的章：
    # 新建书自带的默认章是空的（第 9 遍打磨改的 —— 空章才不会让质检一开屏就判 0 分），
    # 上面那章又被 delete 掉了，所以这里显式再建一章有字的。
    # 踩过的坑：以前这几步直接用 chapters[0]，恰好是那章空的 → 下载 0 字节、听书 404，
    # 报出来像"接口坏了"，其实是**测试自己没有正文可测**。
    check("chapter 新建（下载/听书要有正文的那章）", "POST", "/api/chapter/new",
          body={"slug": slug, "path": "manuscript/第002章-实测.md",
                "content": "# 实测二\n\n他推开门。屋里没有人。风从山口吹下来。\n"}, keys=("ok",))
    chs = (check("plot 章节列表", "GET", "/api/plot/overview", params={"slug": slug}) or {}).get("chapters") or []
    ch = next((c for c in chs if (c.get("words") or 0) > 0), (chs[0] if chs else {}))
    ch_path = ch.get("path") or ""
    if not ch_path or not (ch.get("words") or 0):
        raise SystemExit("自测前置不成立：靶子书里没有一章有正文，后面下载/听书没法验")
    check("plot/chapter 元信息", "PATCH", "/api/plot/chapter",
          body={"slug": slug, "path": ch_path, "status": "detail", "targetWords": 3000,
                "pov": "第三人称限知", "infoControl": {"读者知": ["A"], "主角不知": ["B"]}},
          keys=("chapter",))
    check("plot/outline 存", "POST", "/api/plot/outline",
          body={"slug": slug, "path": ch_path, "body": "他进城；遇到她；被赶出来。"}, keys=("id",))
    check("plot/outline 读", "GET", "/api/plot/outline", params={"slug": slug, "path": ch_path}, keys=("items",))
    check("plot/scene 存", "POST", "/api/plot/scene",
          body={"slug": slug, "chapterPath": ch_path, "title": "城门", "summary": "被拦下",
                "cast": ["林诺"], "worldMomentId": mid}, keys=("id",))
    check("plot/thread 存", "POST", "/api/plot/thread",
          body={"slug": slug, "name": "主线：活下去", "kind": "main", "scenes": [ch_path]}, keys=("id",))
    p = check("plot/promise 存", "POST", "/api/plot/promise",
              body={"slug": slug, "name": "木牌是谁给的", "kind": "foreshadow",
                    "setupScene": ch_path, "dueChapter": ch_path}, keys=("id",))
    check("plot/promise 推进", "POST", "/api/plot/promise/advance",
          body={"slug": slug, "id": (p or {}).get("id"), "scene": ch_path, "note": "提了一句"})
    check("plot/promises/due", "GET", "/api/plot/promises/due", params={"slug": slug}, keys=("items",))
    d = check("plot/decision 存", "POST", "/api/plot/decision",
              body={"slug": slug, "title": "让主角先示弱", "reason": "反差", "risks": "显得弱"},
              keys=("id",))
    check("plot/decision 推翻", "POST", "/api/plot/decision/supersede",
          body={"slug": slug, "id": (d or {}).get("id"), "title": "改成先发力", "reason": "更抓人"})
    check("plot/cast（出场统计）", "GET", "/api/plot/cast", params={"slug": slug}, keys=("items", "vanished"))

    print("\n== 写作链（阶段 5，自动注入设定）==")
    check("write/status", "GET", "/api/write/status", params={"slug": slug}, keys=("modelKey", "ready"))
    ctx = check("write/context（看注入内容）", "GET", "/api/write/context",
                params={"slug": slug, "path": ch_path, "mode": "continue"},
                keys=("system", "messages", "chars"))
    if ctx:
        assert "【当前章节】" in ctx["system"] or any("【当前章节】" in m["content"] for m in ctx["messages"]), "上下文里没有注入当前章节"
    check("write/history", "GET", "/api/write/history", params={"slug": slug}, keys=("items",))
    if NO_LLM:
        check("write/summary（要模型）", "POST", "/api/write/summary", skipif="--no-llm")
    else:
        w = check("write/summary（要模型）", "POST", "/api/write/summary",
                  body={"slug": slug, "path": ch_path, "modelKey": LLM_MODEL, "maxTokens": 96},
                  keys=("type", "text"), note="一次很小的真实调用")
        if w and w.get("text"):
            results[-1]["note"] += f"；模型回了 {len(w['text'])} 字"

    print("\n== 质检（阶段 6）==")
    check("lint/rules", "GET", "/api/lint/rules", keys=("items", "categories"))
    s = check("lint/scan", "POST", "/api/lint/scan",
              body={"slug": slug, "text": "他微微一笑，似乎意味着一切都结束了。这就是人生。"},
              keys=("hits", "stats", "grade"))
    if s:
        results[-1]["note"] = f"命中 {len(s['hits'])} 条规则"
    check("lint/scan-book", "POST", "/api/lint/scan-book", body={"slug": slug, "limit": 200},
          keys=("chapters", "score"))
    check("lint/fix（预览）", "POST", "/api/lint/fix",
          body={"slug": slug, "text": "他似乎意味着这一切都结束了。"}, keys=("removed", "before", "after"))
    check("lint/report", "GET", "/api/lint/report", params={"slug": slug}, keys=("items",))
    if NO_LLM:
        check("lint/llm（要模型）", "POST", "/api/lint/llm", skipif="--no-llm")

    print("\n== 统计（阶段 20）==")
    check("stats/book", "GET", "/api/stats/book", params={"slug": slug}, keys=("totalWords", "perDay", "streak"))
    check("stats/calendar", "GET", "/api/stats/calendar", params={"slug": slug}, keys=("days",))
    check("stats/cost", "GET", "/api/stats/cost", keys=("items", "totalCost"))
    check("stats/achievements", "GET", "/api/stats/achievements", params={"slug": slug}, keys=("items", "done"))
    check("stats/report", "GET", "/api/stats/report", params={"slug": slug, "kind": "week"}, keys=("text", "markdown"))
    if real_slug:
        check("stats/book（真实作品）", "GET", "/api/stats/book", params={"slug": real_slug},
              keys=("totalWords", "chapters"))

    print("\n== 导出 / 导入（阶段 21）==")
    check("export/text", "GET", "/api/export/text", params={"slug": slug, "format": "txt"}, raw=True)
    check("export/markdown", "GET", "/api/export/markdown", params={"slug": slug}, raw=True)
    check("export/epub", "GET", "/api/export/epub", params={"slug": slug}, raw=True)
    check("export/pdf", "GET", "/api/export/pdf", params={"slug": slug}, raw=True)
    check("export/print", "GET", "/api/export/print", params={"slug": slug}, raw=True)
    check("export/bundle（整包）", "GET", "/api/export/bundle", params={"slug": slug}, raw=True)
    check("import/text", "POST", "/api/import/text",
          body={"slug": slug, "name": "粘贴来的", "text": "第一句。第二句。"}, keys=("ok", "path"))
    check("import/markdown", "POST", "/api/import/markdown",
          files={"files": ("甲.md", "# 甲章\n\n内容甲。".encode(), "text/markdown")},
          data={"slug": slug, "prefix": "import"}, keys=("imported",))
    check("import/bundle（乱七八糟的 zip 必须明确拒绝）", "POST", "/api/import/bundle",
          files={"file": ("junk.zip", b"not a zip", "application/zip")},
          data={"title": "不该建出来的书"}, ok=(400,), code_only=True,
          note="拒绝理由里要提 book/ 目录；不许悄悄建一本空书")
    card = {"name": "测试角色", "description": "来自角色卡", "personality": "倔",
            "aliases": ["阿测"]}
    check("import/character-card（JSON 卡）", "POST", "/api/import/character-card",
          files={"file": ("card.json", json.dumps(card).encode(), "application/json")},
          data={"slug": slug}, keys=("ok", "id"))

    print("\n== 工具：书签 / 进度 / 术语 / 素材 / 审计（阶段 19 / 22）==")
    check("bookmarks 存", "POST", "/api/bookmarks",
          body={"slug": slug, "path": ch_path, "percent": 0.42, "text": "这句话"}, keys=("id",))
    check("bookmarks 读", "GET", "/api/bookmarks", params={"slug": slug}, keys=("items",))
    check("progress 存", "POST", "/api/progress", body={"slug": slug, "path": ch_path, "percent": 0.5})
    check("progress 读", "GET", "/api/progress", params={"slug": slug}, keys=("progress",))
    t = check("term 存", "POST", "/api/term",
              body={"slug": slug, "name": "魂导器", "aliases": ["魂导"], "kind": "道具"}, keys=("id",))
    check("term 读", "GET", "/api/term", params={"slug": slug}, keys=("items",))
    check("term/check（一致性）", "POST", "/api/term/check", body={"slug": slug}, keys=("items", "count"))
    check("term 删", "DELETE", "/api/term", params={"slug": slug, "id": (t or {}).get("id")})
    m = check("material 存", "POST", "/api/material",
              body={"slug": slug, "title": "灵感", "body": "一句话", "tags": ["灵感"]}, keys=("id",))
    check("material 读", "GET", "/api/material", params={"slug": slug}, keys=("items",))
    check("material 删", "DELETE", "/api/material", params={"slug": slug, "id": (m or {}).get("id")})
    check("replace（预览）", "POST", "/api/replace",
          body={"slug": slug, "find": "没有人", "replace": "空无一人"}, keys=("files", "total"))
    check("sync/changes", "GET", "/api/sync/changes", params={"slug": slug}, keys=("changed", "all"))
    check("sync/chapter", "GET", "/api/sync/chapter", params={"slug": slug, "path": ch_path},
          keys=("content",))
    check("audit", "GET", "/api/audit", params={"limit": 20}, keys=("items",))

    print("\n== 备份 / 恢复（阶段 8.4 / 22.1）==")
    check("passport/status", "GET", "/api/passport/status",
          keys=("linked", "account", "scopes", "linkedAt"))
    check("passport/backup-keys", "GET", "/api/passport/backup-keys",
          keys=("keys", "activeKeyId", "pendingKeyId"))
    check("passport/backups", "GET", "/api/passport/backups", keys=("backups",))
    bp = check("passport/backups 新建", "POST", "/api/passport/backups", body={"note": "实测备份"},
               keys=("ok", "backup"))
    name = ((bp or {}).get("backup") or {}).get("name")
    check("backup/list", "GET", "/api/backup/list", keys=("items", "auto", "dir"))
    check("backup/download", "GET", "/api/backup/download", params={"name": name or ""}, raw=True,
          skipif=None if name else "没有备份名")
    check("backup/auto 读", "GET", "/api/backup/auto", keys=("enabled",))
    check("backup/auto 写", "POST", "/api/backup/auto", body={"enabled": True, "everyHours": 24, "keep": 14})
    check("backup/restore（自己恢复自己）", "POST", "/api/backup/restore",
          body={"name": name, "confirm": True}, keys=("ok", "restoredFiles", "preBackup"),
          skipif=None if name else "没有备份名", note="恢复前后内容一致，且多留一份快照")
    check("backup/doctor（数据自检）", "GET", "/api/backup/doctor", keys=("books", "issues", "clean"))

    print("\n== 工具页：文件 / 历史 / RAG / 模型配置 / 档案 / 会话（阶段 8）==")
    check("workspace-files/tree", "GET", "/api/workspace-files/tree", params={"projectRoot": slug},
          keys=("nodes", "issues", "validatedAt"))
    check("workspace-files/read", "GET", "/api/workspace-files/read",
          params={"projectRoot": slug, "path": ch_path},
          keys=("content", "absolutePath", "entryType", "editable"))
    check("workspace-files/create-file", "POST", "/api/workspace-files/create-file",
          body={"projectRoot": slug, "path": "material/实测素材.md", "content": "素材"})
    check("workspace-files/write", "PUT", "/api/workspace-files/write",
          body={"projectRoot": slug, "path": "material/实测素材.md", "content": "素材改过"})
    check("workspace-history/inbox", "GET", "/api/workspace-history/inbox",
          params={"projectRoot": slug}, keys=("groups", "revision"))
    check("workspace-files/download", "GET", "/api/workspace-files/download",
          params={"projectRoot": slug, "path": ch_path}, raw=True)
    check("workspace-files/delete（参数放 body，照前端写法）", "DELETE",
          "/api/workspace-files/delete",
          body={"projectRoot": slug, "path": "material/实测素材.md"}, keys=("ok",))
    check("inbox（改动收件箱）", "GET", "/api/inbox", params={"slug": slug}, keys=("groups", "revision"))
    check("config/models/library", "GET", "/api/config/models/library", keys=("models",))
    check("config/models/provider-templates", "GET", "/api/config/models/provider-templates",
          keys=("templates",))
    check("config/snapshot", "GET", "/api/config/snapshot", keys=("version", "effective", "meta"))
    check("config/global", "GET", "/api/config/global", keys=("config",))
    check("config/project", "GET", "/api/config/project", params={"projectRoot": slug},
          keys=("agent", "config"))
    check("config/editor-snapshot", "GET", "/api/config/editor-snapshot", params={"projectRoot": slug},
          keys=("global",))
    check("agent/profiles/catalog", "GET", "/api/agent/profiles/catalog", note="旧平台返回的就是一个数组")
    check("agent/profiles/settings", "GET", "/api/agent/profiles/settings", params={"projectRoot": slug},
          keys=("agentProfiles", "enabledModels", "profileModelDefaults"))
    check("agent/skills", "GET", "/api/agent/skills", note="旧平台返回的就是一个数组")
    check("agent/jobs", "GET", "/api/agent/jobs", keys=("jobs", "eventCursor"))
    check("rag/memories（GET）", "GET", "/api/projects/rag/memories", params={"projectRoot": slug},
          keys=("subjects",))
    check("rag/search（GET）", "GET", "/api/projects/rag/search",
          params={"projectRoot": slug, "q": "雪"}, ok=(200, 400))
    check("rag/debug（GET）", "GET", "/api/projects/rag/debug", params={"projectRoot": slug},
          keys=("ok", "index"))
    check("rag/subject", "GET", "/api/projects/rag/subject",
          params={"projectRoot": slug, "subjectPath": "simulation/subjects/林诺"}, ok=(200, 404))
    check("agent/traces/recent", "GET", "/api/agent/traces/recent", keys=("entries", "items"))
    check("agent/profiles/build-status", "GET", "/api/agent/profiles/build-status", keys=("profiles",))
    ses = check("agent/sessions 列表", "GET", "/api/agent/sessions", params={"scope": "all", "limit": 5},
                keys=("items", "total", "offset", "limit", "hasMore"))
    ns = check("agent/sessions 新建", "POST", "/api/agent/sessions",
               body={"profileKey": "leader.default", "currentProjectRoot": slug}, keys=("sessionId",))
    sid = (ns or {}).get("sessionId")
    if sid:
        check("agent/sessions 详情", "GET", f"/api/agent/sessions/{sid}",
              keys=("summary", "history", "activeInvocation"))
        good = _sse_head(f"/api/agent/sessions/{sid}/events?after=0")
        results.append({"name": "agent/events（SSE 首帧）",
                        "path": f"/api/agent/sessions/{sid}/events?after=0",
                        "status": "ok" if good else "fail",
                        "why": "" if good else "5 秒内没收到任何事件",
                        "note": "连上后立刻要吐 connected 之类的事件"})
        print(f"  {'✓' if good else '✗'}  agent/events（SSE 首帧）")
        check("agent/commands", "POST", f"/api/agent/sessions/{sid}/commands",
              body={"type": "ping"}, ok=(200, 400, 404), code_only=True)
        check("agent/abort", "POST", f"/api/agent/sessions/{sid}/abort", body={}, ok=(200, 404))
        check("agent/sessions/{sid}/runs（多 Agent 编排记录）",
              "GET", f"/api/agent/sessions/{sid}/runs", keys=("runs",))
    check("agent/orchestra（角色与三种模式目录）", "GET", "/api/agent/orchestra",
          keys=("modes", "roles"),
          note="modes 必须是讨论/计划/执行三种；roles 五个角色")
    check("presets", "GET", "/api/presets", params={"scope": "global"}, keys=("profiles", "models"))
    check("presets 按书", "GET", "/api/presets", params={"scope": "book", "slug": slug},
          keys=("profiles",))
    check("presets/save", "POST", "/api/presets/save",
          body={"profileKey": "writer", "scope": "global", "values": {"段落节奏": "短句为主"},
                "model": {}}, keys=("ok",))
    check("presets/reset", "POST", "/api/presets/reset", body={"slug": slug}, keys=("ok",))
    check("presets/resource", "GET", "/api/presets/resource",
          params={"profileKey": "writer", "key": "style.paper"}, ok=(200, 404))
    check("tts/voices", "GET", "/api/tts/voices", keys=("voices", "engines"))
    check("tts/segments", "GET", "/api/tts/segments", params={"slug": slug, "path": ch_path, "voice": ""},
          keys=("count", "chars"))
    # 听书这一条要**去外网**（edge-tts）合成音频，网络抖一下就会 502 ——
    # 一次 502 不能当回归（第 11 轮真红过一次，重试就好了：合成的文件会落盘缓存）。
    # 规矩：重试一次；还失败才记红，并把接口给的中文原因原样写进报告，别让人猜。
    tts_ok, tts_why = False, ""
    for _try in (1, 2):
        r = cli.get("/api/tts/seg", params={"slug": slug, "path": ch_path, "i": 0})
        tts_ok = r.status_code in (200,) and len(r.content) > 0
        tts_why = f"第{_try}次 HTTP {r.status_code} {len(r.content)} 字节"
        if tts_ok:
            if _try > 1:
                tts_why += "（第一次是外网抖动，重试后好了）"
            break
        try:
            tts_why += " " + str(r.json().get("detail"))[:120]
        except Exception:
            pass
    results.append({"name": "tts/seg（第 0 段）", "method": "GET", "path": "/api/tts/seg",
                    "http": 200 if tts_ok else 502, "ms": 0,
                    "status": "ok" if tts_ok else "fail", "why": "" if tts_ok else tts_why,
                    "note": "真合成一小段 mp3（要外网，失败会重试一次）"})
    print(("  ✓  " if tts_ok else "  ✗  ") + "tts/seg（第 0 段）  " + tts_why)
    check("tts/cache", "GET", "/api/tts/cache", keys=())
    check("rag/inspector", "GET", "/api/projects/rag/inspector", params={"projectRoot": slug},
          keys=("subjects", "index", "embedding"))
    if real_slug:
        bk = cli.get("/api/book", params={"slug": real_slug}).json()
        chs = bk.get("chapters") or []
        if chs:
            check("真实作品·章节读", "GET", "/api/chapter",
                  params={"slug": real_slug, "path": chs[0]["path"]}, keys=("content",))
            check("真实作品·听书分段", "GET", "/api/tts/segments",
                  params={"slug": real_slug, "path": chs[0]["path"]}, keys=("count", "chars"))
            check("真实作品·导出 txt", "GET", "/api/export/text",
                  params={"slug": real_slug, "chapters": chs[0]["path"]}, raw=True)
            check("真实作品·世界引擎（跑在真书上）", "GET", "/api/world/overview",
                  params={"slug": real_slug}, keys=("counts",))

    print("\n== 收尾：靶子作品改名 + 删除（进回收站，不真删）==")
    check("book 改名", "POST", "/api/book/rename", body={"slug": slug, "title": SCRATCH + "-改名"})
    check("book 删除", "POST", "/api/book/delete", body={"slug": slug}, keys=("ok", "trashedTo"))

    print("\n== 模型组 / 笔记 / 同步 / 流水线（这一轮补的那几件）==")
    check("model-sets", "GET", "/api/model-sets", keys=("sets", "active", "purposes"))
    check("model-sets/resolve", "GET", "/api/model-sets/resolve",
          params={"slug": real_slug, "purpose": "writer"},
          keys=("purpose", "modelKey", "via"))
    check("model-sets/save(空名字)", "POST", "/api/model-sets/save", body={"name": "", "members": {}},
          ok=(400,), code_only=True, note="空名字必须被挡住")
    check("model-sets/activate(不存在)", "POST", "/api/model-sets/activate",
          body={"name": "根本不存在的组-自测"}, ok=(404,), code_only=True)
    check("notes", "GET", "/api/notes", params={"slug": real_slug}, keys=("items", "total"))
    check("note(空内容)", "POST", "/api/note", body={"slug": real_slug, "text": "  "},
          ok=(400,), code_only=True, note="空笔记不给存")
    check("note(不存在的 id)", "POST", "/api/note", body={"slug": real_slug, "id": 999999, "text": "x"},
          ok=(404,), code_only=True)
    check("sync/state", "GET", "/api/sync/state", params={"slug": real_slug}, keys=("openConflicts",))
    check("sync/changes", "GET", "/api/sync/changes", params={"slug": real_slug}, keys=("changed", "all"))
    check("sync/conflicts", "GET", "/api/sync/conflicts", params={"slug": real_slug}, keys=("items", "total"))
    check("sync/push(空 items)", "POST", "/api/sync/push",
          body={"slug": real_slug, "items": []}, keys=("results", "conflicts", "ok"))
    check("sync/push(不给 items)", "POST", "/api/sync/push", body={"slug": real_slug, "items": "乱写"},
          ok=(400,), code_only=True)
    check("sync/resolve(不存在的冲突)", "POST", "/api/sync/resolve", body={"id": 999999, "choice": "local"},
          ok=(404,), code_only=True)
    # 对端同步（本机后端 ↔ 服务器）：只验"本机这几个口在、形状对"；
    # 真连服务器的行为在 tools/verify_peer_sync.py（15/15）里量。
    check("peer/state", "GET", "/api/peer/state", params={"slug": real_slug},
          keys=("slug", "last_time", "last_result"))
    check("peer/conflicts", "GET", "/api/peer/conflicts", params={"slug": real_slug}, keys=("items",))
    check("peer/sync(缺地址)", "POST", "/api/peer/sync", body={"slug": real_slug, "direction": "pull"},
          ok=(400,), code_only=True, note="先填服务器地址")
    check("peer/sync(方向瞎写)", "POST", "/api/peer/sync",
          body={"slug": real_slug, "base": "127.0.0.1:1", "direction": "瞎写"},
          ok=(400,), code_only=True)
    check("peer/sync(地址不通)", "POST", "/api/peer/sync",
          body={"slug": real_slug, "base": "127.0.0.1:1", "password": "x", "direction": "pull"},
          ok=(502,), code_only=True, note="连不上 → 中文人话，不是 500 堆栈")
    check("peer/conflict(不存在)", "GET", "/api/peer/conflict", params={"id": 999999},
          ok=(404,), code_only=True)
    check("peer/resolve(pick 瞎写)", "POST", "/api/peer/resolve", body={"id": 1, "pick": "瞎写"},
          ok=(400,), code_only=True)
    wfs = check("workflows", "GET", "/api/workflows", params={"slug": real_slug},
                keys=("items", "kinds", "total"))
    check("workflows/save(没有步骤)", "POST", "/api/workflows/save", body={"name": "自测空的", "steps": []},
          ok=(400,), code_only=True)
    check("workflows/run(不存在)", "POST", "/api/workflows/run", body={"slug": real_slug, "id": 999999},
          ok=(404,), code_only=True)
    check("write/batch(不给章节)", "POST", "/api/write/batch",
          body={"slug": real_slug, "mode": "outline", "paths": []}, ok=(400,), code_only=True)
    check("write/batch(错模式)", "POST", "/api/write/batch",
          body={"slug": real_slug, "mode": "乱写", "paths": ["manuscript/不存在.md"]},
          ok=(400,), code_only=True)
    jobs = check("agent/jobs", "GET", "/api/agent/jobs", keys=("jobs",))
    jl = ((jobs or {}).get("jobs") or [])
    if jl:
        check("agent/jobs/{id}（每一步结果）", "GET", "/api/agent/jobs/" + str(jl[0]["jobId"]),
              keys=("jobId", "status", "progress"))
    else:
        check("agent/jobs/{id}（每一步结果）", "GET", "/api/agent/jobs/不存在", ok=(404,), code_only=True)

    print("\n== 字段名对齐：拿旧平台实测到的形状逐条比（A2/A10）==")
    golden_path = ROOT / "ref" / "golden" / "legacy-shapes.json"
    if golden_path.exists():
        golden = json.loads(golden_path.read_text("utf-8")).get("probes", {})
        for gname, probe in golden.items():
            if probe.get("status") != 200 or not probe.get("shape"):
                continue
            path = "/" + str(probe["path"]).lstrip("/")
            try:
                r = cli.get(path, timeout=30.0)
                got = r.json() if r.status_code == 200 else None
            except Exception as e:
                got = None
            want_shape = probe["shape"]
            if isinstance(want_shape, list):        # 旧平台返回数组的接口
                if r.status_code != 200 or not isinstance(got, list) or not got:
                    results.append({"name": f"形状·{gname}", "path": path, "status": "fail",
                                    "why": (f"HTTP {r.status_code}；期望非空数组，实际 "
                                            + (type(got).__name__ if got is not None else "空"))})
                    print(f"  ✗  形状·{gname}  期望非空数组")
                    continue
                want_shape, got = want_shape[0], got[0]
            if r.status_code != 200 or not isinstance(got, dict):
                results.append({"name": f"形状·{gname}", "path": path, "status": "fail",
                                "why": f"HTTP {r.status_code}，旧平台这里是 200 的对象"})
                print(f"  ✗  形状·{gname}  HTTP {r.status_code}")
                continue
            missing, extra = _shape_diff(want_shape, got)
            okrow = not missing
            results.append({"name": f"形状·{gname}", "path": path,
                            "status": "ok" if okrow else "fail",
                            "why": "" if okrow else "缺字段 " + ",".join(missing),
                            "note": ("多出来的字段（不算错）：" + ",".join(extra)) if extra else ""})
            print(f"  {'✓' if okrow else '✗'}  形状·{gname}"
                  + ("" if okrow else "  缺 " + ",".join(missing))
                  + (("  （多 " + ",".join(extra) + "）") if extra else ""))

    ok = len([r for r in results if r["status"] == "ok"])
    fail = [r for r in results if r["status"] == "fail"]
    skip = len([r for r in results if r["status"] == "skip"])
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE, "total": len(results),
           "ok": ok, "fail": len(fail), "skip": skip, "results": results}
    (ROOT / "docs" / "接口实测.json").write_text(json.dumps(out, ensure_ascii=False, indent=1),
                                                 encoding="utf-8")
    print(f"\n=== 共 {len(results)} 条：通过 {ok}，失败 {len(fail)}，跳过 {skip} ===")
    for r in fail:
        print("  ✗", r["name"], r.get("path"), r["why"])
    print("报告：docs/接口实测.json")
    cli.close()
    return 1 if fail else 0


import base64

_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

if __name__ == "__main__":
    sys.exit(main())
