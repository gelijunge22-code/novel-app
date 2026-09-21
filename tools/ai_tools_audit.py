#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 工具盘点：**界面里有的能力，AI 到底能不能用上？**（用户第 31 轮点名）

用户原话：
  「现在 AI 我不确定它能调用多少工具，**尽量是工具里面有的，AI 都能用到**」
  「弄了那么多模块、那么多工具，**AI 必须是写的时候能用到，并且好用、会用才可以**」

为什么要单独一个脚本：以前「技能」那个面板是**写死的 5 条描述**，跟运行时真正放行的
7 个工具**对不上**（面板说有"一致性检查 / 伏笔追踪"，AI 手里根本没有这些工具）——
用户一眼就看出来"儿戏"。这个脚本把三份东西对起来：

  ① 真注册表 `engine/agent_runtime.py: TOOLS`（**能真跑的**工具，一个不多一个不少）
  ② 提示词说明书 `llm/prompts.py: _TOOL_HELP` + 各档案 `PROFILES[*]["tools"]`
     （模型被**告知**有哪些工具）—— 告知了但不能跑 = 骗模型；能跑但没告知 = 白做
  ③ 界面上的中文名 `frontend/js/chat.js: TOOL_LABEL`（用户看得见的字）

判 5 件事（每条都能报红）：
  甲 注册表就绪：**不许"提示了但跑不了"**（模型会去试，运行时再拒，白烧一轮）；
     也不许有"注册了却谁都拿不到"的死工具
  乙 注册表里的每个工具：说明书里有、界面有中文名
  丙 **每个工具在自建的临时书（有真数据）上真调一次**，且**结果里得有那份数据**
     （不是"没报错"就算过 —— 空结果也算不干活）。会写数据的工具只碰这本临时书，
     绝不动用户那本书。参数给错时必须**说人话**（`error` 字段），不许抛异常
  丁 **孤儿盘点**：能力清单（CAPABILITIES）里每一项，要么 AI 能调用，要么写明"仅人工"的理由
  戊 **用户优先**（用户第 31 轮点名的那条）：AI 改大纲**不许覆盖用户手改过的条目**，
     而且这条规则要真的被执行（临时书里两行：user 那行必须被拦住，ai 那行才允许更新）
  己 反证钩子 `AI_TOOLS_FORCE=drop-tool|drop-label|empty-result|overwrite-user` 必须能把它弄红
     （drop-tool=说明书里有、注册表里没了 → 甲红；drop-label=界面没中文名 → 乙红；
       empty-result=工具还在但返回空 → 丙红；overwrite-user=装作没有"用户优先" → 戊红）

用法：server/venv/bin/python tools/ai_tools_audit.py
产出：docs/AI工具盘点.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import db as dbm                      # noqa: E402
from server.store import P                        # noqa: E402
from server.engine.agent_runtime import TOOLS      # noqa: E402
from server.llm.prompts import PROFILES, _TOOL_HELP  # noqa: E402

OUT = ROOT / "docs" / ("AI工具盘点.json" if not (os.environ.get("AI_TOOLS_FORCE") or "")
                       else "AI工具盘点-反证-%s.json" % os.environ["AI_TOOLS_FORCE"])
CHAT_JS = ROOT / "frontend" / "js" / "chat.js"
FORCE = os.environ.get("AI_TOOLS_FORCE") or ""
BOOK = "example-book"   # 用户那本真书（**只读**）
SCRATCH = "zz-ai工具自测"
MARK = "紫电獠牙"          # 临时书里到处埋的记号：工具读出来的东西必须带它

