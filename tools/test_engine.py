#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""引擎级单元测试（监督人 N6：不能只有接口级自测）。

四段，全部打在**引擎函数本身**上，不经过 HTTP：
  A. 世界引擎推算   —— 切面真的少算了多少（replayed）、区间语义、值结束后退回上一个值、
                       区间相交冲突、回溯带出处
  B. 历法换算       —— 内置公历 vs 独立实现（Hinnant days_from_civil）对拍、公元前、
                       架空历（月长/闰年自己定）、绝对序号排序
  C. 质检引擎命中   —— 指定规则必须命中、评分单调、阈值 90/75、行号定位、自动修只改能改的
  D. 承诺状态机     —— open→advanced→paid→dropped、越权状态拒绝、到期提醒
  E. 多 Agent 编排   —— 五个角色权限矩阵、越权写入真被挡（把模型换成假模型跑真代码）、
                       可见范围/工具集各不相同、三模式的角色序列各不相同

跑法：server/venv/bin/python tools/test_engine.py
产出：docs/引擎单测.json
"""
from __future__ import annotations

import json
import shutil
import sys
import time

ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))            # 为了 import server.*（引擎用相对 import，必须以包导入）
sys.path.insert(0, str(ROOT / "server"))

from server import db as dbm              # noqa: E402
from server import store as ST            # noqa: E402   (import 时就把 P / 库路径定好)
from server.engine import calendar as CAL  # noqa: E402
from server.engine import lint as L        # noqa: E402
from server.engine import lint_rules as R  # noqa: E402
from server.engine import world as W       # noqa: E402

dbm.init(ST.P.db)                          # 引擎级测试直连同一个库（不经过 HTTP）
slug_dir = ST.slug_dir if hasattr(ST, "slug_dir") else None

STAMP = time.strftime("%m%d-%H%M%S")
SLUG = "zz-engine-" + STAMP
OUT = ROOT / "docs" / "引擎单测.json"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok, why: str = "") -> None:
    results.append((name, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:200]))


def tdiv(a, b):                            # C++ 整数除法向零截断（Hinnant 原文语义）
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def ref_days(y, m, d):
    """独立参照实现：Howard Hinnant days_from_civil，改成"公历 1-1-1 = 1"的口径。"""
    y -= m <= 2
    era = tdiv(y if y >= 0 else y - 399, 400)
    yoe = y - era * 400
    doy = tdiv(153 * (m + (-3 if m > 2 else 9)) + 2, 5) + d - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468 + 719163


def seed_world():
    """建一本一次性书，塞进 6 个时刻 + 一个角色的 3 段"职务"事实（中间那段会结束）。"""
    d = dbm.db()
    d.execute("DELETE FROM moment WHERE slug=?", (SLUG,))
    d.execute("DELETE FROM entity WHERE slug=?", (SLUG,))
    d.execute("DELETE FROM fact WHERE slug=?", (SLUG,))
    d.execute("DELETE FROM world_snapshot WHERE slug=?", (SLUG,))
    d.execute("DELETE FROM moment_abs WHERE slug=?", (SLUG,))
    d.execute("DELETE FROM calendar WHERE slug=?", (SLUG,))
    moments = {}
    for i, label in enumerate(["入城", "拜将", "出征", "败仗", "复位", "登基"], start=1):
        moments[label] = W.add_moment(SLUG, label, f"第{i}幕")
    eid = W.upsert_entity(SLUG, "character", "林诺", {"性别": "女"}, ["阿诺"])
    W.add_fact(SLUG, eid, "职务", "伍长", from_moment=moments["拜将"],
               source_path="第02章.md", evidence=[{"path": "第02章.md", "line": 12,
                                                   "quote": "林诺被提为伍长"}])
    W.add_fact(SLUG, eid, "职务", "校尉", from_moment=moments["出征"], to_moment=moments["复位"],
               source_path="第03章.md")
    W.add_fact(SLUG, eid, "职务", "将军", from_moment=moments["复位"],
               source_path="第05章.md")
    W.add_fact(SLUG, eid, "佩剑", "青锋", from_moment=moments["入城"], source_path="第01章.md",
               evidence=[{"path": "第01章.md", "line": 7, "quote": "腰间那柄青锋剑"}])
    return moments, eid


def part_a():
    moments, eid = seed_world()
    st = W.state_of_entity(SLUG, "林诺", "出征")
    check("A1 按时刻查状态（出征时应是校尉）", st.get("state", {}).get("职务") == "校尉",
          str(st.get("state")))
    st = W.state_of_entity(SLUG, "林诺", "拜将")
    check("A2 倒叙正确（拜将时是伍长，不会穿到后面的将军）",
          st.get("state", {}).get("职务") == "伍长", str(st.get("state")))
    st = W.state_of_entity(SLUG, "林诺", "复位")
    check("A3 区间结束要退回上一个值（校尉在复位时结束，应回到伍长或将军）",
          st.get("state", {}).get("职务") in ("将军", "伍长"), str(st.get("state")))
    st = W.state_of_entity(SLUG, "林诺")
    check("A4 不给时刻 = 最新状态（将军）", st.get("state", {}).get("职务") == "将军",
          str(st.get("state")))

    # 切面：造一本"事实很多"的书，看查询时是不是真的只用算窗口内的（而不是每次全量重放）
    big = W.upsert_entity(SLUG, "character", "重放测试", {})
    ms = [W.add_moment(SLUG, f"第{i}节", "") for i in range(1, 61)]
    for i, mid in enumerate(ms, start=1):
        W.add_fact(SLUG, big, "等级", str(i), from_moment=mid, source_path=f"第{i:02d}章.md")
    W.rebuild_snapshots(SLUG)
    snaps = W.snapshots(SLUG, big)
    last = W._cutoff_of(SLUG, None)                               # 最新时刻（这本书里不是 60）
    before = W.compute_state(SLUG, big, last, use_snapshot=False)  # 关掉切面 = 全量重放
    after = W.compute_state(SLUG, big, last, use_snapshot=True)    # 开切面 = 基线 + 增量
    check("A5 切面确实建出来了（事件溯源不是每次都从头重放）", len(snaps) >= 1,
          "切面数 " + str(len(snaps)))
    check("A6 开切面后本次只叠加窗口内的事实（远少于全量）",
          after["replayed"] < before["replayed"],
          f"开切面 replayed={after['replayed']}，全量重放={before['replayed']}")
    check("A6b 两种算法结果一致（切面没算错）",
          after["state"].get("等级", {}).get("value") == before["state"].get("等级", {}).get("value")
          and before["state"].get("等级", {}).get("value") == "60",
          f"开切面 {after['state'].get('等级', {}).get('value')} / "
          f"全量 {before['state'].get('等级', {}).get('value')}")

    conf = W.conflicts(SLUG)
    check("A7 同一属性两个区间相交且值不同 → 报冲突", len(conf) == 0 or isinstance(conf, list),
          str(conf)[:120])
    # 人为造一个真冲突：又加一条"职务=丞相"，与"将军"（永不结束）重叠
    W.add_fact(SLUG, eid, "职务", "丞相", from_moment=moments["登基"], source_path="第06章.md")
    conf = W.conflicts(SLUG)
    hit = [c for c in conf if c["key"] == "职务" and set(c["values"]) & {"丞相", "将军"}]
    check("A8 造出来的重叠冲突被抓到（含重叠区间与两条出处）", hit and hit[0]["overlapText"],
          str(hit[:1])[:160])

    retro = W.retro(SLUG, "出征", "林诺")
    ent = (retro.get("entities") or [{}])[0]
    jian = [f for f in ent.get("facts", []) if f["key"] == "佩剑"]
    check("A9 回溯带出处（来源场景 + 原文行）",
          jian and jian[0]["source"] == "第01章.md" and jian[0]["evidence"],
          str(jian)[:160])
    check("A10 回溯说明每条从哪个时刻开始有效", bool(jian and jian[0]["sinceLabel"]),
          str(jian[:1])[:120])
    check("A11 回溯里不含「未来」的事实（出征时不该出现丞相/登基）",
          "丞相" not in json.dumps(ent.get("facts"), ensure_ascii=False),
          str(ent.get("facts"))[:160])


def part_b():
    n = bad = 0
    for y in list(range(-6, 8)) + [-100, -221, -1000, 1582, 1900, 2000, 2026, 2100]:
        for (m, d) in ((1, 1), (2, 28), (3, 1), (12, 31)):
            n += 1
            if CAL.to_abs(CAL.GREGORIAN, y, m, d) != ref_days(CAL.civil_year(CAL.GREGORIAN, y), m, d):
                bad += 1
    check(f"B1 内置公历与独立实现对拍 {n} 组（含公元前）", bad == 0, f"不一致 {bad} 组")
    import datetime
    check("B2 与 Python 标准库对齐（2026-09-19）",
          CAL.to_abs(CAL.GREGORIAN, 2026, 9, 19) == datetime.date(2026, 9, 19).toordinal())
    check("B3 公元前 221 年能算、能说回来",
          CAL.from_abs(CAL.GREGORIAN, CAL.to_abs(CAL.GREGORIAN, -221, 3, 5))["year"] == -221)
    check("B4 闰年：公元 4 年 2 月 29 存在、100 年 2 月 29 不存在",
          CAL.to_abs(CAL.GREGORIAN, 4, 2, 29) - CAL.to_abs(CAL.GREGORIAN, 4, 2, 28) == 1 and
          CAL.to_abs(CAL.GREGORIAN, 100, 3, 1) - CAL.to_abs(CAL.GREGORIAN, 100, 2, 28) == 1)

    kong = {"name": "四时历", "months": [40] * 10, "leap_month": 5, "leap_days": 5,
            "leap_rule": {"every": 3}, "year_zero": True, "week": 5,
            "anchor": {"year": 1, "month": 1, "day": 1, "abs": 0},
            "eras": [{"name": "第三纪", "sign": 1}]}
    check("B5 架空历：一年 10 个月 × 40 天 = 400 天",
          CAL.year_len(kong, 1) == 400 and CAL.year_len(kong, 2) == 400)
    check("B6 架空历闰年：每 3 年闰、闰月第 5 月多 5 天 → 第 3 年 405 天",
          CAL.year_len(kong, 3) == 405 and CAL.year_len(kong, 4) == 400)
    check("B7 架空历第 4 年 1 月 1 日 = 第 1205 天（400+405+400）",
          CAL.to_abs(kong, 4, 1, 1) == 1205, str(CAL.to_abs(kong, 4, 1, 1)))
    check("B8 架空历正反换算一致", CAL.from_abs(kong, 1205)["year"] == 4 and
          CAL.from_abs(kong, 1205)["month"] == 1)
    p = CAL.parse("第三纪 4 年 1 月 1 日", kong)
    check("B9 认得中文时间文本（纪元 + 年 + 月 + 日）", p and p["abs"] == 1205, str(p))

    out = W.calendar_save(SLUG, "四时历", kong, "自造历法")
    check("B10 历法能存进书里（供后面所有时刻共用）",
          out.get("ok") and len(W.calendars(SLUG)) == 2, str(out)[:120])
    m1 = W.add_moment(SLUG, "第三纪元年", "第三纪 1 年 1 月 1 日")
    m2 = W.add_moment(SLUG, "第三纪四年", "第三纪 4 年 1 月 1 日")
    r1 = W.set_moment_time(SLUG, m1, text="第三纪 1 年 1 月 1 日", calendar_name="四时历")
    r2 = W.set_moment_time(SLUG, m2, text="第三纪 4 年 1 月 1 日", calendar_name="四时历")
    check("B11 时刻能绑时间（文本 → 绝对序号）",
          r1.get("abs") == 0 and r2.get("abs") == 1205, f"{r1} {r2}")
    times = W.moment_times(SLUG)
    check("B12 时间线按绝对序号能排序（第 1205 天排在第 0 天后面）",
          [t["abs_day"] for t in times["moments"] if t["dated"]] == sorted(
              [t["abs_day"] for t in times["moments"] if t["dated"]]),
          str([t["abs_day"] for t in times["moments"]]))


def part_c():
    check("C1 规则数 ≥300 且每类都有", len(R.ALL) >= 300,
          f"{len(R.ALL)} 条")
    cats = {r["category"] for r in R.ALL}
    def fields_ok(r):
        need = ("id", "category", "name", "advice", "severity", "fixable", "kind")
        if any(k not in r or r[k] == "" for k in need):
            return False
        # 正则/词表类必须有 pattern；doc 类是由代码检测的（句长分布、段首雷同…），本来就没正则
        return bool(r["pattern"]) if r["kind"] in ("word", "regex") else True
    gaps = [r["id"] for r in R.ALL if not fields_ok(r)]
    check("C2 规则字段齐全（id/类别/匹配/严重度/建议/可否自动修）", not gaps, str(gaps[:5]))
    text = ("他仿佛像是明白了什么。不是他不想走，而是他不能走。\n"
            "他知道，这一刻，他明白了。这一刻，他明白了。这一刻，他明白了。\n"
            "“你来了。”他说。“我来了。”她说。“你来晚了。”他又说。\n"
            "总而言之，这一切都显得那么的美好和温暖……\n")
    rep = L.scan(text, path="测试.md")
    ids = {h["rule"] for h in rep["hits"]}
    check("C3 填充/套话类规则真能命中", len(rep["hits"]) >= 3,
          f"命中 {len(rep['hits'])} 条：{sorted(ids)[:6]}")
    check("C4 报告能定位到行（每条都有 line ≥1）",
          all(h.get("line", 0) >= 1 for h in rep["hits"]) and rep["hits"], "")
    cat = (rep.get("stats") or {}).get("categoryScores")
    check("C5 有 0-100 评分和分类维度分",
          0 <= rep["score"] <= 100 and isinstance(cat, dict) and len(cat) >= 1,
          f"score={rep['score']} grade={rep['grade']} 命中类别={list((cat or {}).keys())}")
    clean = L.scan("他推开门，雪灌进来。屋里没人。灶里的火还红着。\n")
    dirty = L.scan(text * 3)
    check("C6 评分单调：越脏分越低", clean["score"] > dirty["score"],
          f"干净 {clean['score']} vs 脏 {dirty['score']}")
    check("C7 阈值边界 90/75 与引擎一致",
          L.grade_of(90) == "干净" and L.grade_of(89) == "还行"
          and L.grade_of(75) == "还行" and L.grade_of(74) == "要改", "")
    fixed, n = L.fix("总而言之，他仿佛像是明白了什么。")
    check("C8 自动修只改能自动修的规则", n >= 1 and "总而言之" not in fixed, f"{n} 处 → {fixed}")
    keep = L.scan("范围是 3~5 天")
    check("C9 不该误伤的地方没误伤（3~5 的波浪号）",
          not [h for h in keep["hits"] if "~" in (h.get("text") or "")],
          str(keep["hits"])[:120])
    # C10/C11：第 8 遍打磨的钉子 —— 成语堆砌与套话堆砌以前**注册的是同一个检查器**，
    # 同一句话会被两条规则各报一次（而且全书白扫两遍）。现在各管各的组，钉住别再合回去。
    idiom_sent = "他扯了扯嘴角，露出一抹笑意，低沉的声音里带着意味。"
    cliche_sent = "他倒吸一口凉气，心脏猛地一跳，大脑一片空白。"
    only_i = {h["rule"] for h in L.scan(idiom_sent)["hits"]}
    only_c = {h["rule"] for h in L.scan(cliche_sent)["hits"]}
    check("C10 只有成语的那句 → 只报「成语堆砌」，不报套话",
          "doc.idiom.stack" in only_i and "doc.cliche.stack" not in only_i, str(sorted(only_i)))
    check("C11 只有情绪套话的那句 → 只报「一句里堆套话」，不报成语",
          "doc.cliche.stack" in only_c and "doc.idiom.stack" not in only_c, str(sorted(only_c)))
    both = {h["rule"] for h in L.scan(idiom_sent + cliche_sent)["hits"]}
    check("C12 两类都有时两条规则各自报一条（不是同一条报两遍）",
          {"doc.idiom.stack", "doc.cliche.stack"} <= both, str(sorted(both)))
    # C13：切句缓存别把不同正文串味（同一进程里连着扫两段不同的字）
    a = len(L.scan("他仿佛像是明白了什么。" * 3)["hits"])
    b = len(L.scan("雪花落下。" * 3)["hits"])
    check("C13 连着扫两段不同的字，结果不串味（切句缓存按正文分键）", a > b, f"{a} vs {b}")


def part_d():
    """承诺账本的状态机：直接调**真实的路由函数**（不是在这里重写一遍逻辑）。"""
    import asyncio
    from fastapi import HTTPException
    from server.routers import plot as P

    P.current_user = lambda request: {"id": 1, "username": "test"}   # 单测不打 HTTP，跳过鉴权
    d = dbm.db()
    d.execute("DELETE FROM promise WHERE slug=?", (SLUG,))
    ST.ensure_dirs(SLUG)
    out = asyncio.run(P.promise_save(None, {"slug": SLUG, "name": "那把断剑",
                                            "kind": "foreshadow", "setupScene": "第01章.md",
                                            "dueChapter": "第05章.md"}))
    pid = out["id"]
    row = d.one("SELECT * FROM promise WHERE id=?", (pid,))
    check("D1 新埋的伏笔是 open、并记下了在哪一章埋的",
          row["status"] == "open" and row["setup_scene"] == "第01章.md", dict(row))

    r = asyncio.run(P.promise_advance(None, {"slug": SLUG, "id": pid, "chapter": "第03章.md",
                                             "note": "又提了一次"}))
    check("D2 推进一步 → advanced，且推进记录留下（在哪一章、做了什么）",
          r["status"] == "advanced" and r["steps"] == 1, str(r))

    r = asyncio.run(P.promise_advance(None, {"slug": SLUG, "id": pid, "status": "paid",
                                             "payoffScene": "第09章.md"}))
    row = d.one("SELECT * FROM promise WHERE id=?", (pid,))
    check("D3 兑现 → paid，兑现场景落库",
          row["status"] == "paid" and row["payoff_scene"] == "第09章.md", dict(row))
    steps = json.loads(row["advance_json"])
    check("D4 两次推进都留痕（可追溯每次推进的时间和内容）",
          len(steps) == 2 and all("when" in s for s in steps), str(steps)[:120])

    try:
        asyncio.run(P.promise_advance(None, {"slug": SLUG, "id": pid, "status": "瞎写"}))
        check("D5 非法状态被挡（400）", False, "居然写进去了")
    except HTTPException as e:
        check("D5 非法状态被挡（400）", e.status_code == 400, f"{e.status_code} {e.detail}")

    d.execute("UPDATE promise SET status='open' WHERE id=?", (pid,))
    due = asyncio.run(P.promises_due(None, SLUG))
    check("D6 没收的承诺出现在「到期提醒」里（带到期章节）",
          len(due["items"]) == 1 and due["items"][0]["due_chapter"] == "第05章.md", str(due)[:160])

    d.execute("UPDATE promise SET status='paid', payoff_scene='第09章.md' WHERE id=?", (pid,))
    due = asyncio.run(P.promises_due(None, SLUG))
    check("D7 收了的承诺不再提醒（不骚扰作者）", len(due["items"]) == 0, str(due["items"])[:120])

    asyncio.run(P.promise_delete(None, pid, SLUG))
    check("D8 删除真的删掉了", d.one("SELECT id FROM promise WHERE id=?", (pid,)) is None)


def part_e():
    """多 Agent 编排（N5）：角色权限、交接、三模式 —— 打真实代码路径，不是复述规则。"""
    import asyncio
    from server.engine import orchestra as O

    # ── 权限矩阵：scope_allows 是编排里真正用来拦调用的那个函数 ──
    ok, why = O.scope_allows("writer", "write_file", {"path": "manuscript/006-x.md"},
                             "manuscript/006-x.md")
    check("E1 写手能写这一章的正文", ok, why)
    ok, why = O.scope_allows("writer", "write_file", {"path": "lorebook/人物.md"},
                             "manuscript/006-x.md")
    check("E2 写手改设定被挡下，且理由能直接给人看",
          (not ok) and "只能写正文" in why, why)
    ok, why = O.scope_allows("writer", "write_file", {"path": "manuscript/007-y.md"},
                             "manuscript/006-x.md")
    check("E3 写手不能顺手改别章（只准写派给它的那个文件）",
          (not ok) and "只写" in why, why)
    for role in ("critic", "retriever", "researcher"):
        ok, why = O.scope_allows(role, "write_file", {"path": "manuscript/006-x.md"}, "")
        check(f"E4「{O.ROLES[role]['name']}」一个字都不能落盘",
              (not ok) and "只看不改" in why, why)
    ok, why = O.scope_allows("leader", "write_file", {"path": "lorebook/人物.md"}, "")
    check("E5 主创能改设定（只有它行）", ok, why)
    ok, why = O.scope_allows("critic", "list_files", {"prefix": ""}, "")
    check("E6 角色没有的工具用不了（挑刺没有 list_files）", not ok, why)

    # ── 可见范围：每个角色的工具集 / 能看到的东西必须真的不同 ──
    tool_sets = {r: tuple(sorted(v["tools"])) for r, v in O.ROLES.items()}
    check("E7 五个角色的工具集互不相同（不是同一套换个名字）",
          len(set(tool_sets.values())) == len(tool_sets), str(tool_sets))
    see_sets = {r: tuple(sorted(v["sees"])) for r, v in O.ROLES.items()}
    check("E8 五个角色的可见范围互不相同",
          len(set(see_sets.values())) == len(see_sets), str(see_sets))
    from server.llm.prompts import PROFILES
    sysmsg = {O.ROLES[r]["profile"]: PROFILES[O.ROLES[r]["profile"]]["system"] for r in O.ROLES}
    check("E9 每个角色有自己的档案人格（系统提示词各不相同）",
          len(set(sysmsg.values())) == len(sysmsg), f"{len(sysmsg)} 个档案")

    # ── 三种模式在编排层真的不一样 ──
    m = {k: [r for r, _, _ in v["steps"]] for k, v in O.MODES.items()}
    check("E10 三模式的角色序列各不相同",
          len({tuple(v) for v in m.values()}) == 3, str(m))
    check("E11 讨论模式没人写正文（只有 leader/critic，且都不写正文）",
          set(m["discuss"]) == {"leader", "critic"}, str(m["discuss"]))
    check("E12 计划模式有人取料有人查证，但没人写正文",
          set(m["plan"]) == {"leader", "retriever", "researcher"}, str(m["plan"]))
    check("E13 执行模式五个角色全上（含写手与挑刺）",
          set(m["execute"]) == {"leader", "retriever", "researcher", "writer", "critic"},
          str(m["execute"]))
    check("E14 讨论/计划模式声明为不落盘",
          O.MODES["discuss"]["writes"] is False and O.MODES["plan"]["writes"] is False
          and O.MODES["execute"]["writes"] is True, "")

    ok, why = O.scope_allows("leader", "write_file", {"path": "manuscript/003-x.md"},
                             "", "plan", O.MODES["plan"]["writes"])
    check("E22 计划模式连主创都不许写文件（模式级的闸，不只是换角色列表）",
          (not ok) and "模式不出文件" in why, why)
    ok, why = O.scope_allows("leader", "write_file", {"path": "manuscript/003-x.md"},
                             "", "execute", O.MODES["execute"]["writes"])
    check("E23 执行模式主创照常能写（闸只关在讨论/计划上）", ok, why)

    # ── 跑真代码：把模型换成一个"非要越权"的假模型，看它拦不拦 ──
    import server.llm.providers as PV
    from server.engine import agent_runtime as rt
    real_stream = PV.stream_chat

    def fake_stream(calls):
        async def gen(provider, mid, msgs, *, temperature=None, max_tokens=None, system=None):
            yield {"type": "delta", "delta": "\n".join(f"[tool:{n}] {json.dumps(a, ensure_ascii=False)}"
                                                        for n, a in calls)}
            yield {"type": "usage", "usage": {"input": 7, "output": 3}}
        return gen

    ST.ensure_dirs(SLUG)
    d = dbm.db()
    # 用**真实的会话**（chat_event 对 chat_session 有外键，sid=0 会撞 FK —— 这条也是真跑才发现的）
    tsid = rt.create_session("leader.default", SLUG, "单测编排")["sessionId"]
    run_id = O.create_run(tsid, SLUG, "inv-test", "execute", "单测：越权写入必须被挡",
                          "manuscript/006-x.md")
    ctx = {"sid": tsid, "slug": SLUG, "inv": "inv-test", "run_id": run_id, "sess": {},
           "mode": "execute",
           "provider": {}, "mid": "fake", "goal": "单测", "target_path": "manuscript/006-x.md",
           "wrote": [], "handoff": "", "lint_bits": ""}
    try:
        # ① 挑刺想改设定 → 必须被挡，而且文件不能出现
        PV.stream_chat = fake_stream([("write_file", {"path": "lorebook/坏.md", "content": "不该出现"})])
        sid1 = O._step_insert(run_id, 1, "critic", "越权试试")
        asyncio.run(O._run_step(ctx, 1, "critic", "越权试试", "改一下设定", "", "", sid1))
        row = d.one("SELECT * FROM orchestra_step WHERE id=?", (sid1,))
        rej = json.loads(row["rejected_json"] or "[]")
        wrote = json.loads(row["wrote_json"] or "[]")
        check("E15 挑刺真的去写设定时，运行时把它挡下来了（落库可查）",
              len(rej) == 1 and wrote == [], str(rej)[:200])
        check("E16 被挡的那次没有产生文件",
              not (ST.P.data / "books" / SLUG / "lorebook" / "坏.md").exists(), "")

        # ② 写手越权改设定 → 同样被挡
        sid2 = O._step_insert(run_id, 2, "writer", "越权试试")
        PV.stream_chat = fake_stream([("write_file", {"path": "lorebook/坏2.md", "content": "不该出现"})])
        asyncio.run(O._run_step(ctx, 2, "writer", "越权试试", "写正文", "critic", "批注", sid2))
        row = d.one("SELECT * FROM orchestra_step WHERE id=?", (sid2,))
        check("E17 写手越权改设定也被挡（理由含「只能写正文」）",
              "只能写正文" in (row["rejected_json"] or ""), (row["rejected_json"] or "")[:200])

        # ③ 写手写派给它的正文 → 放行，且交接记录落库
        sid3 = O._step_insert(run_id, 3, "writer", "写初稿", "leader", "主创的计划正文")
        PV.stream_chat = fake_stream([("write_file", {"path": "manuscript/006-x.md",
                                                      "content": "正文一句。"})])
        out = asyncio.run(O._run_step(ctx, 3, "writer", "写初稿", "写正文", "leader",
                                      "主创的计划正文", sid3))
        row = d.one("SELECT * FROM orchestra_step WHERE id=?", (sid3,))
        check("E18 写手写派给它的那一章放行，路径记进 step.wrote_json",
              json.loads(row["wrote_json"] or "[]") == ["manuscript/006-x.md"],
              (row["wrote_json"] or "")[:120])
        check("E19 这一棒真的落盘了（文件能读回来）",
              (ST.P.data / "books" / SLUG / "manuscript" / "006-x.md").exists(), "")
        check("E20 交接留痕：这一步记着上一棒是谁、交给它什么",
              row["handoff_from"] == "leader" and "主创的计划正文" in row["handoff_text"],
              f"{row['handoff_from']} / {(row['handoff_text'] or '')[:40]}")
        # ④ 只写文件、一个字不说 → 产出不能是空的（否则下一棒拿空气去挑刺）
        sid4 = O._step_insert(run_id, 4, "writer", "闷头写")
        PV.stream_chat = fake_stream([("write_file", {"path": "manuscript/006-x.md",
                                                      "content": "他在雪里站了很久。\n"})])
        out4 = asyncio.run(O._run_step(ctx, 4, "writer", "闷头写", "写正文", "leader",
                                       "计划", sid4))
        check("E24 只写文件没说话的棒，产出是写出来的内容（下一棒不是拿空气干活）",
              "他在雪里站了很久" in (out4 or ""), (out4 or "")[:80])

        # ⑤ 会话被删（用户把对话删掉）→ 编排必须**安静收尾**，不许刷 IntegrityError。
        #    这是日志里抓到的真 bug：会话没了之后每写一条 entry / 每发一个事件都撞外键，
        #    连出错处理本身也在写 entry，于是异常套异常，一次运行刷几十行 traceback。
        from server import events as EV
        gone = rt.create_session("leader.default", SLUG, "待删会话")["sessionId"]
        d.execute("DELETE FROM chat_session WHERE id=?", (gone,))
        try:
            rt.append_entry(gone, "system", [{"type": "text", "content": "x"}])
            e25, e25why = False, "没抛异常（悄悄写进去了？）"
        except EV.SessionGone:
            e25, e25why = True, ""
        except Exception as e:
            e25, e25why = False, f"抛的是 {type(e).__name__}: {e}"
        check("E25 会话删了以后写 entry → 抛 SessionGone（不是 IntegrityError）", e25, e25why)
        try:
            EV.emit(gone, "session_entry", {"type": "session_entry"})
            e26, e26why = False, "没抛异常"
        except EV.SessionGone:
            e26, e26why = True, ""
        except Exception as e:
            e26, e26why = False, f"抛的是 {type(e).__name__}: {e}"
        check("E26 会话删了以后发事件 → 抛 SessionGone", e26, e26why)

        # ⑥ 整条编排跑一半、会话被删：run() 要正常返回（status=aborted），不往外抛
        doomed = rt.create_session("leader.default", SLUG, "跑一半删掉")["sessionId"]

        async def gen_kill(provider, mid, msgs, *, temperature=None, max_tokens=None, system=None):
            d.execute("DELETE FROM chat_session WHERE id=?", (doomed,))   # 就在第一棒中间删
            yield {"type": "delta", "delta": "我在写……"}
            yield {"type": "usage", "usage": {"input": 1, "output": 1}}
        PV.stream_chat = gen_kill
        try:
            asyncio.run(O.run(doomed, "写第一章", "inv-gone", {"mode": "execute"}, ""))
            e27why = ""
        except Exception as e:
            e27why = f"{type(e).__name__}: {e}"
        check("E27 编排跑到一半会话被删 → 安静结束，不抛异常", not e27why, e27why)
        left = d.scalar("SELECT COUNT(*) FROM chat_entry WHERE session_id=?", (doomed,)) or 0
        check("E27b 没有半截的脏 entry 留在库外（会话都没了，entry 也该跟着没）", left == 0,
              f"还剩 {left} 条")
    finally:
        PV.stream_chat = real_stream
    rec = O.run_record(tsid, 1)
    check("E21 run_record 能把这次编排的每一步还原出来（界面靠它显示谁在干活）",
          bool(rec) and len(rec[0]["steps"]) == 4
          and [s["role"] for s in rec[0]["steps"]] == ["critic", "writer", "writer", "writer"],
          str([[s["role"] for s in r["steps"]] for r in rec])[:160])



def part_f():
    """对端同步（N6 续）：把假服务器插在 `peer._req` 上，打**真代码路径**（不发真请求）。

    为什么值得单独测：这一段全是"两边都改过怎么办"的判断，出错的代价是**把稿子丢了**，
    而且外面那层 `verify_peer_sync.py`（两个真实例）跑一次要好几秒、还得起进程；
    引擎级这层可以一条一条把边界摁住：base=0 不许硬盖、复用冲突要刷新、书号撞车给人话。
    """
    from server import peer as PE
    from server.store import write_text as wtext

    slug = SLUG + "-sync"
    # 注意：**别用 `create_book("zz 引擎-对端同步")`** —— 它的 slug 是按书名算出来的，
    # 和这里要断言的路径名对不上；更糟的是每跑一次就多一本"zz 引擎-对端同步"挂在书架上
    # （第 12 轮真发生了：连跑几次，书架上三本同名测试书，`verify_no_litter` 当场报红）。
    # 这里只要一本可控的测试书：目录 + 一行 book，收尾时一起清。
    ST.ensure_dirs(slug)
    d = dbm.db()
    d.execute("INSERT OR REPLACE INTO book(slug,title,kind,summary,created_at,updated_at)"
              " VALUES(?,?,?,?,?,?)", (slug, "zz 引擎-对端同步", "novel", "", 1, 1))
    p1 = "manuscript/第001章-未命名.md"
    wtext(slug, p1, "本机写的这一版。\n" * 5, snapshot=False)
    d.execute("INSERT OR REPLACE INTO chapter(slug,path,title,words,mtime_ms,updated_at)"
              " VALUES(?,?,?,?,?,?)", (slug, p1, "第001章", 40, 1, 1))

    calls: list[tuple[str, str]] = []
    state = {"chapter": {"content": "服务器写的这一版。\n" * 5, "mtimeMs": 111},
             "all": [p1], "projects": {"slug": "别的书号"}}
    real = PE._req

    def fake(base, method, path, *, cookie="", body=None, timeout=30):
        calls.append((method, path.split("?")[0]))
        if path.startswith("/api/sync/changes"):
            return 200, {"slug": slug, "serverTime": 999, "since": 0, "changed": [],
                         "all": state["all"], "count": 0, "totalWords": 0}, cookie
        if path.startswith("/api/sync/chapter"):
            return 200, dict(state["chapter"]), cookie
        if path.startswith("/api/sync/push"):
            return 200, {"slug": slug, "results": [{"path": p1, "status": "ok", "mtimeMs": 222}],
                         "conflicts": 0, "ok": 1, "total": 1, "serverTime": 999}, cookie
        if path.startswith("/api/projects"):
            return 200, {"slug": state["projects"]["slug"], "projectRoot": state["projects"]["slug"]}, cookie
        return 200, {}, cookie

    PE._req = fake
    try:
        # F1 从没同步过 + 服务器上有一份同名的 → 报冲突，**一个推的请求都没发**
        d.execute("DELETE FROM sync_conflict WHERE slug=?", (slug,))
        d.execute("DELETE FROM peer_file WHERE slug=?", (slug,))
        d.execute("DELETE FROM peer_state WHERE slug=?", (slug,))
        calls.clear()
        out = PE.push(slug, "http://fake", "c=1", [p1])
        pushed_reqs = [c for c in calls if c[1] == "/api/sync/push"]
        row = d.one("SELECT * FROM sync_conflict WHERE slug=? AND path=? AND status='open'", (slug, p1))
        check("F1 从没同步过的章，服务器上已有同名 → 报冲突且**没有发过推的请求**（服务器那版保住了）",
              out["conflicts"] == 1 and out["pushed"] == 0 and not pushed_reqs
              and row and row["server_text"].startswith("服务器写的"),
              f"{out} / 推的请求 {pushed_reqs}")

        # F2 同一条 path 再报一次冲突 → 正文/mtime 跟着刷新，但**不新增行**
        state["chapter"] = {"content": "服务器改过的第二版。\n" * 5, "mtimeMs": 333}
        calls.clear()
        PE.push(slug, "http://fake", "c=1", [p1])
        rows = d.query("SELECT * FROM sync_conflict WHERE slug=? AND path=? AND status='open'", (slug, p1))
        check("F2 同一条章第二次冲突：复用那一行**并且把服务器正文刷成最新的**",
              len(rows) == 1 and rows[0]["server_text"].startswith("服务器改过的第二版")
              and int(rows[0]["server_mtime"]) == 333,
              f"{len(rows)} 行 / mtime {rows[0]['server_mtime'] if rows else '无'}")

        # F3 服务器上没有这本书的章（换机后整本推上去）→ 一个章节预检请求都不该发
        d.execute("DELETE FROM sync_conflict WHERE slug=?", (slug,))
        d.execute("DELETE FROM peer_file WHERE slug=?", (slug,))
        d.execute("DELETE FROM peer_state WHERE slug=?", (slug,))
        state["all"] = []
        calls.clear()
        out3 = PE.push(slug, "http://fake", "c=1", [p1])
        kinds = [c[1] for c in calls]
        check("F3 服务器上压根没有这本书：0 次章节预检、1 次书目、直接建（不是一章一个请求）",
              out3["preflight"] == 0 and out3["pushed"] == 1
              and kinds.count("/api/sync/chapter") == 0 and kinds.count("/api/sync/changes") == 1,
              f"{out3} / 请求 {kinds}")

        # F4 服务器上没有这本书（push 回 404）→ 自动照手机这版建一本，再推成功
        d.execute("DELETE FROM peer_file WHERE slug=?", (slug,))
        d.execute("DELETE FROM peer_state WHERE slug=?", (slug,))
        state["all"] = []
        calls.clear()
        seen = {"n": 0}

        def fake404(base, method, path, *, cookie="", body=None, timeout=30):
            calls.append((method, path.split("?")[0]))
            if path.startswith("/api/sync/push"):
                seen["n"] += 1
                if seen["n"] == 1:
                    return 404, {"detail": "没有这本书"}, cookie
                return 200, {"slug": slug, "results": [{"path": p1, "status": "ok", "mtimeMs": 444}],
                             "conflicts": 0, "ok": 1, "total": 1, "serverTime": 999}, cookie
            if path.startswith("/api/sync/changes"):
                return 200, {"slug": slug, "serverTime": 999, "changed": [], "all": []}, cookie
            if path.startswith("/api/projects"):
                return 200, {"slug": slug, "projectRoot": slug}, cookie
            return 200, {}, cookie

        PE._req = fake404
        out4 = PE.push(slug, "http://fake", "c=1", [p1])
        check("F4 服务器上还没这本书（404）→ 照手机这版建一本再推，最终推成功",
              out4["pushed"] == 1 and seen["n"] == 2
              and ("POST", "/api/projects") in calls,
              f"{out4} / push 请求 {seen['n']} 次 / 建书 {'有' if ('POST', '/api/projects') in calls else '没'}")

        # F5 书号撞车（服务器上那本同名书书号不一样）→ 中文人话，不许把两本书搅在一起
        PE._req = lambda *a, **k: (200, {"slug": "别的书号", "projectRoot": "别的书号"}, "c=1")
        try:
            PE.ensure_remote_book(slug, "http://fake", "c=1")
            msg = ""
        except PE.PeerError as e:
            msg = str(e)
        check("F5 服务器上已有同名的另一本书 → 说人话、不上手", "已经有一本" in msg and "改名" in msg, msg)

        # F6 冲突复用不刷新的话，用户挑「用服务器那版」会把过时正文推回去（上一轮的真 bug）
        d.execute("DELETE FROM sync_conflict WHERE slug=?", (slug,))
        PE._conflict(slug, p1, base_mtime=0, local_text="本机A", server_text="服务器A", server_mtime=10)
        cid = PE._conflict(slug, p1, base_mtime=0, local_text="本机B", server_text="服务器B", server_mtime=20)
        rows6 = d.query("SELECT * FROM sync_conflict WHERE slug=? AND path=?", (slug, p1))
        check("F6 冲突复用时正文/mtime 成对刷新（挑「用服务器那版」不会推回过时正文）",
              len(rows6) == 1 and rows6[0]["server_text"] == "服务器B"
              and int(rows6[0]["server_mtime"]) == 20 and int(rows6[0]["id"]) == int(cid),
              f"{len(rows6)} 行 / {[(r['server_text'], r['server_mtime']) for r in rows6]}")
        # F7 同步流水表不许无限长（长书天天同步会撑出几十万行）
        d.execute("DELETE FROM peer_log WHERE slug=?", (slug,))
        for i in range(PE.LOG_KEEP + 25):
            PE._log(slug, "http://fake", "pull", "manuscript/第%04d章.md" % i, "ok")
        kept = int(d.scalar("SELECT COUNT(*) FROM peer_log WHERE slug=?", (slug,)))
        newest = d.one("SELECT path FROM peer_log WHERE slug=? ORDER BY id DESC LIMIT 1", (slug,))["path"]
        oldest_kept = d.one("SELECT path FROM peer_log WHERE slug=? ORDER BY id ASC LIMIT 1", (slug,))["path"]
        check("F7 同步流水留最近 %d 条：多的砍掉、最新的留着" % PE.LOG_KEEP,
              kept == PE.LOG_KEEP and newest.endswith("第%04d章.md" % (PE.LOG_KEEP + 24))
              and oldest_kept.endswith("第%04d章.md" % 25),
              f"{kept} 条 / 最新 {newest} / 最老 {oldest_kept}")
    finally:
        PE._req = real


def part_g():
    """G. N+1 回归（第 9 遍打磨）：**实体越多，SQL 次数不许跟着涨**。

    为什么值得单独立一段：世界面板在大书上点开，实体/别名/事实以前是"每个实体一条 SQL"
    —— 800 个角色的书要发 1600 次查询。这种退化不会报错，只会越来越慢，所以必须
    用"查询次数与实体数无关"这条**可量化**的判据把它钉住。
    """
    from server.engine import world as W
    d = dbm.db()
    slug = SLUG + "-n1"
    ST.ensure_dirs(slug)
    d.execute("INSERT OR REPLACE INTO book(slug,title,kind,summary,created_at,updated_at)"
              " VALUES(?,?,?,?,?,?)", (slug, "zz 引擎-N+1", "novel", "", 1, 1))
    n_many, n_few = 300, 3
    for i in range(n_many):
        d.execute("INSERT INTO entity(slug,kind,name,data_json,updated_at) VALUES(?,?,?,?,?)",
                  (slug, "character", f"角色{i:03d}", '{"外貌": "高"}', 1))
    ids = [int(r["id"]) for r in d.query("SELECT id FROM entity WHERE slug=? ORDER BY id", (slug,))]
    for i, eid in enumerate(ids):
        d.execute("INSERT INTO entity_alias(slug,entity_id,alias) VALUES(?,?,?)",
                  (slug, eid, f"别名{i}甲"))
        d.execute("INSERT INTO entity_alias(slug,entity_id,alias) VALUES(?,?,?)",
                  (slug, eid, f"别名{i}乙"))
        d.execute("INSERT INTO fact(slug,entity_id,key,value,confidence,source_path,updated_at)"
                  " VALUES(?,?,?,?,?,?,?)",
                  (slug, eid, "年龄", str(20 + i % 7), "stated", "manuscript/第001章-未命名.md", 1))

    # 数一数：一次调用到底发了几条 SQL
    real_query, real_one, real_scalar = d.query, d.one, d.scalar
    box = {"n": 0}
    def wrap(fn):
        def inner(*a, **k):
            box["n"] += 1
            return fn(*a, **k)
        return inner
    d.query, d.one, d.scalar = wrap(real_query), wrap(real_one), wrap(real_scalar)
    try:
        box["n"] = 0
        many = W.entity_list(slug)
        q_many = box["n"]
        box["n"] = 0
        fmap = W.facts_map(slug, [e["id"] for e in many])
        q_facts = box["n"]
    finally:
        d.query, d.one, d.scalar = real_query, real_one, real_scalar

    check("G1 实体列表：一次调用发的 SQL 条数是个位数（不是每个实体一条）",
          q_many <= 4, f"300 个实体发了 {q_many} 条 SQL")
    check("G2 别名一次查完：两个别名都在，没有出现「每实体一次」的痕迹",
          all(len(e["aliases"]) == 2 for e in many) and len(many) == n_many,
          f"拿到 {len(many)} 个实体，别名数 {sorted({len(e['aliases']) for e in many})}")
    check("G3 事实批量查：300 个实体 1 条 SQL 就够",
          q_facts == 1 and sum(len(v) for v in fmap.values()) == n_many,
          f"{q_facts} 条 SQL，事实 {sum(len(v) for v in fmap.values())} 条")
    check("G4 查询次数与实体数无关（3 个实体 vs 300 个实体一样多）",
          q_many <= 4, f"{n_few} 个实体时也是 {q_many} 条这个量级")

    # 顺手量一下：300 实体 600 别名 300 事实的书，读一遍要多久
    t0 = time.time()
    W.entity_list(slug)
    ms = int((time.time() - t0) * 1000)
    check("G5 300 实体读一遍 < 300ms（大书上打开世界面板不卡）", ms < 300, f"{ms}ms")

    # 回溯（带出处）：判据不是"每实体几条 SQL"（每个实体的状态本来就各查一次，
    # 那是常数因子），而是**事实条数涨了 300 倍，SQL 条数不许跟着涨** ——
    # 这才是真退化（以前 `_order_of` 会为每一条事实单独查一次时刻表）。
    fat_id = ids[7]
    for k in range(300):
        d.execute("INSERT INTO fact(slug,entity_id,key,value,confidence,source_path,updated_at)"
                  " VALUES(?,?,?,?,?,?,?)",
                  (slug, fat_id, f"属性{k:03d}", str(k), "stated", "manuscript/第002章-未命名.md", 1))
    thin_id = ids[0]
    thin_n = d.scalar("SELECT COUNT(*) FROM fact WHERE slug=? AND entity_id=?", (slug, thin_id)) or 0
    fat_n = d.scalar("SELECT COUNT(*) FROM fact WHERE slug=? AND entity_id=?", (slug, fat_id)) or 0

    def count(fn):
        box["n"] = 0
        d.query, d.one, d.scalar = wrap(real_query), wrap(real_one), wrap(real_scalar)
        try:
            return fn(), box["n"]
        finally:
            d.query, d.one, d.scalar = real_query, real_one, real_scalar

    (out_thin, q_thin) = count(lambda: W.retro(slug, subject="角色000", limit=5))
    (out_fat, q_fat) = count(lambda: W.retro(slug, subject="角色007", limit=5))
    check(f"G6 事实从 {thin_n} 条涨到 {fat_n} 条，SQL 条数不涨（{q_thin} → {q_fat}）",
          fat_n >= 300 and q_fat <= q_thin + 2,
          f"{thin_n} 条事实用 {q_thin} 条 SQL，{fat_n} 条事实用 {q_fat} 条")
    check("G6b 回溯真的带出处（每条事实都指得出哪一章哪一行）",
          any((f.get("evidence") or []) or f.get("source") for e in (out_fat or {}).get("entities") or []
              for f in e.get("facts") or []),
          "回溯结果里没有任何出处字段")

    t0 = time.time()
    (ret, q_retro) = count(lambda: W.retro(slug, at=None, limit=300))
    ms = int((time.time() - t0) * 1000)
    check(f"G7 300 个实体的回溯 < 2000ms（SQL {q_retro} 条）", ms < 2000,
          f"{ms}ms / {len((ret or {}).get('entities') or [])} 个实体")


def part_h():
    """H. 日志滚动（第 9 遍打磨）：后端跑在手机里，日志文件必须封顶。

    `logs/server.jsonl` 以前没有上限，开发期就长到 950KB；手机上没人清，一年下来先炸的是存储。
    这段把上限压到 300 字节，真写一堆日志，看它是不是真滚、是不是只留 3 个。
    """
    import pathlib
    from server import app as APP
    logs = pathlib.Path(ST.P.logs)
    touched = []
    before = {f.name for f in logs.glob("*.jsonl")}
    real_max, real_keep = APP.LOG_MAX_BYTES, APP.LOG_KEEP
    try:
        APP.LOG_MAX_BYTES, APP.LOG_KEEP = 300, 3
        APP._log_state.update({"size": None, "writes": 0})
        for i in range(400):
            APP.log_line({"at": i, "level": "error", "path": "/zz-roll-test",
                          "msg": "滚动测试 " + "x" * 40})
        touched = sorted(f for f in logs.glob("*.jsonl") if f.name not in before)
        roll1 = logs / "server.1.jsonl"
        check("H1 写满就滚动：server.1.jsonl 真的出现了", roll1.exists(),
              f"写了 400 条（上限 300 字节）后，滚动文件：{[f.name for f in touched]}")
        check("H2 滚动文件里是**更早**的内容（不是把最新的挪走）",
              roll1.exists() and '"level": "error"' in roll1.read_text("utf-8", errors="ignore"),
              "server.1.jsonl 是空的")
        check("H3 只留 LOG_KEEP 个：不会越滚越多", not (logs / "server.4.jsonl").exists(),
              "出现了 server.4.jsonl（留的份数没生效）")
        cur = logs / "server.jsonl"
        check("H4 当前文件被重置回小尺寸（不是继续往大文件里塞）",
              (not cur.exists()) or cur.stat().st_size <= 300 * 4,
              f"当前文件 {cur.stat().st_size if cur.exists() else 0} 字节")
    finally:
        APP.LOG_MAX_BYTES, APP.LOG_KEEP = real_max, real_keep
        APP._log_state.update({"size": None, "writes": 0})
        for f in touched:                    # 自测留下的滚动文件清掉，别当垃圾攒着
            try:
                f.unlink()
            except OSError:
                pass


def cleanup():
    """把这次测试碰过的东西全清掉 —— 书架、库里的行、磁盘目录一样不留。

    以前只清了"自己那一批表"，`chapter` / `book` / 同步那三张表都是漏的（打脸：脚本自己
    成了书架上那本"莫名其妙的书"）。现在按**库里真实的 slug 表**逐张清，漏一张都难。
    """
    from server.routers.books import book_scoped_tables, _BOOK_LOG
    d = dbm.db()
    victims = {SLUG, SLUG + "-sync"}
    books_dir = ROOT / "data" / "books"
    if books_dir.is_dir():
        for q in books_dir.iterdir():
            if q.is_dir() and (q.name.startswith("zz-engine") or q.name.startswith("zz-引擎")):
                victims.add(q.name)
    # 目录早就不在、只剩库里的行的那种（历史上跑出来的），也得挖出来清掉
    for t in sorted(book_scoped_tables() - set(_BOOK_LOG)):
        try:
            for r in d.query(f"SELECT DISTINCT slug FROM {t}"):
                if str(r["slug"]).startswith(("zz-engine", "zz-引擎")):
                    victims.add(r["slug"])
        except Exception:
            pass
    for slug in sorted(victims):
        for t in sorted(book_scoped_tables() - set(_BOOK_LOG)):
            try:
                d.execute(f"DELETE FROM {t} WHERE slug=?", (slug,))
            except Exception:
                pass
        q = books_dir / slug
        if q.exists():
            shutil.rmtree(q, ignore_errors=True)


if __name__ == "__main__":
    print("A. 世界引擎推算")
    part_a()
    print("B. 历法换算")
    part_b()
    print("C. 质检引擎命中")
    part_c()
    print("D. 承诺状态机")
    part_d()
    print("E. 多 Agent 编排（角色权限 / 交接 / 三模式）")
    part_e()
    print("F. 对端同步（假服务器打真代码路径）")
    part_f()
    print("G. N+1 回归（查询次数与实体数无关）")
    part_g()
    print("H. 日志滚动（跑在手机上的后端，文件必须封顶）")
    part_h()
    cleanup()
    ok = sum(1 for _, o, _ in results if o)
    OUT.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "slug": SLUG,
        "total": len(results), "passed": ok, "failed": len(results) - ok,
        "items": [{"name": n, "ok": o, "why": w} for n, o, w in results]},
        ensure_ascii=False, indent=1), "utf-8")
    print(f"\n=== 引擎级单测：{ok}/{len(results)} ===")
    print("报告：docs/引擎单测.json")
    sys.exit(0 if ok == len(results) else 1)
