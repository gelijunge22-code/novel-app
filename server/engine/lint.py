# -*- coding: utf-8 -*-
"""llmlint 引擎：把规则表跑起来，给分行定位、0-100 评分、分类维度分和自动修。

规则表在 `lint_rules.py`（565 条 / 27 类，纯数据）。这里只干三件事：
* `scan()`     —— 扫一段正文，返回逐条命中（行/列/片段/建议/严重度/能否自动修）+ 评分
* `fix()`      —— 只动「删掉不影响意思」的那些（可自动修的规则）
* `scan_book()`—— 扫全书，每章一份评分，给出最该改的章节顺序

评分怎么算（写出来是为了可解释、可复现，不是黑箱）：
    加权密度 = Σ(每条命中的权重) ÷ (字数/1000)，权重 = 严重度 1/2/3 → 1/2.5/5
    分数     = round(100 × e^(-加权密度/40))
所以：零命中 100 分；每千字 5 个中等命中 ≈ 88 分；每千字 20 个 ≈ 61 分。
分类维度分用同一个公式，只统计该类别的命中 —— 前端能直接画「哪一类最脏」。
等级阈值全局只有一份（`GRADE_BANDS`），前端配色照它来（≥90 绿 / 75–89 黄 / <75 红）。
"""
from __future__ import annotations

import math
import re
from functools import lru_cache
from bisect import bisect_right

from . import lint_rules as R

SEV_WEIGHT = {1: 1.0, 2: 2.5, 3: 5.0}
GRADE_BANDS = [(90, "干净"), (75, "还行"), (0, "要改")]
CATEGORIES = R.CATEGORIES
RULE_SUMMARY = R.summary()

# 词级规则按长度倒序：先长后短，「某种程度上」不会被「某种」抢走
_WORDS = sorted((r for r in R.ALL if r["kind"] == "word"),
                key=lambda r: -len(r["pattern"]))
_REGEX = [(r, re.compile(r["pattern"], re.M)) for r in R.ALL if r["kind"] == "regex"]
_DOC = [r for r in R.ALL if r["kind"] == "doc"]
_BY_ID = {r["id"]: r for r in R.ALL}

# 正文以外的东西不该算 AI 味：整行是引用块/代码/元数据的跳过
_SKIP_LINE = re.compile(r"^\s*(>|```|~~~|\||\+\+\+|---)")


def rules() -> list[dict]:
    """给前端「质检规则」面板列规则用。"""
    return [{"id": r["id"], "category": r["category"], "name": r["name"],
             "advice": r["advice"], "fixable": r["fixable"], "severity": r["severity"],
             "kind": r["kind"], "pattern": r["pattern"]} for r in R.ALL]


def grade_of(score: int) -> str:
    for lo, name in GRADE_BANDS:
        if score >= lo:
            return name
    return GRADE_BANDS[-1][1]


def _score_of(hits: list[dict], chars: int) -> int:
    if chars <= 0:
        return 100
    weight = sum(SEV_WEIGHT.get(int(h.get("severity") or 1), 1.0) for h in hits)
    dens = weight / (chars / 1000.0)
    return max(0, min(100, round(100 * math.exp(-dens / 40.0))))


def _locate(text: str, pos: int, line_starts: list[int]) -> tuple[int, int]:
    i = bisect_right(line_starts, pos) - 1
    return i + 1, pos - line_starts[i]


def _line_info(text: str) -> tuple[list[str], list[int], list[bool]]:
    lines = text.splitlines()
    starts, pos = [], 0
    for ln in lines:
        starts.append(pos)
        pos += len(ln) + 1
    skip = [bool(_SKIP_LINE.match(ln)) for ln in lines]
    return lines, starts, skip


def _is_skipped(start: int, ends, skip: list[bool], starts: list[int]) -> bool:
    i = bisect_right(starts, start) - 1
    return 0 <= i < len(skip) and skip[i]