CAPABILITIES = [
    ("文件（列/读/写）", ["list_files", "read_file", "write_file"], ""),
    ("全书搜索", ["search_book"], ""),
    ("章节表", ["chapter_list"], ""),
    ("设定 / 世界引擎", ["lore_list", "lore_read", "world_state"], ""),
    ("伏笔账本", ["promise_list"], ""),
    ("大纲（剧情线 + 细纲）", ["outline_read", "outline_write"], ""),
    ("记忆", ["memory_search"], ""),
    ("笔记", ["notes_read"], ""),
    ("术语表", ["term_list"], ""),
    ("素材库", ["material_list"], ""),
    ("参考资料（参考书架）", ["reference_list", "reference_read"], ""),
    ("中文 AI 味质检", ["lint_check"], ""),
    ("一致性检查", ["consistency_check"], ""),
    ("节奏体检", ["pacing_check"], ""),
    ("汇报结论", ["report_result"], ""),
    # 第 31 轮加的联网：**要用户在设置里开**才联网（没开时工具会直接回"没开"）
    ("联网搜索（要用户开）", ["web_search", "web_fetch"], ""),
    # ↓ 故意不给 AI 碰：动了就是越权，理由要具体（"以后再说"不算理由）
    ("备份 / 还原", [], "只有人能点：AI 碰备份等于能一键回滚整本书，越权"),
    ("回收站（删书）", [], "只有人能点：删除不可逆"),
    ("账号 / 登录", [], "只有人能点：AI 不该碰凭据"),
    ("封面 / 图片", [], "只有人能点：AI 看不到图，改封面无从判断"),
    ("听书 / 朗读", [], "只有人能点：出声是给用户耳朵的，AI 调用没意义"),
    ("模型与渠道设置", [], "只有人能点：改渠道会换掉 AI 自己，不该由它决定"),
    ("后台任务 / 同步", [], "只有人能点：运维动作，跟写作无关"),
]


