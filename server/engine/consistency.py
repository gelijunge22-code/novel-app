# -*- coding: utf-8 -*-
"""角色一致性体检：长篇最容易崩的地方——**同一个人的外貌、年龄、称呼前后对不上**。

和世界引擎的分工：
* 世界引擎管「你**填**过的事实互相矛盾」（事实表内部查冲突）；
* 这里管「正文里**写出来**的和别处对不上」—— 作者自己都没意识到的那种，
  比如第 2 章写"十七岁"、第 9 章写"十九岁"（隔了三个月），
  或者第 3 章"黑发"第 11 章"银发"，或者同一个人一会儿"他"一会儿"她"。

每条都带**出处（哪一章第几行、原句）**，不然作者没法核。全部本地算，不调模型。
"""
from __future__ import annotations

import re

from .. import db as dbm
from ..store import chapter_files, read_text

_AGE = re.compile(r"([一二三四五六七八九十百两0-9]{1,4})\s*(?:岁|岁数)")
_CN_NUM = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6,
           "七": 7, "八": 8, "九": 9, "十": 10}
_HAIR = [("黑发", "黑"), ("白发", "白"), ("银发", "银"), ("金发", "金"), ("红发", "红"),
         ("褐发", "褐"), ("灰发", "灰"), ("青丝", "黑")]
_EYES = [("黑眸", "黑"), ("黑眼", "黑"), ("蓝眼", "蓝"), ("蓝眸", "蓝"), ("金瞳", "金"),
         ("绿眼", "绿"), ("红眼", "红"), ("灰眼", "灰")]
_BUILD = [("身材高大", "高大"), ("身材魁梧", "魁梧"), ("身材瘦小", "瘦小"), ("个子矮", "矮小"),
          ("身材纤细", "纤细"), ("身形挺拔", "挺拔"), ("瘦削", "瘦削"), ("圆胖", "胖")]
_SCAR = [("左脸", "左脸"), ("右脸", "右脸"), ("左手", "左手"), ("右手", "右手")]