def scan(text: str, *, path: str = "", limit: int = 4000, min_severity: int = 1) -> dict:
    """扫一段正文。命中按位置排序，同位置只留最重的一条。"""
    text = text or ""
    chars = max(1, len(text))
    lines, starts, skip = _line_info(text)
    hits: list[dict] = []

    # 1) 词级：用 str.find 找，比正则快得多（565 条里有 400+ 是词）
    for r in _WORDS:
        if r["severity"] < min_severity:
            continue
        w = r["pattern"]
        start = text.find(w)
        while start >= 0:
            if not _is_skipped(start, None, skip, starts):
                ln, col = _locate(text, start, starts)
                hits.append({"rule": r["id"], "category": r["category"], "name": r["name"],
                             "severity": r["severity"], "fixable": r["fixable"],
                             "advice": r["advice"], "text": w,
                             "line": ln, "col": col, "start": start, "end": start + len(w),
                             "context": lines[ln - 1][:120] if ln - 1 < len(lines) else ""})
            start = text.find(w, start + len(w))
            if len(hits) > limit * 3:
                break

    # 2) 句式级：正则
    for r, rx in _REGEX:
        if r["severity"] < min_severity:
            continue
        for m in rx.finditer(text):
            if _is_skipped(m.start(), None, skip, starts):
                continue
            ln, col = _locate(text, m.start(), starts)
            hits.append({"rule": r["id"], "category": r["category"], "name": r["name"],
                         "severity": r["severity"], "fixable": r["fixable"],
                         "advice": r["advice"], "text": m.group(0)[:60],
                         "line": ln, "col": col, "start": m.start(), "end": m.end(),
                         "context": lines[ln - 1][:120] if ln - 1 < len(lines) else ""})

    # 3) 篇章级：统计类检查（句长/段首/标点密度…）
    for r in _DOC:
        if r["severity"] < min_severity:
            continue
        for h in CHECKERS[r["id"]](text, lines, starts):
            hits.append({**h, "doc": True, "rule": r["id"], "category": r["category"],
                         "name": r["name"], "severity": r["severity"],
                         "fixable": r["fixable"], "advice": r["advice"]})

    # 去重：同一段文字被多条规则命中时，只留最重的那条
    hits.sort(key=lambda h: (h["start"], -h["severity"]))
    kept: list[dict] = []
    for h in hits:
        if (kept and not h.get("doc") and not kept[-1].get("doc")
                and h["start"] >= kept[-1]["start"] and h["end"] <= kept[-1]["end"]
                and h["severity"] <= kept[-1]["severity"]):
            continue
        kept.append(h)
    hits = kept[:limit]
    for k in ("start", "end"):
        for h in hits:
            h.pop(k, None)

    score = _score_of(hits, chars)
    by_cat = {}
    for c in CATEGORIES:
        arr = [h for h in hits if h["category"] == c]
        if arr:
            by_cat[c] = {"hits": len(arr), "score": _score_of(arr, chars),
                         "worst": max(h["severity"] for h in arr)}
    per_rule: dict[str, int] = {}
    for h in hits:
        per_rule[h["rule"]] = per_rule.get(h["rule"], 0) + 1
    return {"path": path, "chars": chars, "hits": hits, "score": score,
            "stats": {"total": len(hits), "perRule": per_rule,
                      "weightedPerK": round(sum(SEV_WEIGHT[h["severity"]] for h in hits)
                                            / (chars / 1000.0), 2),
                      "score": score, "grade": grade_of(score),
                      "byCategory": {c: len([h for h in hits if h["category"] == c])
                                     for c in CATEGORIES},
                      "categoryScores": by_cat,
                      "ruleCount": R.RULE_COUNT, "categoryCount": len(CATEGORIES)},
            "grade": grade_of(score)}


# ── 自动修 ──────────────────────────────────────────────────────────────────
def fix(text: str, *, rules: list[str] | None = None) -> tuple[str, int]:
    """自动修：只动「删掉不影响意思」的那些（规则表里 fixable=True 的）。"""
    out = text or ""
    n = 0
    for r in _WORDS:
        if not r["fixable"] or (rules and r["id"] not in rules):
            continue
        out, k = re.subn(re.escape(r["pattern"]), "", out)
        n += k
    for r, rx in _REGEX:
        if not r["fixable"] or (rules and r["id"] not in rules):
            continue
        out, k = rx.subn("", out)
        n += k
    # 收尾清理：删完词会留下多余空格、空标点、三连空行
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"[ \t]+([，。！？；：、])", r"\1", out)
    out = re.sub(r"([，、]){2,}", r"\1", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out, n


# ── 篇章级检查器 ────────────────────────────────────────────────────────────
@lru_cache(maxsize=8)      # 一次 scan 里有 7 个检查器要切句，别重复切（720k 字实测省 ~0.3s/本）
def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[。！？…])", text) if s.strip()]


