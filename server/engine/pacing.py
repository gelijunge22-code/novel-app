# -*- coding: utf-8 -*-
"""节奏 / 情绪曲线：把"连着三章都在吵架"这件事**看出来**。

为什么需要它：写长篇时人只会盯着当前这一章，回头看整体节奏全靠记忆。
"最近是不是一直在吵？""高潮之后给读者喘气了吗？""连着几章都没对话了？"
——这些问题现在只能靠猜。这个模块把每章量化成一条曲线（张力/情绪正负/对话占比/
句长/动作密度），再用规则把**形状里的毛病**挑出来（不是挑词，是挑走势）。

全部本地计算，不调模型，断网也能跑。
"""
from __future__ import annotations

import re
import statistics

from ..store import chapter_files, read_text

_QUOTE = re.compile(r"[“\"「『][^”\"」』\n]{1,300}[”\"」』]")
_SENT = re.compile(r"[^。！？!?；;\n]+")

# 情绪词表：分正/负/紧张三桶。刻意写得短而准 —— 这里要的是**走势**，不是逐句打分。
_POS = ("笑", "松", "暖", "安心", "高兴", "开心", "欢喜", "舒服", "甜", "放心", "轻松",
        "温柔", "平安", "靠得住", "踏实", "幸运", "感动", "希望", "舒坦", "惬意", "满足",
        "欣慰", "欢快", "喜悦", "平静", "安宁", "香甜", "有趣", "好玩", "逗", "热闹",
        "亲昵", "亲密", "信任", "感激", "骄傲", "得意", "畅快", "痛快")
_NEG = ("哭", "痛", "死", "血", "恨", "怒", "怕", "冷", "苦", "绝望", "悲", "惨",
        "孤单", "累", "饿", "病", "伤", "泪", "愧疚", "后悔", "羞", "愧",
        # 实测加厚：只收"恨""怕"这种单字，一章里四句负面情绪会被算成一个词，
        # 情绪曲线整条压平（连着三章都在吵也看不出来）。下面这些是网文里真在用的写法。
        "委屈", "难受", "生气", "恼怒", "气恼", "烦躁", "焦虑", "不安", "恐慌", "惧怕",
        "恐惧", "害怕", "心惊", "心惊肉跳", "沮丧", "失落", "心酸", "苦涩", "窒息",
        "压迫", "沉重", "沉默", "无言", "尴尬", "难堪", "狼狈", "绝望", "无力",
        "疼", "剧痛", "酸痛", "发冷", "发抖", "打颤", "咬牙", "攥紧", "皱眉",
        "咬牙切齿", "火气", "怒意", "杀意", "恨意", "哭声", "呜咽", "抽泣", "哽咽",
        "死寂", "寒", "阴冷", "压抑", "憋", "绷", "崩溃", "发疯", "疯", "骂", "斥")
_TENSE = ("忽然", "突然", "猛地", "瞬间", "刹那", "紧", "急", "冲", "炸", "刀", "剑",
          "扑", "撞", "追", "逃", "吼", "喊", "劈", "崩", "裂", "爆", "杀", "砸",
          "血", "箭", "枪", "火", "烟", "雷", "震", "颤", "冷汗", "屏住", "窒息",
          "死", "倒", "摔", "滚", "翻", "勒", "掐", "踢", "踹", "砸开", "撞开")
_ACT = ("跑", "跳", "抓", "推", "拉", "打", "踢", "拔", "劈", "翻", "爬", "冲", "闪",
        "扑", "扔", "摔", "撞", "咬", "扛", "拽", "挥", "刺", "砍", "扑倒")


def _hits(text: str, words) -> int:
    return sum(text.count(w) for w in words)


def chapter_metrics(text: str) -> dict:
    """一章的量化形状。数字都要能解释，不搞黑箱。"""
    t = text or ""
    chars = len(re.sub(r"\s", "", t))
    if chars == 0:
        return {"chars": 0, "dialogue": 0.0, "valence": 0.0, "arousal": 0.0,
                "action": 0.0, "avgSent": 0.0, "sentSpread": 0.0, "paras": 0,
                "avgPara": 0, "exclaim": 0.0}
    quoted = sum(len(m.group(0)) for m in _QUOTE.finditer(t))
    sents = [s.strip() for s in _SENT.findall(t) if s.strip()]
    lens = [len(s) for s in sents] or [0]
    paras = [p for p in t.split("\n") if p.strip()]
    pos, neg, tense = _hits(t, _POS), _hits(t, _NEG), _hits(t, _TENSE)
    act = _hits(t, _ACT)
    per_k = chars / 1000.0
    # 情绪正负：-1 到 1
    valence = (pos - neg) / float(pos + neg + 3)
    # 张力：紧张词密度 + 感叹号密度，0 到 1。
    # 早先用的是"线性 ÷8"，实测**一律顶到 1.0**（短章里紧张词天然密），
    # 曲线就成了一条直线，什么也看不出来。改成按密度分级 + 系数加权。
    tense_per_k = tense * 1000.0 / chars
    excl = (t.count("！") + t.count("!")) / max(1, len(sents))
    arousal = min(1.0, 0.65 * min(1.0, tense_per_k / 40.0) + 0.35 * min(1.0, excl / 0.15))
    return {
        "chars": chars,
        "dialogue": round(quoted / chars, 3),
        "valence": round(max(-1.0, min(1.0, valence)), 3),
        "arousal": round(arousal, 3),
        "action": round(act / per_k, 2),
        "avgSent": round(sum(lens) / len(lens), 1),
        "sentSpread": round(statistics.pstdev(lens), 1) if len(lens) > 1 else 0.0,
        "paras": len(paras),
        "avgPara": round(chars / max(1, len(paras))),
        "exclaim": round((t.count("！") + t.count("!")) / max(1, len(sents)), 3),
    }