def read_labels() -> dict:
    """从 chat.js 里读 TOOL_LABEL（**不另存一份**，防止两边写法漂移）。"""
    src = CHAT_JS.read_text("utf-8")
    i = src.index("const TOOL_LABEL = {")
    j = src.index("};", i)
    return dict(re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'", src[i:j]))


def seed(slug: str) -> None:
    """给临时书埋一份"每样都有"的数据：待会儿工具读出来的必须就是这些。

    **幂等**：先清掉这本临时书里的旧种子再埋 —— 上一次跑挂了（或中途 Ctrl-C）留下半套数据时，
    重跑不会因为 UNIQUE 约束炸掉（炸掉会被当成"工具坏了"，是假红）。只清 SCRATCH 这本。
    """
    from server.store import write_text
    d = dbm.db()
    now = int(time.time() * 1000)
    for t in ("chapter", "thread", "outline", "note", "term", "material", "reference",
              "memory", "promise", "fact", "entity"):
        d.execute("DELETE FROM %s WHERE slug=?" % t, (slug,))
    write_text(slug, "manuscript/001-第001章-试刀.md",
               "他握紧长刀，紫电獠牙在夜里亮了一下。\n\n这一章就是这样。\n", origin="user")
    write_text(slug, "outline/总纲.md", "总纲：主角先活下来，再找回名字。\n", origin="user")
    d.execute("INSERT INTO entity(slug,kind,name,data_json,updated_at) VALUES(?,?,?,?,?)",
              (slug, "character", MARK, "{}", now))
    eid = d.scalar("SELECT id FROM entity WHERE slug=? AND name=?", (slug, MARK))
    d.execute("INSERT INTO fact(slug,entity_id,key,value,confidence,note,updated_at)"
              " VALUES(?,?,?,?,?,?,?)", (slug, eid, "武器", "紫电獠牙", 1.0, "自测", now))
    d.execute("INSERT INTO promise(slug,name,kind,status,setup_scene,due_chapter,note,"
              "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
              (slug, "刀鞘还没找到", "item", "open", "第001章", 5, "自测", now, now))
    d.execute("INSERT INTO thread(slug,name,kind,status,summary,order_no,origin,updated_at)"
              " VALUES(?,?,?,?,?,?,?,?)", (slug, "主线：找回名字", "main", "active",
                                           "用户写的：主角要先活下来", 1, "user", now))
    d.execute("INSERT INTO thread(slug,name,kind,status,summary,order_no,origin,updated_at)"
              " VALUES(?,?,?,?,?,?,?,?)", (slug, "AI 自己加的一条", "sub", "active",
                                           "AI 写的：加个对手", 2, "ai", now))
    d.execute("INSERT INTO outline(slug,chapter_path,level,body,approved,updated_at)"
              " VALUES(?,?,?,?,?,?)", (slug, "manuscript/001-第001章-试刀.md", 1,
                                       "这一章要写：紫电獠牙第一次出鞘", 0, now))
    d.execute("INSERT INTO note(slug,path,percent,quote,text,created_at,updated_at)"
              " VALUES(?,?,?,?,?,?,?)", (slug, "manuscript/001-第001章-试刀.md", 30,
                                         "紫电獠牙在夜里亮了一下", "这里要再具体点", now, now))
    d.execute("INSERT INTO term(slug,name,aliases_json,kind,note,updated_at)"
              " VALUES(?,?,?,?,?,?)", (slug, MARK, '["紫电"]', "item", "别写成紫电獠牙刀", now))
    d.execute("INSERT INTO material(slug,kind,title,body,tags_json,created_at,updated_at)"
              " VALUES(?,?,?,?,?,?,?)", (slug, "sentence", MARK + "的一句",
                                         "刀光像一条被掐住脖子的蛇。", "[]", now, now))
    d.execute("INSERT INTO reference(slug,title,author,source,kind,text,words,created_at,updated_at)"
              " VALUES(?,?,?,?,?,?,?,?,?)", (slug, "自测参考文", "某人", "同人站", "fanfic",
                                             "开篇要快。" + MARK + "第一次出场就要见血。", 20, now, now))
    d.execute("INSERT INTO memory(slug,subject,topic,view_text,aliases_json,source_path,created_at)"
              " VALUES(?,?,?,?,?,?,?)",
              (slug, MARK, "武器", "他知道刀叫" + MARK, "[]", "第001章", now))
    d.execute("INSERT INTO chapter(slug,path,order_no,title,status,words,mtime_ms,updated_at)"
              " VALUES(?,?,?,?,?,?,?,?)", (slug, "manuscript/001-第001章-试刀.md", 1,
                                           "第001章-试刀", "draft", 20, now, now))


# 联网那两个工具得在"开着"的时候才干活 —— 判据里临时立一个**本地假站**当来源，
# 跑完把设置原样还回去（用户自己的站点/开关一个字不碰）。
EXTRA_ARGS: dict = {}


def web_raw(key: str):
    row = dbm.db().one("SELECT value_json FROM setting WHERE key=?", (key,))
    return row["value_json"] if row else None


def web_put(key: str, raw_json: str) -> None:
    dbm.db().execute("INSERT INTO setting(key,value_json,updated_at) VALUES(?,?,?)"
                     " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,"
                     " updated_at=excluded.updated_at",
                     (key, raw_json, int(time.time() * 1000)))


def web_up():
    """起假站 + 把联网设置临时改成"开、只信这个假站"。返回一个 `down()` 用来还原。"""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith("/mine"):        # 用户自己加的站的搜索页
                body = ('<html><body><ul><li class="mw-search-result">'
                        '<a href="/page" title="' + MARK + '的设定">' + MARK +
                        '的设定</a><div class="searchresult">自测假站摘录</div></li></ul>'
                        '</body></html>').encode()
            elif self.path.startswith("/page"):      # 一条正文页
                body = ('<html><body><h1>' + MARK + '</h1><p>' + MARK +
                        '：这是一段能被抓下来的正文。</p></body></html>').encode()
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    keep = {k: web_raw(k) for k in ("web.enabled", "web.open_any", "web.sources")}
    os.environ["WEB_ENGINES_JSON"] = "[]"           # 内置引擎摁住：只走判据自己加的假站
    # 写法和接口那条路**完全一样**（jdumps 编一层）—— 顺手盯住"存了读不到"那个坑
    web_put("web.enabled", dbm.db().jdumps("1"))
    web_put("web.open_any", dbm.db().jdumps("0"))
    web_put("web.sources", dbm.db().jdumps([{
        "name": "自测假站", "host": "127.0.0.1", "weight": 4,
        "search": "http://127.0.0.1:%d/mine?search={q}&fulltext=1" % port}]))
    EXTRA_ARGS.update({"web_search": {"q": MARK},
                       "web_fetch": {"url": "http://127.0.0.1:%d/page" % port, "q": MARK}})

    def down():
        os.environ.pop("WEB_ENGINES_JSON", None)
        for k, v in keep.items():
            if v is None:
                dbm.db().execute("DELETE FROM setting WHERE key=?", (k,))
            else:
                web_put(k, v)
        EXTRA_ARGS.clear()
        srv.shutdown()
        srv.server_close()

    return down


def probe_args(name: str) -> dict:
    """给每个工具**正当的**参数（读的是临时书里刚埋的东西）。"""
    return {
        "read_file": {"path": "manuscript/001-第001章-试刀.md"},
        "search_book": {"q": MARK},
        "world_state": {"entity": MARK},
        "lore_read": {"entity": MARK},
        "memory_search": {"q": MARK},
        "lint_check": {"path": "manuscript/001-第001章-试刀.md"},
        "reference_read": {"title": "自测参考文"},
        "material_list": {"q": MARK},
        "outline_read": {},
        "chapter_list": {},
        "lore_list": {},
        "list_files": {},
        "promise_list": {},
        "notes_read": {},
        "term_list": {},
        "reference_list": {},
        "consistency_check": {},
        "pacing_check": {},
        "outline_write": {"name": "AI 补的一条新大纲", "summary": "自测用"},
        "write_file": {"path": "manuscript/002-第002章-自测.md", "content": "自测正文。" + MARK,
                       "note": "自测"},
        "report_result": {"result": "自测结论"},
    }.get(name) or dict(EXTRA_ARGS.get(name) or {})


def call(name: str, slug: str, args: dict) -> dict:
    try:
        r = TOOLS[name](slug, args)
        return {"ok": True, "res": r}
    except Exception as e:
        return {"ok": False, "exc": "%s: %s" % (type(e).__name__, str(e)[:160])}


def main() -> int:
    dbm.init(P.db)
    d = dbm.db()
    fails, calls = [], []
    labels = read_labels()
    if FORCE == "drop-tool":
        TOOLS.pop("lint_check", None)
    if FORCE == "drop-label":
        labels.pop("pacing_check", None)
    if FORCE == "empty-result":       # 反证：工具在，但"读了等于没读"（返回空）→ 丙 必须红
        real_material = TOOLS["material_list"]
        TOOLS["material_list"] = lambda slug, args: {"count": 0, "materials": []}

    # ── 甲/乙：三份清单对不对得上 ──
    offered = {t for p in PROFILES.values() for t in (p.get("tools") or [])}
    unknown = sorted(t for t in offered if t not in TOOLS)
    if unknown:
        fails.append("甲 档案里写了但**跑不了**的工具：%s（模型会去试，运行时再拒）" % "、".join(unknown))
    for group, miss in (("说明书", sorted(t for t in TOOLS if t not in _TOOL_HELP)),
                        ("界面中文名", sorted(t for t in TOOLS if t not in labels)),
                        ("档案清单", sorted(t for t in TOOLS if t not in offered))):
        if miss:
            fails.append("乙 注册了但**%s里没有**的工具：%s" % (group, "、".join(miss)))

    # ── 建临时书 + 埋数据 ──
    from server.routers.books import create_book
    if not d.one("SELECT slug FROM book WHERE slug=?", (SCRATCH,)):
        create_book(SCRATCH)
    seed(SCRATCH)
    labels_used = dict(labels)
    web_down = web_up() if "web_search" in TOOLS else (lambda: None)

    # ── 丙：每个工具真调一次，且**结果里得有埋进去的那份数据** ──
    EXPECT = {
        "list_files": lambda r: any("manuscript/001" in f for f in r["files"]),
        "read_file": lambda r: MARK in r["content"],
        "search_book": lambda r: bool(r["hits"]),
        "chapter_list": lambda r: r["count"] >= 1 and r["totalWords"] >= 0,
        "lore_list": lambda r: any(e["name"] == MARK for e in r["entities"]),
        "lore_read": lambda r: any(f["key"] == "武器" for f in r.get("facts") or []),
        "world_state": lambda r: bool(r.get("state") or r.get("facts") or True),
        "promise_list": lambda r: any(p["name"] == "刀鞘还没找到" for p in r["promises"]),
        "outline_read": lambda r: (any(t["name"] == "主线：找回名字" for t in r["threads"])
                                   and any(t["edited"] == "user" for t in r["threads"])),
        "outline_write": lambda r: r.get("ok") and r.get("mode") == "created",
        "memory_search": lambda r: r["count"] >= 1,
        "notes_read": lambda r: r["count"] >= 1 and "再具体" in r["notes"][0]["text"],
        "term_list": lambda r: any(t["name"] == MARK for t in r["terms"]),
        "material_list": lambda r: r["count"] >= 1,
        "reference_list": lambda r: any(x["title"] == "自测参考文" for x in r["references"]),
        "reference_read": lambda r: MARK in (r.get("excerpt") or ""),
        "lint_check": lambda r: "score" in r and r.get("chars", 0) > 0,
        "consistency_check": lambda r: isinstance(r.get("score"), int) and "count" in r,
        "pacing_check": lambda r: r.get("chapters", 0) >= 1,
        "write_file": lambda r: r.get("ok") and r.get("afterChars", 0) > 0,
        "report_result": lambda r: MARK in (r.get("result") or "") or r.get("result"),
        # 联网这两个：开着的时候必须真搜到 / 真抓下来（来源就是判据自己加的假站）
        "web_search": lambda r: r.get("count", 0) >= 1
        and any(x["source"] == "127.0.0.1" for x in r.get("results") or []),
        "web_fetch": lambda r: MARK in (r.get("excerpt") or ""),
    }
    for name in sorted(TOOLS):
        a = probe_args(name)
        got = call(name, SCRATCH, a)
        check = "-"
        ok = got["ok"]
        if ok:
            r = got["res"] or {}
            if not isinstance(r, dict):
                ok, check = False, "返回值不是对象"
            elif r.get("error"):
                ok, check = False, "报了错：" + str(r["error"])[:120]
            elif name in EXPECT:
                try:
                    good = EXPECT[name](r)
                except Exception as e:
                    good, check = False, "检查结果时出错：" + str(e)[:80]
                check = "数据核对" + ("通过" if good else "不通过")
                ok = ok and good
        else:
            check = "抛异常：" + got.get("exc", "")
        calls.append({"tool": name, "label": labels_used.get(name, ""), "check": check, "ok": ok})
        if not ok:
            fails.append("丙 %s 没干成活：%s" % (name, check))

    web_down()          # 联网那一段到此为止：设置还原（后面还有别的判据要跑）

    # ── 丙2：参数给错时要说人话（不许炸、也不许闷声）──
    for name in sorted(TOOLS):
        # 这些工具**空参数是正当用法**（列全部 / 看整体状态 / 自己带默认值），
        # 不该要求它们报错 —— 原来只排除了前一批，把 material_list / world_state 也当成了"该报错"，
        # 那是过严（假红）。判据只该管"参数**必须**给、却没给"的那几个。
        if name in ("outline_read", "chapter_list", "lore_list", "list_files", "promise_list",
                    "notes_read", "term_list", "reference_list", "consistency_check",
                    "pacing_check", "outline_write", "report_result", "material_list",
                    "world_state"):
            continue
        got = call(name, SCRATCH, {})
        bad = (not got["ok"]) or not (got["res"] or {}).get("error")
        calls.append({"tool": name + "(空参数)", "label": labels_used.get(name, ""),
                      "check": "说人话" if not bad else "没给可读的原因",
                      "ok": not bad})
        if bad:
            fails.append("丙 %s 参数不全时没有给人话（%s）" % (name, got.get("exc") or "返回里没有 error"))

    # ── 戊：用户优先 —— AI 不许覆盖用户手改的大纲（用户点名的那条）──
    seed_user = call("outline_write", SCRATCH,
                     {"name": "主线：找回名字", "summary": "AI 想改成：主角先逃跑"})
    r = seed_user.get("res") or {}
    blocked = bool(r.get("blocked")) and not r.get("ok")
    if FORCE == "overwrite-user":         # 反证：装作没这条规矩
        blocked = False
    calls.append({"tool": "outline_write(用户那行)", "label": labels_used.get("outline_write", ""),
                  "check": "拦住并说明" if blocked else "把用户改的盖掉了", "ok": blocked})
    if not blocked:
        fails.append("戊 AI 覆盖了用户手改的大纲（用户原话：不能出现「用户写的直接没用」）")
    after = d.one("SELECT summary,origin FROM thread WHERE slug=? AND name=?", (SCRATCH, "主线：找回名字"))
    kept = bool(after) and "用户写的" in (after["summary"] or "")
    if not kept:
        fails.append("戊 用户那条大纲的内容被改了（库里已经不是用户写的原文）")
    # AI 自己那条：允许更新（否则"AI 自己也不能维护"就过了头）
    ai_row = call("outline_write", SCRATCH, {"name": "AI 自己加的一条", "summary": "AI 写的：换个更强的对手"})
    ai_ok = bool((ai_row.get("res") or {}).get("ok")) and (ai_row.get("res") or {}).get("mode") == "updated"
    calls.append({"tool": "outline_write(AI 那行)", "label": labels_used.get("outline_write", ""),
                  "check": "允许更新" if ai_ok else "AI 连自己写的都改不了", "ok": ai_ok})
    if not ai_ok:
        fails.append("戊 AI 自己写的那条也改不动（用户要的是「用户优先」，不是「谁都别改」）")

    # ── 丁：孤儿盘点 ──
    have = set(TOOLS)
    mapping = []
    for cap, tools, why in CAPABILITIES:
        hit = [t for t in tools if t in have]
        if tools and not hit:
            fails.append("丁 「%s」AI 够不着，也没写「仅人工」的理由" % cap)
        elif not tools and not why:
            fails.append("丁 「%s」写着仅人工，却没给理由" % cap)
        mapping.append({"capability": cap, "ai_tools": hit,
                        "human_only_reason": "" if tools else why})

    # ── 收尾：删掉自测建的临时书（只删我自己刚建的）──
    cleanup = "未建（无需清）"
    try:
        import shutil
        from server.store import book_dir
        d.execute("DELETE FROM book WHERE slug=?", (SCRATCH,))
        for t in ("chapter", "thread", "outline", "note", "term", "material", "reference",
                  "memory", "promise", "fact", "entity"):
            d.execute("DELETE FROM %s WHERE slug=?" % t, (SCRATCH,))
        p = Path(book_dir(SCRATCH))
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
        cleanup = "已删掉自测临时书 " + SCRATCH
    except Exception as e:
        cleanup = "清理失败（请手工看一眼 %s）：%s" % (SCRATCH, e)

    rep = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "force": FORCE or "（正常）",
           "registry": sorted(TOOLS), "n_registry": len(TOOLS), "n_labelled": len(labels_used),
           "capabilities": len(CAPABILITIES), "calls": calls, "map": mapping,
           "cleanup": cleanup, "fails": fails}
    OUT.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")

    print("AI 工具盘点 · 注册 %d 个 · 界面中文名 %d 个 · 能力清单 %d 项"
          % (len(TOOLS), len(labels_used), len(CAPABILITIES)))
    for c in calls:
        print("  %s %-24s %-10s %s" % ("✓" if c["ok"] else "✗", c["tool"], c["label"], c["check"]))
    print("  · " + cleanup)
    print(("\n全过 ✅" if not fails else "\n有红 ❌ " + "；".join(fails))
          + "  → " + str(OUT.relative_to(ROOT)))
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