def _paras(lines: list[str]) -> list[tuple[int, str]]:
    out, buf, start = [], [], 0
    for i, ln in enumerate(lines):
        if ln.strip():
            if not buf:
                start = i
            buf.append(ln)
        elif buf:
            out.append((start, "\n".join(buf)))
            buf = []
    if buf:
        out.append((start, "\n".join(buf)))
    return out


def _h(line: int, text: str, lines: list[str], note: str = "") -> dict:
    return {"line": line + 1, "col": 0, "text": text[:60], "context": note,
            "start": 0, "end": 0}


def _ck_rhythm_mono(text, lines, starts):
    sents = _sentences(text)
    if len(sents) < 12:
        return []
    lens = [len(s.strip()) for s in sents if s.strip()]
    mean = sum(lens) / len(lens)
    var = sum((x - mean) ** 2 for x in lens) / len(lens)
    if var ** 0.5 <= max(3.0, mean * 0.18):
        return [_h(1, sents[0], lines, f"{len(lens)} 句平均 {mean:.0f} 字，长短几乎一样")]
    return []


def _ck_para_mono(text, lines, starts):
    ps = _paras(lines)
    if len(ps) < 8:
        return []
    lens = [len(p[1]) for p in ps]
    mean = sum(lens) / len(lens)
    var = sum((x - mean) ** 2 for x in lens) / len(lens)
    if var ** 0.5 <= max(5.0, mean * 0.22):
        return [_h(ps[0][0], ps[0][1], lines, f"{len(ps)} 段平均 {mean:.0f} 字，段落长度太齐")]
    return []


def _ck_para_start(text, lines, starts):
    ps = _paras(lines)
    out = []
    for i in range(len(ps) - 2):
        a, b, c = (ps[i][1][:1], ps[i + 1][1][:1], ps[i + 2][1][:1])
        if a and a == b == c and a not in "。！？\n":
            out.append(_h(ps[i][0], ps[i][1], lines, f"连续三段以「{a}」开头"))
    return out


def _ck_sent_end(text, lines, starts):
    sents = _sentences(text)
    out = []
    for i in range(len(sents) - 2):
        a, b, c = (sents[i].strip()[-1:], sents[i + 1].strip()[-1:],
                   sents[i + 2].strip()[-1:])
        if a == b == c and a not in "。！？…":
            out.append(_h(1, sents[i][-30:], lines, f"连续三句以「{a}」收尾"))
            break
    return out


def _ck_dialog_tag(text, lines, starts):
    n = len(re.findall(r"(说道|问道|答道|回道|应道|回答道|开口道)", text))
    if n >= max(6, len(text) / 1000 * 6):
        return [_h(1, "说道/问道", lines, f"对话标签 {n} 处")]
    return []


def _ck_de_density(text, lines, starts):
    n = text.count("的")
    if n >= max(20, len(text) / 1000 * 42):
        return [_h(1, "的" * 3, lines, f"「的」{n} 处 / {len(text)} 字")]
    return []


# ── 「一句里堆套话 / 堆成语」的第 8 遍改写 ────────────────────────────────────
# 老写法有两个问题（都是跑 `tools/perf_test.py` 时暴露的）：
#   1. `doc.idiom.stack`（成语堆砌，severity 2）与 `doc.cliche.stack`（一句里堆套话，severity 3）
#      **注册的是同一个检查器**：同一句话会各出一条、同一条毛病记两笔；而且全书白扫两遍
#      （实测 854ms + 818ms，占整章扫描的 2/3）。
#   2. 每句话都对着两百来个词条挨个 `text.find`（还有个 per-iteration 的 lambda），
#      句子数 × 词条数 = 平方级的开销。
# 现在：一句话只切一次、每组用**一个预编译的择一正则**扫一遍，成语归成语、套话归套话，互不重复。

_IDIOM_GROUP = [r for r in _WORDS if r["category"] == "套路用语"]
_CLICHE_GROUP = [r for r in _WORDS if r["category"] in ("情绪直述", "心理偷懒")]


def _alt_matcher(group):
    """把一组词条编成一个择一正则；返回 (正则, {命中文本: [规则 id…]})。"""
    if not group:
        return None, {}
    idx: dict[str, list[str]] = {}
    for r in group:
        idx.setdefault(r["pattern"], []).append(r["id"])
    rx = re.compile("|".join(re.escape(k) for k in sorted(idx, key=len, reverse=True)))
    return rx, idx