def curve(slug: str, *, limit: int = 0) -> dict:
    """整本书的曲线：每章一个点 + 走势里的毛病。"""
    files = chapter_files(slug)
    points = []
    for i, ch in enumerate(files, 1):
        try:
            text = read_text(slug, ch["path"])
        except Exception:
            text = ""
        m = chapter_metrics(text)
        m.update({"index": i, "path": ch["path"], "title": ch.get("title") or "",
                  "words": ch.get("words") or m["chars"]})
        points.append(m)
    if limit:
        points = points[-limit:]
    return {"slug": slug, "points": points, "alerts": alerts(points),
            "summary": summary(points)}


def _run(points: list[dict], key: str, pred, need: int = 3) -> list[tuple[int, int]]:
    """连续满足 pred 的区间（至少 need 章）。返回 [(起点序号, 终点序号)]，序号是 1 起。"""
    out, start = [], None
    for p in points:
        if pred(p):
            start = start if start is not None else p["index"]
        else:
            if start is not None and p["index"] - start >= need:
                out.append((start, p["index"] - 1))
            start = None
    if start is not None and (points[-1]["index"] - start + 1) >= need:
        out.append((start, points[-1]["index"]))
    return out


def _span(points: list[dict], a: int, b: int) -> list[dict]:
    return [p for p in points if a <= p["index"] <= b]


def alerts(points: list[dict]) -> list[dict]:
    """形状里的毛病。每条都要指得出**哪几章**，并且说清为什么算毛病。"""
    out: list[dict] = []
    if len(points) < 3:
        return out

    def add(level, key, a, b, text, advice):
        out.append({"level": level, "key": key, "from": a, "to": b, "chapters": b - a + 1,
                    "text": text, "advice": advice,
                    "paths": [p["path"] for p in _span(points, a, b)][:12]})

    # 1. 连着几章都在吵 / 都在憋（情绪同向且没有起伏）
    for a, b in _run(points, "valence", lambda p: p["valence"] <= -0.15, 3):
        vals = [p["valence"] for p in _span(points, a, b)]
        if max(vals) - min(vals) <= 0.35:
            add("warn", "flat_negative", a, b,
                "第 %d–%d 章连着 %d 章情绪都压在负面（而且起伏不大，像一直在吵架）" % (a, b, b - a + 1),
                "中间插一章缓的：换个场景、让人笑一次，或者把这场冲突收掉再开下一场")
    for a, b in _run(points, "valence", lambda p: p["valence"] >= 0.2, 4):
        add("info", "flat_positive", a, b,
            "第 %d–%d 章连着 %d 章都是好情绪" % (a, b, b - a + 1),
            "太顺会让人不想翻页：加个小坎，或者把已有的麻烦提前一点爆")
    # 2. 一直绷着，没有喘息
    for a, b in _run(points, "arousal", lambda p: p["arousal"] >= 0.6, 3):
        add("warn", "no_breath", a, b,
            "第 %d–%d 章张力一直拉满，中间没有喘息" % (a, b),
            "高潮后面要给读者一口气：写点日常、结算一下后果，下一场才更响")
    # 3. 连着几章没对话（全是叙述，读起来像流水账）
    for a, b in _run(points, "dialogue", lambda p: p["dialogue"] < 0.06 and p["chars"] > 120, 3):
        add("info", "no_dialogue", a, b,
            "第 %d–%d 章几乎没有对话（对白占比都低于 6%%）" % (a, b),
            "让人开口说话：一句话能交代的信息，叙述要三句")
    # 4. 长句连片（读着累）
    for a, b in _run(points, "avgSent", lambda p: p["avgSent"] >= 32 and p["chars"] > 120, 3):
        add("info", "long_sentences", a, b,
            "第 %d–%d 章平均句长都超过 32 字" % (a, b),
            "长短交替：信息密的地方用短句砸下去，别一路长句")
    # 5. 单章过长 / 过短
    for p in points:
        if p["chars"] >= 9000:
            add("info", "too_long", p["index"], p["index"],
                "第 %d 章 %d 字，偏长（一口气读完会累）" % (p["index"], p["chars"]),
                "考虑拆成两章，或者在中间找一个自然的断点")
        if 0 < p["chars"] <= 150:
            add("info", "too_short", p["index"], p["index"],
                "第 %d 章只有 %d 字" % (p["index"], p["chars"]),
                "是占位还是真的就这几句？太短的一章读者会觉得被骗")
    # 6. 最近几章没有高潮（全书最长的那一段之后一直平）
    if len(points) >= 6:
        tail = points[-5:]
        if all(p["arousal"] < 0.35 for p in tail):
            add("warn", "no_peak", tail[0]["index"], tail[-1]["index"],
                "最近 5 章张力都偏低，没有一个像样的高点",
                "找一个该爆的点：把攒着的伏笔用掉一个，或者让某人先动手")
    out.sort(key=lambda x: (x["level"] != "warn", x["from"]))
    return out


def summary(points: list[dict]) -> dict:
    if not points:
        return {"chapters": 0}
    val = [p["valence"] for p in points]
    aro = [p["arousal"] for p in points]
    dia = [p["dialogue"] for p in points]
    return {
        "chapters": len(points),
        "words": sum(p["chars"] for p in points),
        "valenceAvg": round(sum(val) / len(val), 3),
        "arousalAvg": round(sum(aro) / len(aro), 3),
        "arousalMax": round(max(aro), 3),
        "arousalMaxAt": points[aro.index(max(aro))]["index"],
        "dialogueAvg": round(sum(dia) / len(dia), 3),
        "longest": max(p["chars"] for p in points),
        "shortest": min(p["chars"] for p in points),
    }
