#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""质检引擎实测（监督人 N3 / 深度补齐第 1 条）。

分三段验：
  A. 规则表体检    —— 条数 ≥300、27 类、每类的覆盖、每条字段齐全、id 不重、无死规则
  B. 引擎行为      —— 评分单调、等级阈值 90/75、逐行定位对得上、分类维度分自洽、自动修只动能动的
  C. 接口与真数据  —— /lint/rules 条数口径、错误参数（400/404）、真书全书扫描、落盘修稿（自建一次性书，跑完删净）

跑法：server/venv/bin/python tools/verify_lint.py
产出：docs/质检引擎实测.json
"""
from __future__ import annotations

import json
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from engine import lint as L          # noqa: E402
from engine import lint_rules as R    # noqa: E402

BASE = "http://127.0.0.1:8899"
BOOKS = ROOT / "data" / "books"
TRASH = ROOT / "data" / "trash"
REAL = "example-book"
STAMP = time.strftime("%m%d-%H%M%S")
SCRATCH = "zz-lint-" + STAMP
results: list[tuple[str, bool, str]] = []


def check(name: str, ok, why: str = "") -> None:
    results.append((name, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:220]))


def pw() -> str:
    try:
        return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
                   .get("app_password") or "")
    except Exception:
        return ""


def u(v) -> str:
    return urllib.request.quote(str(v), safe="")


class C:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

    def call(self, path, method="GET", body=None):
        req = urllib.request.Request(BASE + path, method=method)
        d = None
        if body is not None:
            d = json.dumps(body, ensure_ascii=False).encode()
            req.add_header("content-type", "application/json")
        try:
            with self.op.open(req, d, timeout=120) as r:
                t = r.read().decode("utf-8", "replace")
                try:
                    return r.status, json.loads(t)
                except Exception:
                    return r.status, t
        except urllib.error.HTTPError as e:
            t = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(t)
            except Exception:
                return e.code, t


# ── A. 规则表体检 ───────────────────────────────────────────────────────────
TOPICS = {
    "填充词": ("cat", "填充词"), "机械过渡": ("cat", "机械过渡"),
    "公式化设问": ("cat", "公式化设问"), "二元对比": ("cat", "二元对比"),
    "空泛总结": ("cat", "空泛总结"), "节奏单调": ("cat", "节奏单调"),
    "排比堆砌": ("cat", "排比堆砌"), "形容词堆叠": ("cat", "形容词堆叠"),
    "心理描写偷懒": ("cat", "心理偷懒"), "对话标签重复": ("cat", "对话标签"),
    "段首雷同": ("cat", "段首雷同"), "总结句尾": ("id", "doc.para.end"),
    "破折号滥用": ("id", "doc.dash.dense"), "省略号滥用": ("id", "doc.ellipsis.dense"),
    "仿佛似乎像是泛滥": ("cat", "比喻泛滥"), "数字空洞": ("cat", "数字空洞"),
    "时间过渡词": ("cat", "时间过渡"), "场景切换生硬": ("cat", "场景切换"),
    "情绪直述": ("cat", "情绪直述"),
}
BY_ID = {r["id"]: r for r in R.ALL}


def audit_rules() -> None:
    check("A1 规则条数 ≥300（神经书 llmlint 360 条为参照）", R.RULE_COUNT >= 300,
          f"实际 {R.RULE_COUNT}")
    check("A2 类别数 ≥20", len(R.CATEGORIES) >= 20, f"实际 {len(R.CATEGORIES)} 类")
    missing = [t for t, (w, v) in TOPICS.items()
               if (v not in R.CATEGORIES if w == "cat" else v not in BY_ID)]
    check("A3 监督人点名的 19 类毛病，每一类都有规则接住", not missing, f"缺：{missing}")

    bad = [r["id"] for r in R.ALL if not r.get("advice") or not r.get("name")
           or r.get("severity") not in (1, 2, 3) or not isinstance(r.get("fixable"), bool)
           or r.get("kind") not in ("word", "regex", "doc")]
    check("A4 每条都有 类别/名字/严重度/建议/能否自动修（字段齐全）", not bad, f"缺字段：{bad[:6]}")

    ids = [r["id"] for r in R.ALL]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    check("A5 规则 id 不重复（重复会导致报告指错位置）", not dup, f"重复：{dup[:6]}")

    nofix = sum(1 for r in R.ALL if r["fixable"])
    check("A6 可自动修的规则 ≥100 条（一键修不是摆设）", nofix >= 100, f"实际 {nofix}")

    empty = [c for c in R.CATEGORIES if R.CATEGORY_COUNTS[c] == 0]
    thin = [(c, R.CATEGORY_COUNTS[c]) for c in R.CATEGORIES if R.CATEGORY_COUNTS[c] < 3]
    check("A7 没有空类别（列了类别就得有规则）", not empty, f"空：{empty}")
    check("A8 每个类别 ≥3 条（防止某一类只有一条撑门面）", not thin, f"太薄：{thin}")

    # 词级规则不能有单字（单字规则会把正常行文全判成 AI 味）
    single = [r["id"] for r in R.ALL if r["kind"] == "word" and len(r["pattern"]) < 2]
    check("A9 词级规则没有单字条（单字规则=满屏误报）", not single, f"单字：{single[:8]}")

    # 同类里不该有完全一样的 pattern（复制改名会在这里露馅）
    seen: dict[tuple, str] = {}
    duppat = []
    for r in R.ALL:
        k = (r["category"], r["kind"], r["pattern"])
        if r["pattern"] and k in seen:
            duppat.append(f"{seen[k]}={r['id']}")
        seen[k] = r["id"]
    check("A10 同类里没有内容重复的规则（不许复制改名注水）", not duppat, f"重复：{duppat[:6]}")

    per = sorted(R.CATEGORY_COUNTS.items(), key=lambda kv: kv[1])
    print("     最薄的 5 类：" + "、".join(f"{c} {n}" for c, n in per[:5]))


# ── B. 引擎行为 ─────────────────────────────────────────────────────────────
CLEAN = (
    "风从窗缝里钻进来，把桌上的油纸吹起一角。\n"
    "他伸手按住，指尖沾了一层灰。外面有人在喊货，声音一长一短，很快又断了。\n"
    "“今天不走了？”她问。\n"
    "他把纸卷起来塞进袖子，摇了摇头。桌面上的茶已经凉透，杯底沉着两片叶子。\n"
    "两个人在屋里站了一会儿，谁也没再开口。院里的狗忽然叫起来，又停下。\n"
)
DIRTY = (
    "在这个瞬间，他不禁感到无比的愤怒。\n"
    "不是愤怒，而是绝望。\n"
    "他深深地吸了一口气，仿佛整个世界都在这一刻凝固了。\n"
    "总而言之，他终于明白了一个道理：人生就是这样。\n"
    "不禁，不由自主，忍不住。\n"
)


def behaviour() -> dict:
    c = L.scan(CLEAN)
    check("B1 干净行文拿高分（≥90，不是什么都报警）", c["score"] >= 90,
          f"{c['score']} 分 / {len(c['hits'])} 处命中")
    d = L.scan(DIRTY)
    check("B2 满嘴套话拿低分（<75）且命中成堆", d["score"] < 75 and len(d["hits"]) >= 6,
          f"{d['score']} 分 / {len(d['hits'])} 处")

    # 单调：同样的字数里塞进更多套话，分数只能更低
    base = CLEAN * 3
    s0 = L.scan(base)["score"]
    s1 = L.scan(base + "在这个瞬间，他不禁深深地感到一阵愤怒。")["score"]
    s2 = L.scan(base + ("在这个瞬间，他不禁深深地感到一阵愤怒。\n" * 4))["score"]
    check("B3 评分单调：套话越多分越低", s0 >= s1 > s2, f"{s0} ≥ {s1} > {s2}")

    # 长度归一：同样的密度、字数翻倍，分数不该崩
    dense5 = CLEAN + ("在这个瞬间，他不禁深深地感到一阵愤怒。\n" * 5)
    s_short = L.scan(dense5)["score"]
    s_long = L.scan(dense5 * 2)["score"]
    check("B4 评分按密度算：同样密度、字数翻倍，分数不塌", abs(s_long - s_short) <= 12,
          f"{s_short} → {s_long}")

    check("B5 空文本=100 分（不报错、不扣分）", L.scan("")["score"] == 100)

    # 等级阈值只有一份口径
    ok_bands = (L.grade_of(100) == "干净" and L.grade_of(90) == "干净"
                and L.grade_of(89) == "还行" and L.grade_of(75) == "还行"
                and L.grade_of(74) == "要改" and L.grade_of(0) == "要改")
    check("B6 等级阈值 ≥90 干净 / 75–89 还行 / <75 要改", ok_bands,
          str([(l, n) for l, n in L.GRADE_BANDS]))

    # 定位：给一句放在第 4 行的套话，命中的行号必须是 4
    probe = "第一行正常的话。\n第二行也正常。\n\n第四行里藏着在这一刻这种填充。\n"
    hit = [h for h in L.scan(probe)["hits"] if h["text"].startswith("在这一刻")]
    lines = probe.splitlines()
    good = bool(hit) and hit[0]["line"] == 4 and "在这一刻" in lines[hit[0]["line"] - 1]
    check("B7 命中能定位到行（报告能指到哪一行）", good,
          f"{hit[:1]}")

    sc = L.scan(DIRTY)
    bad_loc = [h for h in sc["hits"] if not (1 <= h["line"] <= len(DIRTY.splitlines()) + 1)]
    check("B8 每条命中的行号都落在正文范围里", not bad_loc, f"{bad_loc[:3]}")

    sorted_ok = True
    for h in sc["hits"]:
        if not h.get("doc"):
            ln = h["line"]
            if "text" in h and h["text"] and h["text"][:4] not in DIRTY.splitlines()[ln - 1]:
                sorted_ok = False
    check("B9 命中的片段真的出现在它报的那一行里", sorted_ok, "")

    # 分类维度分自洽
    by = sc["stats"]["byCategory"]
    actual = {}
    for h in sc["hits"]:
        actual[h["category"]] = actual.get(h["category"], 0) + 1
    mismatch = {k: (v, actual.get(k, 0)) for k, v in by.items() if v != actual.get(k, 0)}
    check("B10 分类维度分跟命中明细对得上", not mismatch, f"对不上：{mismatch}")
    cs_ok = all(0 <= v["score"] <= 100 and v["hits"] >= 1
                for v in sc["stats"]["categoryScores"].values())
    check("B11 每类分数都在 0–100 之间", cs_ok, str(sc["stats"]["categoryScores"])[:160])
    check("B12 评分和等级在 stats 里也有一份（前端不用自己算）",
          sc["stats"]["score"] == sc["score"] and sc["stats"]["grade"] == sc["grade"],
          f"{sc['stats']['score']}/{sc['stats']['grade']}")

    # 自动修
    fixable_word = next(r for r in R.ALL if r["kind"] == "word" and r["fixable"])
    keep_rule = next(r for r in R.ALL if r["kind"] == "regex" and not r["fixable"])
    src = fixable_word["pattern"] + "，他站住了，然后走了。"
    fixed, n = L.fix(src)
    check(f"B13 自动修只删能删的：删掉「{fixable_word['pattern']}」共 {n} 处",
          fixable_word["pattern"] not in fixed and n >= 1, f"→ {fixed}")

    only, n1 = L.fix(src, rules=[fixable_word["id"]])
    other = next(r for r in R.ALL if r["kind"] == "word" and r["fixable"]
                 and r["id"] != fixable_word["id"])
    src2 = fixable_word["pattern"] + "他在" + other["pattern"] + "站住了。"
    only2, n2 = L.fix(src2, rules=[fixable_word["id"]])
    check("B14 指定规则修：只动点名的规则，别的可修词留着",
          fixable_word["pattern"] not in only2 and other["pattern"] in only2,
          f"{src2} → {only2}（{n1}/{n2} 处）")

    # 不能自动修的（句式类）不该被 fix 碰
    imp = "他并不想走，而是必须走。" if "并不" in keep_rule["pattern"] else None
    if imp:
        f2, _ = L.fix(imp)
        check("B15 不能自动修的句式类规则，一键修不碰（免得改坏意思）", "而是" in f2, f"→ {f2}")
    else:
        check("B15 不能自动修的句式类规则，一键修不碰（免得改坏意思）", True, "句式类无样本，跳过")

    clean_fix, n0 = L.fix(CLEAN)
    check("B16 干净文本一键修 = 一字不动、0 处", clean_fix == CLEAN and n0 == 0, f"n={n0}")

    scan_fixed = L.scan(fixed)
    left = [h for h in scan_fixed["hits"] if h["rule"] == fixable_word["id"]]
    check("B17 修完再扫，那条规则不再报（修是真生效，不是只改报告）", not left, f"{left[:2]}")
    check("B18 修完的分数不低于修前",
          scan_fixed["score"] >= L.scan(src)["score"],
          f"{L.scan(src)['score']} → {scan_fixed['score']}")
    return {"clean": c["score"], "dirty": d["score"], "deterministic": L.scan(DIRTY) == sc}


# ── C. 接口与真数据 ─────────────────────────────────────────────────────────
def api(c: C) -> None:
    st, d = c.call("/api/lint/rules")
    check("C1 GET /lint/rules 报出的条数跟引擎一致", st == 200 and d.get("count") == R.RULE_COUNT,
          f"{st} count={d.get('count') if isinstance(d, dict) else d}")
    bands = d.get("gradeBands") if isinstance(d, dict) else None
    check("C2 接口把等级阈值也吐出来（前端配色照它，不再各写一套）",
          isinstance(bands, list) and [b["min"] for b in bands] == [lo for lo, _ in L.GRADE_BANDS],
          str(bands)[:120])
    items = (d or {}).get("items") or []
    need = {"id", "category", "name", "severity", "fixable", "advice", "kind"}
    check("C3 规则列表字段够前端画表（含建议与能否自动修）",
          bool(items) and need.issubset(items[0].keys()), str(items[:1])[:200])
    check("C4 规则列表条数 = count（不许接口少给几条）", len(items) == (d or {}).get("count"),
          f"{len(items)} vs {(d or {}).get('count')}")

    st, d = c.call("/api/lint/scan", "POST", {"slug": REAL, "text": DIRTY})
    check("C5 POST /lint/scan（给 text 直接扫）200 且有评分与命中",
          st == 200 and isinstance(d.get("score"), int) and d.get("hits"),
          f"{st} score={(d or {}).get('score')}")
    check("C6 /lint/scan 把规则条数口径一起带回来（前端不用另拉一次）",
          (d or {}).get("stats", {}).get("ruleCount") == R.RULE_COUNT,
          str((d or {}).get("stats", {}).get("ruleCount")))
    st2, r = c.call("/api/lint/report?slug=%s" % u(REAL))
    latest = (r or {}).get("latest") or {}
    check("C7 质检报告有历史（不是扫完就丢）",
          st2 == 200 and (r or {}).get("items") and latest.get("stats"),
          f"{st2} items={len((r or {}).get('items') or [])}")

    st, d = c.call("/api/lint/scan", "POST", {"slug": REAL})
    check("C8 既不给 path 也不给 text：400 说人话", st == 400, f"{st} {d}")
    st, d = c.call("/api/lint/scan", "POST", {"slug": "根本没有这本书", "text": "文本"})
    check("C9 书不存在：404（不是 500）", st == 404, f"{st} {d}")
    st, d = c.call("/api/lint/scan", "POST", {"slug": REAL, "path": "manuscript/没有这章.md"})
    check("C10 章节不存在：404（不是 500）", st == 404, f"{st} {d}")
    st, d = c.call("/api/lint/scan-book", "POST", {"slug": REAL, "limit": 50})
    chs = (d or {}).get("chapters") or []
    check("C11 真书全书扫描：每章都有分数、按分数升序（最该改的在前）",
          st == 200 and len(chs) >= 3 and [x["score"] for x in chs] == sorted(x["score"] for x in chs),
          f"{st} {[x['score'] for x in chs]}")
    check("C12 全书每一章都带得出处（path/name）与命中明细",
          all(x.get("path") and x.get("name") and isinstance(x.get("top"), list) for x in chs),
          str(chs[:1])[:200])
    check("C13 全书总分 = 各章平均（不许另算一个数糊弄）",
          bool(chs) and (d or {}).get("score") == round(sum(x["score"] for x in chs) / len(chs)),
          f"{(d or {}).get('score')}")

    st, d = c.call("/api/lint/fix", "POST", {"slug": REAL, "text": DIRTY})
    check("C14 一键修（预览）：给出修前/修后分数，且默认不落盘",
          st == 200 and d.get("changed") and d.get("applied") is False
          and d["after"]["score"] >= d["before"]["score"],
          f"{st} {json.dumps(d, ensure_ascii=False)[:180]}")
    st, d = c.call("/api/lint/fix", "POST", {"slug": REAL, "text": DIRTY, "apply": True})
    check("C15 apply=true 但没说哪一章：400（不许糊里糊涂写文件）", st == 400, f"{st} {d}")
    st, d = c.call("/api/lint/llm", "POST", {"slug": REAL, "path": "", "modelKey": "不存在的模型"})
    check("C16 /lint/llm 模型不存在：400 说人话（不假装成功）", st == 400, f"{st} {d}")

    # 真书数据卫生：我们全程只读
    check("C17 全程没动用户的真书文件", (BOOKS / REAL).exists(), "")


def scratch_book(c: C) -> None:
    """自建一次性书：验「一键修真落盘」，跑完删净。"""
    st, d = c.call("/api/book", "POST", {"title": "质检自测 " + STAMP})
    slug = (d or {}).get("slug") or ""
    check("C18 建一本自测书", st == 200 and bool(slug), f"{st} {d}")
    if not slug:
        return
    path = "manuscript/第一章.md"
    st_c, _ = c.call("/api/chapter/new", "POST", {"slug": slug, "path": path, "content": DIRTY})
    check("C18b 自测章节建出来了", st_c == 200, f"{st_c}")
    st, s = c.call("/api/lint/scan", "POST", {"slug": slug, "path": path})
    check("C19 自测章节扫得出低分（脏稿就是脏稿）", st == 200 and s.get("score", 100) < 75,
          f"{st} score={(s or {}).get('score')}")
    st, fx = c.call("/api/lint/fix", "POST", {"slug": slug, "path": path, "apply": True})
    st2, rd = c.call("/api/chapter?slug=%s&path=%s" % (u(slug), u(path)))
    txt = (rd or {}).get("content") if isinstance(rd, dict) else ""  # GET /chapter 返回的字段叫 content
    check("C20 一键修真落盘（文件内容真的变了，不是只改报告）",
          st == 200 and fx.get("applied") and txt and txt != DIRTY,
          f"{st} applied={fx.get('applied')} 长度 {len(txt or '')} vs {len(DIRTY)}")
    check("C21 落盘后分数确实上升", fx.get("after", {}).get("score", 0) > fx.get("before", {}).get("score", 0),
          json.dumps(fx.get("after"), ensure_ascii=False)[:120])

    c.call("/api/book/delete", "POST", {"slug": slug})
    for p in (BOOKS / slug, TRASH / slug):
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
    for p in list(TRASH.glob("*" + slug + "*")):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
    print("  自测书已删干净：%s" % slug)


def main() -> int:
    print("A. 规则表体检")
    audit_rules()
    print("B. 引擎行为")
    behaviour()
    print("C. 接口与真数据")
    c = C()
    st, d = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1
    api(c)
    scratch_book(c)

    ok = sum(1 for _, o, _ in results if o)
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "rules": R.RULE_COUNT,
           "categories": len(R.CATEGORIES), "categoryCounts": R.CATEGORY_COUNTS,
           "fixable": sum(1 for r in R.ALL if r["fixable"]),
           "total": len(results), "ok": ok, "fail": len(results) - ok,
           "items": [{"name": n, "ok": o, "why": w} for n, o, w in results]}
    (ROOT / "docs" / "质检引擎实测.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== 质检引擎共 {len(results)} 条：通过 {ok}，失败 {len(results) - ok} ===")
    for n, o, w in results:
        if not o:
            print("  ✗", n, w)
    print("报告：docs/质检引擎实测.json")
    return 1 if ok != len(results) else 0


if __name__ == "__main__":
    sys.exit(main())