_IDIOM_RX, _IDIOM_IDS = _alt_matcher(_IDIOM_GROUP)
_CLICHE_RX, _CLICHE_IDS = _alt_matcher(_CLICHE_GROUP)


@lru_cache(maxsize=8)          # 两个规则共用一次遍历（以前是两次独立的 O(句子数×词条数) 扫）
def _stack_scan(text: str) -> tuple:
    """一次遍历句子，出两组结论（都按 text 缓存，两条规则各取一半）。"""
    idiom, cliche = [], []
    pos = 0
    for seg in _sentences(text):
        seg_s = seg.strip()
        a = text.find(seg_s, pos)
        if a < 0:
            continue
        b = a + len(seg_s)
        pos = b
        if len(seg_s) > 300:                     # 一整段没句号就别硬算
            continue
        # 注意：`text.count("\n", 0, a)` 是 O(a) 的 —— 只在**真要出结论**的时候算一次，
        # 别每句话都算（第一版改完就是这么把自己拖回 6 秒的，实测抓到）。
        if _IDIOM_RX is not None and len(idiom) < 5:
            ids = {i for m in _IDIOM_RX.finditer(text, a, b)
                   for i in _IDIOM_IDS.get(m.group(0), [])}
            if len(ids) >= 3:
                idiom.append((text.count("\n", 0, a), seg_s, "这句里有 %d 处成语" % len(ids)))
        if _CLICHE_RX is not None and len(cliche) < 5:
            ids = {i for m in _CLICHE_RX.finditer(text, a, b)
                   for i in _CLICHE_IDS.get(m.group(0), [])}
            if len(ids) >= 3:
                cliche.append((text.count("\n", 0, a), seg_s, "这句里有 %d 处套话" % len(ids)))
    return tuple(idiom), tuple(cliche)


def _ck_idiom_stack(text, lines, starts):
    """成语堆砌：一句里三个以上成语（走「套路用语」那一组）。"""
    return [_h(ln, seg, lines, note) for ln, seg, note in _stack_scan(text)[0]]


def _ck_cliche_stack(text, lines, starts):
    """套话堆砌：一句里三个以上套话（情绪直述 / 心理偷懒 那一组）。"""
    return [_h(ln, seg, lines, note) for ln, seg, note in _stack_scan(text)[1]]


def _ck_quote_mix(text, lines, starts):
    """一章里混用两种引号：同一份稿子里「」和“”都出现（数量都够多才算，避免引文干扰）。"""
    a, b = text.count("「"), text.count("“")
    if a >= 3 and b >= 3:
        i = text.find("“") if b else 0
        return [_h(text.count("\n", 0, i), "“", lines, f"「」{a} 处、“”{b} 处")]
    return []


def _ck_para_end(text, lines, starts):
    out = []
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s and re.search(r"(总之|无论如何|不管怎样|说到底|这就是|这才是|由此可见)[。！？…]?$", s):
            out.append(_h(i, s, lines, "段落末尾总结"))
    return out


def _ck_chapter_start(text, lines, starts):
    head = "\n".join(lines[:6])
    for pat, why in ((r"(注定|将会|即将|从此)", "开头就预告"),
                     (r"(这一天|那一刻|那一夜)[，,]?[^。\n]{0,20}(注定|改变)", "开头就总结")):
        if re.search(pat, head):
            return [_h(0, lines[0] if lines else "", lines, why)]
    return []


def _ck_chapter_end(text, lines, starts):
    tail = "\n".join(lines[-4:])
    if re.search(r"(未完待续|预知后事|敬请期待|下回分解)", tail) or tail.strip().endswith("……"):
        return [_h(max(0, len(lines) - 2), lines[-1] if lines else "", lines, "结尾喊口号/留省略号")]
    return []


def _density_rule(text, lines, token: str, per_k: float, floor: int, what: str):
    n = text.count(token)
    if n >= max(floor, len(text) / 1000 * per_k):
        return [_h(1, token, lines, f"{what} {n} 处")]
    return []


def _ck_exclaim(text, lines, starts):
    return _density_rule(text, lines, "！", 8, 8, "感叹号")


def _ck_dash(text, lines, starts):
    return _density_rule(text, lines, "——", 6, 4, "破折号")


def _ck_ellipsis(text, lines, starts):
    return _density_rule(text, lines, "…", 10, 6, "省略号")