def _line_no(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _cn2int(s: str) -> int | None:
    if s.isdigit():
        try:
            return int(s)
        except ValueError:
            return None
    if s in _CN_NUM:
        return _CN_NUM[s]
    if s.startswith("十") and len(s) == 2:
        return 10 + _CN_NUM.get(s[1], 0)
    if s.endswith("十") and len(s) == 2:
        return _CN_NUM.get(s[0], 0) * 10
    if "十" in s and len(s) == 3:
        return _CN_NUM.get(s[0], 0) * 10 + _CN_NUM.get(s[2], 0)
    return None


def _people(slug: str) -> list[dict]:
    from .world import entity_list
    out = []
    for e in entity_list(slug):
        if e["kind"] in ("character", "char", "角色", "person"):
            out.append(e)
    return out


def _scan(slug: str) -> list[dict]:
    """逐章读正文，记下每个角色周围的描述性事实（年龄/外貌/代词）。"""
    hits: list[dict] = []
    for ch in chapter_files(slug):
        try:
            text = read_text(slug, ch["path"])
        except Exception:
            continue
        if not text:
            continue
        for m in _AGE.finditer(text):
            n = _cn2int(m.group(1))
            if n is not None and 1 <= n <= 200:
                hits.append({"kind": "age", "value": str(n), "pos": m.start(),
                             "quote": _quote(text, m.start(), m.end()), "path": ch["path"],
                             "line": _line_no(text, m.start())})
        for group, kind in ((_HAIR, "hair"), (_EYES, "eyes"), (_BUILD, "build"), (_SCAR, "mark")):
            for word, val in group:
                for m in re.finditer(re.escape(word), text):
                    hits.append({"kind": kind, "value": val, "pos": m.start(),
                                 "quote": _quote(text, m.start(), m.end()), "path": ch["path"],
                                 "line": _line_no(text, m.start())})
        for m in re.finditer(r"[他她]", text):
            near = text[max(0, m.start() - 30):m.start() + 30]
            hits.append({"kind": "pronoun", "value": m.group(0), "pos": m.start(),
                         "quote": _quote(text, m.start(), m.end()), "path": ch["path"],
                         "line": _line_no(text, m.start()), "near": near})
    return hits


def _quote(text: str, a: int, b: int, span: int = 24) -> str:
    s = max(0, a - span)
    e = min(len(text), b + span)
    return re.sub(r"\s+", "", text[s:e])


def _who(hit: dict, people: list[dict]) -> str:
    """这句话说的是谁：先看同一个 60 字窗口里出现了谁的名字（长的优先）。"""
    names = []
    for e in people:
        names.append((e["name"], e["name"]))
        for a in (e.get("aliases") or []):
            names.append((a, e["name"]))
    names.sort(key=lambda x: -len(x[0]))
    hay = hit.get("near") or hit.get("quote") or ""
    for nm, ent in names:
        if nm in hay:
            return ent
    return ""


def report(slug: str) -> dict:
    people = _people(slug)
    hits = _scan(slug)
    issues: list[dict] = []
    # ① 年龄漂移：同一个人出现两个差 ≥2 的岁数
    ages: dict[str, list[dict]] = {}
    for h in hits:
        if h["kind"] != "age":
            continue
        who = _who(h, people)
        if who:
            ages.setdefault(who, []).append(h)
    for who, items in ages.items():
        vals = sorted({int(i["value"]) for i in items})
        if len(vals) >= 2 and vals[-1] - vals[0] >= 2:
            issues.append({
                "level": "warn", "key": "age_drift", "who": who,
                "text": "%s 的年龄前后差 %d 岁（%s）" % (who, vals[-1] - vals[0],
                                                       "、".join(f"{v}岁" for v in vals)),
                "advice": "要么中间写清过了几年，要么把一个岁数改掉（成长弧线也要跟着改）",
                "where": [{"path": i["path"], "line": i["line"], "quote": i["quote"]}
                          for i in items[:6]]})
    # ② 外貌冲突：发色/瞳色/身材/疤各有两种以上互相排斥的说法
    for kind, label in (("hair", "发色"), ("eyes", "瞳色"), ("build", "身材"), ("mark", "标记位置")):
        seen: dict[str, list[dict]] = {}
        for h in hits:
            if h["kind"] != kind:
                continue
            who = _who(h, people)
            if who:
                seen.setdefault(who, []).append(h)
        for who, items in seen.items():
            vals = sorted({i["value"] for i in items})
            if len(vals) >= 2:
                issues.append({
                    "level": "warn", "key": kind + "_conflict", "who": who,
                    "text": "%s 的%s前后不一致（%s）" % (who, label, "、".join(vals)),
                    "advice": "定一个为准，其余的地方统一改；改不动就把变化写进剧情（染了、伤了）",
                    "where": [{"path": i["path"], "line": i["line"], "quote": i["quote"]}
                              for i in items[:6]]})
    # ③ 代词混用：同一个角色在自己名字附近一会儿"他"一会儿"她"
    pron: dict[str, set] = {}
    pron_hits: dict[str, list[dict]] = {}
    for h in hits:
        if h["kind"] != "pronoun":
            continue
        who = _who(h, people)
        if not who:
            continue
        pron.setdefault(who, set()).add(h["value"])
        pron_hits.setdefault(who, []).append(h)
    for who, vals in pron.items():
        if len(vals) >= 2:
            issues.append({
                "level": "warn", "key": "pronoun_mix", "who": who,
                "text": "%s 既被写成「他」又被写成「她」" % who,
                "advice": "确认是这个人的性别写错，还是旁边有另一个人（那就把名字补上）",
                "where": [{"path": i["path"], "line": i["line"], "quote": i["quote"]}
                          for i in pron_hits[who][:6]]})
    # ④ 名字近似：正文里出现和已登记角色差一个字的名字 → 是笔误还是两个人
    known = set()
    for e in people:
        known.add(e["name"])
        known.update(e.get("aliases") or [])
    all_names = set()
    for ch in chapter_files(slug):
        try:
            text = read_text(slug, ch["path"])
        except Exception:
            continue
        all_names.update(re.findall(r"[\u4e00-\u9fff]{2,4}(?=说|道|问|答|：)", text))
    # 从「XX说」里抠出来的候选串常常多带一两个字（"林偌说"、"了林偌"），
    # 所以要**把每个长度 2~4 的前缀和后缀都拿出来比一遍**（实测抓到的：
    # 只取后缀时 "林偌说" 永远比不出 "林偌"）。
    seen_pairs = set()
    for cand in sorted(all_names):
        # 先把「说/道/问/答」这类动词尾巴削掉：留着它的话，名字一旦登记成别名，
        # 「林偌说」和一个字的距离正好等于「林偌」，于是**登记完还在报**（实测抓到的）。
        cand0 = re.sub(r"(说|道|问|答|喊|叫|笑|吼|骂|哼|应|叹|嚷|嘟囔|插嘴|低语|开口|冷笑|反问)+$", "", cand)
        base = cand0 if len(cand0) >= 2 else cand
        cands = set()
        for L in (2, 3, 4):
            if len(base) >= L:
                cands.add(base[:L])
                cands.add(base[-L:])
        for nm in sorted(cands):
            if nm in known:
                continue
            hit = None
            for k in known:
                if nm != k and abs(len(nm) - len(k)) <= 1 and _dist(nm, k) == 1:
                    hit = k
                    break
            if hit and (hit, nm) not in seen_pairs:
                seen_pairs.add((hit, nm))
                issues.append({
                    "level": "info", "key": "similar_name", "who": hit,
                    "text": "正文里有「%s」，和已登记的「%s」只差一个字" % (nm, hit),
                    "advice": "是笔误就统一改；真是另一个人的话，给他建个角色（不然出场统计会漏）",
                    "where": [], "suggestAlias": [hit, nm]})

    # ⑤ 消失的角色：世界里有他，但最近 6 章没露面（在本地算，不调接口）
    chap_texts = []
    for ch in chapter_files(slug):
        try:
            chap_texts.append((ch["path"], read_text(slug, ch["path"])))
        except Exception:
            chap_texts.append((ch["path"], ""))
    total = len(chap_texts)
    for e in people:
        alts = [e["name"]] + [a for a in (e.get("aliases") or []) if a]
        seen_at = [i for i, (p, t) in enumerate(chap_texts, 1)
                   if t and any(a in t for a in alts)]
        if seen_at and total and (total - seen_at[-1]) >= 6:
            issues.append({
                "level": "info", "key": "missing_character", "who": e["name"],
                "text": "%s 已经 %d 章没露面了（最后出现在第 %d 章）" % (
                    e["name"], total - seen_at[-1], seen_at[-1]),
                "advice": "长篇里人不见了最容易被读者记住：要么让他回来，要么交代一句他去哪了",
                "where": [{"path": chap_texts[seen_at[-1] - 1][0], "line": 0, "quote": ""}]})

    warn = sum(1 for i in issues if i["level"] == "warn")
    info = len(issues) - warn
    score = max(0, 100 - warn * 8 - info * 2)
    from .lint import grade_of
    return {"slug": slug, "score": score, "grade": grade_of(score),
            "stats": {"people": len(people), "scanned": len(hits), "warn": warn, "info": info},
            "issues": issues}


def _dist(a: str, b: str) -> int:
    """编辑距离（<=2 才有意义，直接截断）。"""
    if a == b:
        return 0
    if abs(len(a) - len(b)) > 2:
        return 9
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]