def _ck_short_run(text, lines, starts):
    sents = [s.strip() for s in _sentences(text) if s.strip()]
    run = 0
    for s in sents:
        run = run + 1 if len(s) <= 8 else 0
        if run >= 5:
            return [_h(1, s, lines, "连着五句都很短")]
    return []


def _ck_adverb_start(text, lines, starts):
    sents = [s.strip() for s in _sentences(text) if s.strip()]
    for i in range(len(sents) - 1):
        if re.match(r"^[\u4e00-\u9fa5]{1,4}地", sents[i]) and re.match(r"^[\u4e00-\u9fa5]{1,4}地", sents[i + 1]):
            return [_h(1, sents[i], lines, "连着两句以副词开头")]
    return []


def _ck_adj_run(text, lines, starts):
    sents = [s.strip() for s in _sentences(text) if s.strip()]
    run = 0
    for s in sents:
        run = run + 1 if re.match(r"^(很|非常|十分|格外|无比)", s) else 0
        if run >= 3:
            return [_h(1, s, lines, "连着三句都是「很…」判断句")]
    return []


def _ck_punct_run(text, lines, starts):
    for m in re.finditer(r"[，。！？；：]{2,}|…{3,}|—{4,}", text):
        return [_h(text.count("\n", 0, m.start()), m.group(0), lines, "标点连排")]
    return []


def _ck_space_run(text, lines, starts):
    for i, ln in enumerate(lines):
        if re.search(r"[\u4e00-\u9fa5]\s{2,}[\u4e00-\u9fa5]", ln):
            return [_h(i, ln, lines, "多余空格")]
    return []


def _ck_name_repeat(text, lines, starts):
    for i, ln in enumerate(lines):
        for m in re.finditer(r"([\u4e00-\u9fa5]{2,3})(?:[\u4e00-\u9fa5，、]{0,10}\1){4,}", ln):
            return [_h(i, ln, lines, f"「{m.group(1)}」在一段里重复太多次")]
    return []


def _ck_pronoun_start(text, lines, starts):
    ps = _paras(lines)
    n = sum(1 for _, p in ps if p[:1] in ("他", "她"))
    if len(ps) >= 6 and n / len(ps) >= 0.9:
        return [_h(ps[0][0], ps[0][1], lines, f"{n}/{len(ps)} 段以「他/她」开头")]
    return []


def _ck_metaphor_dense(text, lines, starts):
    return _density_rule(text, lines, "像", 22, 10, "「像」字比喻")


def _ck_passive(text, lines, starts):
    return _density_rule(text, lines, "被", 18, 8, "「被」字句")


def _ck_vp_mix(text, lines, starts):
    for i, ln in enumerate(lines):
        if re.search(r"我[^。！？\n]{0,20}他|他[^。！？\n]{0,20}我", ln) and ("我" in ln and "他" in ln) \
                and re.search(r"(走过去|转过头|心里想|说道)", ln):
            return [_h(i, ln, lines, "同一段里人称混用")]
    return []


def _ck_vp_jump(text, lines, starts):
    """相邻两段人称突变：这段满口「我」，下段满口「他/她」。"""
    ps = _paras(lines)
    out = []
    for i in range(len(ps) - 1):
        a, b = ps[i][1], ps[i + 1][1]
        if len(a) < 20 or len(b) < 20:
            continue
        a_me = len(re.findall(r"[我咱]", a))
        a_ta = len(re.findall(r"[他她]", a))
        b_me = len(re.findall(r"[我咱]", b))
        b_ta = len(re.findall(r"[他她]", b))
        if a_me >= 3 and a_ta == 0 and b_ta >= 3 and b_me == 0:
            out.append(_h(ps[i + 1][0], b, lines, "上一段第一人称、这一段第三人称，视角跳了"))
    return out[:3]


def _ck_quote_mono(text, lines, starts):
    n1 = text.count("「")
    n2 = text.count("“")
    if n1 >= 6 and n2 == 0:
        return [_h(1, "「", lines, f"全书 {n1} 处都只用「」，对话形式单一")]
    return []


def _ck_blank_dense(text, lines, starts):
    blanks = sum(1 for ln in lines if not ln.strip())
    if len(lines) and blanks / max(1, len(lines)) > 0.6:
        return [_h(1, "", lines, f"{blanks}/{len(lines)} 行是空行")]
    return []


def _ck_dialog_ratio(text, lines, starts):
    if len(text) < 300:
        return []
    r = text.count("「") / (len(text) / 1000)
    if r > 14:
        return [_h(1, "「", lines, "几乎全是对话")]
    if r == 0 and len(text) > 800:
        return [_h(1, "", lines, "整章没有对话")]
    return []


def _ck_emotion_adj(text, lines, starts):
    return _density_rule(text, lines, "很", 12, 6, "「很…」式判断")


def _ck_sent_repeat(text, lines, starts):
    sents = [s.strip() for s in _sentences(text) if len(s.strip()) > 6]
    for i in range(len(sents) - 1):
        a = set(re.findall(r"[\u4e00-\u9fa5]{2}", sents[i]))
        b = set(re.findall(r"[\u4e00-\u9fa5]{2}", sents[i + 1]))
        common = a & b
        if len(common) >= 4:
            return [_h(1, sents[i + 1], lines, "相邻两句实词重复：" + "、".join(sorted(common)[:5]))]
    return []


def _ck_number_spam(text, lines, starts):
    return _density_rule(text, lines, "0", 20, 12, "数字")


def _ck_seq_word(text, lines, starts):
    for i, ln in enumerate(lines):
        n = len(re.findall(r"(然后|于是|接着|随后|因此|所以|然而|但是)", ln))
        if n >= 3:
            return [_h(i, ln, lines, "一段里挤了好几个过渡词")]
    return []


CHECKERS = {
    "doc.rhythm.mono": _ck_rhythm_mono,
    "doc.para.mono": _ck_para_mono,
    "doc.para.start": _ck_para_start,
    "doc.sent.end": _ck_sent_end,
    "doc.dialog.tag": _ck_dialog_tag,
    "doc.de.density": _ck_de_density,
    "doc.idiom.stack": _ck_idiom_stack,
    "doc.para.end": _ck_para_end,
    "doc.chapter.start": _ck_chapter_start,
    "doc.chapter.end": _ck_chapter_end,
    "doc.exclaim.dense": _ck_exclaim,
    "doc.dash.dense": _ck_dash,
    "doc.ellipsis.dense": _ck_ellipsis,
    "doc.short.run": _ck_short_run,
    "doc.adverb.start": _ck_adverb_start,
    "doc.adj.run": _ck_adj_run,
    "doc.punct.run": _ck_punct_run,
    "doc.space.run": _ck_space_run,
    "doc.name.repeat": _ck_name_repeat,
    "doc.pronoun.start": _ck_pronoun_start,
    "doc.metaphor.dense": _ck_metaphor_dense,
    "doc.passive": _ck_passive,
    "doc.vp.mix": _ck_vp_mix,
    "doc.vp.jump": _ck_vp_jump,
    "doc.quote.mono": _ck_quote_mono,
    "doc.blank.dense": _ck_blank_dense,
    "doc.dialog.ratio": _ck_dialog_ratio,
    "doc.emotion.adj": _ck_emotion_adj,
    "doc.sent.repeat": _ck_sent_repeat,
    "doc.number.spam": _ck_number_spam,
    "doc.seq.word": _ck_seq_word,
    "doc.quote.mix": _ck_quote_mix,
    "doc.cliche.stack": _ck_cliche_stack,
}
assert set(CHECKERS) == {r["id"] for r in _DOC}, "篇章检查器和规则表对不上"


# ── 全章缓存（第 8 遍打磨加的）────────────────────────────────────────────────
# 为什么要有：「质检」面板一打开就读 `/lint/report`，而它**每次都把全书重扫一遍** ——
# 100 万字实测 **6.5 秒**（`tools/perf_test.py` 当场抓到）。用户每开一次面板都要等 6.5 秒，
# 可他往往只改了一章。这里按 **章 + 文件 mtime + 规则表指纹** 做缓存：
# 改过的章才重扫，其余直接复用（201 章只改一章 → 秒开；不改变动过的书 → 0 成本）。
import hashlib as _hashlib
import threading as _threading
from collections import OrderedDict as _OrderedDict

_RULE_FINGERPRINT = _hashlib.md5(
    ("|".join(r["id"] for r in R.ALL) + "|" + str(R.RULE_COUNT)).encode("utf-8")).hexdigest()[:12]
_CH_CACHE: "_OrderedDict[str, dict]" = _OrderedDict()   # slug -> {"key":…, "ch": {path: (mtime, res)}}
_CACHE_BOOKS = 4                                        # 最多缓存几本书（每本 ~1MB，别无限涨）
_CACHE_LOCK = _threading.Lock()


def scan_book_cached(slug: str, *, limit: int = 800) -> dict:
    """`scan_book()` 的带缓存版：语义完全一样，只是改过的章才重扫。

    结果里多一个 `reused`（复用了几章）与 `cached`（整本是不是全都从缓存来的），
    这是"缓存真的生效了"的可验证证据，不是自我声明。
    """
    out, reused = _scan_book_with_reuse(slug, limit=limit)
    out["reused"] = reused
    out["cached"] = reused == len(out["chapters"]) and bool(out["chapters"])
    return out


def _scan_book_with_reuse(slug: str, *, limit: int) -> tuple[dict, int]:
    from ..store import chapter_files, read_text
    files = chapter_files(slug)
    key = (_RULE_FINGERPRINT, limit)
    with _CACHE_LOCK:
        book = _CH_CACHE.get(slug)
        prev = dict(book["ch"]) if book and book.get("key") == key else {}
    kept: dict[str, tuple] = {}
    chapters, total_hits, reused = [], 0, 0
    for f in files:
        mtime = int(f.get("mtimeMs") or 0)
        old = prev.get(f["path"])
        if old and old[0] == mtime:
            r = old[1]
            reused += 1
        else:
            try:
                text = read_text(slug, f["path"])
            except Exception:
                continue
            r = scan(text, path=f["path"], limit=limit)
        kept[f["path"]] = (mtime, r)
        total_hits += len(r["hits"])
        chapters.append({"path": f["path"], "name": f["name"], "chars": r["chars"],
                         "hits": len(r["hits"]), "score": r["stats"]["score"],
                         "grade": r["grade"], "byCategory": r["stats"]["byCategory"],
                         "categoryScores": r["stats"]["categoryScores"],
                         "top": sorted(r["hits"], key=lambda h: -h["severity"])[:5]})
    with _CACHE_LOCK:
        _CH_CACHE[slug] = {"key": key, "ch": kept}
        _CH_CACHE.move_to_end(slug)
        while len(_CH_CACHE) > _CACHE_BOOKS:
            _CH_CACHE.popitem(last=False)
    overall = round(sum(c["score"] for c in chapters) / len(chapters)) if chapters else 100
    cat_tot: dict[str, int] = {}
    for c in chapters:
        for k, v in (c["byCategory"] or {}).items():
            cat_tot[k] = cat_tot.get(k, 0) + v
    return {"slug": slug, "chapters": sorted(chapters, key=lambda c: c["score"]),
            "totalHits": total_hits, "score": overall, "grade": grade_of(overall),
            "categoryTotals": cat_tot,
            "ruleCount": R.RULE_COUNT, "categoryCount": len(CATEGORIES)}, reused


def scan_book(slug: str, *, limit: int = 800, worst: int = 20) -> dict:
    """扫全书：每章一份评分，按分数从低到高排（最该改的排前面）。"""
    from ..store import chapter_files, read_text
    chapters = []
    total_hits = 0
    for ch in chapter_files(slug):
        try:
            text = read_text(slug, ch["path"])
        except Exception:
            continue
        r = scan(text, path=ch["path"], limit=limit)
        total_hits += len(r["hits"])
        chapters.append({"path": ch["path"], "name": ch["name"], "chars": r["chars"],
                         "hits": len(r["hits"]), "score": r["stats"]["score"],
                         "grade": r["grade"], "byCategory": r["stats"]["byCategory"],
                         "categoryScores": r["stats"]["categoryScores"],
                         "top": sorted(r["hits"], key=lambda h: -h["severity"])[:5]})
    overall = round(sum(c["score"] for c in chapters) / len(chapters)) if chapters else 100
    cat_tot: dict[str, int] = {}
    for c in chapters:
        for k, v in (c["byCategory"] or {}).items():
            cat_tot[k] = cat_tot.get(k, 0) + v
    return {"slug": slug, "chapters": sorted(chapters, key=lambda c: c["score"]),
            "totalHits": total_hits, "score": overall, "grade": grade_of(overall),
            "categoryTotals": cat_tot,
            "ruleCount": R.RULE_COUNT, "categoryCount": len(CATEGORIES)}
