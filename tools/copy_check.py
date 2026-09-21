#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文案体检（第 22 轮 · 用户点名"太口语化了，太不正经了"）。

用户原话：
> 「不太沉稳一部分地方还存在的，比如说"呃这是某本书的什么什么东西，然后怎么怎么样"，
>   **太口语化了，太不正经了**」

这条以前只能靠人肉读 —— 现在做成机器判据，**能报红**：
  ① **语气词**：呃 / 呀 / 哈 / 啦 / 哦 / 嘛 / 诶 / 嘞 / 噢 / 呦 —— 界面上一个都不许有；
  ② **口水话词表**：咱们 / 大伙 / 干啥 / 咋样 / 一堆 / 一丢丢 / 玩意儿 / 忽悠 …
  ③ **过长句子**：一句中文 > `MAX_LEN` 字（手机上读起来是"一坨"）—— 单独列出来，不直接判红。
  ④ **开发术语**（第 29 轮加，监督人点名）：落盘 / 收件箱 / 入队 / 幂等 / 契约 / 拉取 / 落库 /
     埋点 / 端点 … —— 这些是**我们自己干活时的黑话**，不许端到用户面前。
     用户原话：「太口语化了，太不正经了」；黑话比口语更糟：他根本看不懂。
     确实必须用的地方（比如说明里要提到"同步"），在那一行的源码里写 `copy-ok` 就能豁免，
     这样豁免是**看得见、要解释**的，不是悄悄放过。

只查**用户看得见的文字**：JS / HTML 里的字符串字面量与文本节点、CSS 的 `content:`。
**注释不算**（`//` `/* */` 会先被剥掉），所以不会把"我们自己的说明"当成界面文案。

反证：`COPY_FORCE=bad` 会塞一条假的口语文案 —— 这一条**必须报红**（脚本此时必须 exit 1）。

用法：python3 tools/copy_check.py [-v]
产出：docs/文案体检.json
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONT = ROOT / "frontend"
OUT = ROOT / "docs" / "文案体检.json"
VERBOSE = "-v" in sys.argv

# ① 语气词（一字命中）。这些字在正经界面文案里不该出现。
PARTICLES = "呃呀哈啦哦嘛诶嘞噢呦"
# ② 口水话 / 口语词组（看着就"不正经"）
FILLERS = ["咱们", "大伙", "干啥", "咋样", "咋办", "一丢丢", "玩意儿", "忽悠",
           "瞎搞", "搞一下", "弄一下", "啥东西", "什么的吧", "之类的吧", "先说好",
           "跟你讲", "老实说", "反正就", "随便点", "凑合"]
# ④ 开发术语（黑话）。命中即判红 —— 除非那一行源码里带了 `copy-ok`（豁免要可见、要解释）。
DEV_JARGON = ["落盘", "收件箱", "入队", "出队", "幂等", "契约", "拉取", "落库",
              "埋点", "打点", "端点", "入参", "出参", "序列化", "反序列化",
              "缓存穿透", "幂等性", "灰度", "回滚到", "落表"]
CJK = re.compile(r"[\u4e00-\u9fff]")
MAX_LEN = 30          # 一句中文超过这个长度 → 列出来（不判红，供人工收）

# ── 一次扫描：剥注释 + 只收「字符串字面量」（正则字面量也认，免得引号被误当字符串）──
# 为什么不用"先剥注释再正则找引号"：正则字面量 `/['"]/` 里的引号会把状态机带偏，
# 一偏就把后面的**注释**当成界面文案读出来（假阳性）—— 假阳性会掩盖真问题，所以宁可按字扫描。
def strip_css_comments(src: str) -> str:
    def rep(m):
        return "".join(ch if ch == "\n" else " " for ch in m.group(0))
    return re.sub(r"/\*.*?\*/", rep, src, flags=re.S)


REGEX_OK_BEFORE = set("(,=:[!&|?{};+-*%~^<>") | {""}
REGEX_KW = ("return", "typeof", "instanceof", "in", "of", "case", "do", "else",
            "void", "delete", "new", "yield", "await")


def js_strings(src: str) -> list[tuple[int, str]]:
    """返回 [(行号, 字符串内容)]，只包含字符串字面量（模板串算整体）。"""
    out: list[tuple[int, str]] = []
    i, n = 0, len(src)
    prev_sig = ""            # 上一个"有效"字符（用来判 / 是不是正则）
    prev_word = ""           # 上一个标识符（判 return / typeof 之类）
    line = 1
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1; i += 1; continue
        if c == "/" and src[i:i + 2] == "//":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and src[i:i + 2] == "/*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            line += src.count("\n", i, j)
            i = j
            continue
        if c in "\"'`":
            q, start_line, j = c, line, i + 1
            buf = []
            while j < n:
                ch = src[j]
                if ch == "\\":
                    buf.append(src[j:j + 2]); j += 2; continue
                if ch == q:
                    break
                if ch == "\n":
                    line += 1
                buf.append(ch); j += 1
            out.append((start_line, "".join(buf)))
            i = j + 1
            prev_sig = q; prev_word = ""
            continue
        if c == "/" and (prev_sig in REGEX_OK_BEFORE or prev_word in REGEX_KW):
            j, in_cls = i + 1, False          # 正则字面量：跳到配对的 /
            while j < n:
                ch = src[j]
                if ch == "\\":
                    j += 2; continue
                if ch == "[":
                    in_cls = True
                elif ch == "]":
                    in_cls = False
                elif ch == "/" and not in_cls:
                    break
                elif ch == "\n":
                    break
                j += 1
            i = j + 1
            prev_sig = "/"; prev_word = ""
            continue
        if c.isalnum() or c == "_" or c == "$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            prev_word = src[i:j]; prev_sig = src[j - 1]
            i = j
            continue
        if not c.isspace():
            prev_sig = c
            if c not in ".":
                prev_word = ""
        i += 1
    return out


# ── 取出"用户看得见的文字" ────────────────────────────────────────
HTML_TAG = re.compile(r"<[^>]+>")
CSS_CONTENT = re.compile(r"""content\s*:\s*(['"])((?:\\.|(?!\1)[^\\])*?)\1""")


def line_of(src: str, pos: int) -> int:
    return src.count("\n", 0, pos) + 1


def text_nodes(html: str) -> list[tuple[int, str]]:
    """HTML 文本节点（把标签换成空格，保留换行 → 行号不错位）。"""
    flat = HTML_TAG.sub(lambda m: "".join(ch if ch == "\n" else " " for ch in m.group(0)), html)
    return [(line_of(flat, m.start()), m.group(0).strip())
            for m in re.finditer(r"[^\n\s][^\n<]*", flat) if CJK.search(m.group(0))]


def collect_files() -> list[Path]:
    files = []
    for pat in ("js/*.js", "css/*.css", "*.html"):
        files += sorted(FRONT.glob(pat))
    return [f for f in files if f.name not in ("ui.js.bak",)]


def scan(path: Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    raw_lines = raw.split("\n")
    rel = str(path.relative_to(ROOT))
    hits: list[dict] = []
    items: list[tuple[int, str]] = []
    if path.suffix == ".css":
        src = strip_css_comments(raw)
        items = [(line_of(src, m.start(2)), m.group(2)) for m in CSS_CONTENT.finditer(src)]
    elif path.suffix == ".html":
        items = text_nodes(raw)
    else:
        items = js_strings(raw)
    for ln, text in items:
        if not CJK.search(text):
            continue
        # `copy-ok` 豁免：写在同一行源码上（豁免看得见，评审时能问"为什么"）
        exempt = "copy-ok" in (raw_lines[ln - 1] if 0 < ln <= len(raw_lines) else "")
        for w in ([] if exempt else DEV_JARGON):
            if w in text:
                hits.append({"file": rel, "line": ln, "kind": "开发术语", "word": w,
                             "text": text[:80], "level": "red"})
        for ch in PARTICLES:
            if ch in text:
                hits.append({"file": rel, "line": ln, "kind": "语气词", "word": ch,
                             "text": text[:80], "level": "red"})
        for w in FILLERS:
            if w in text:
                hits.append({"file": rel, "line": ln, "kind": "口水话", "word": w,
                             "text": text[:80], "level": "red"})
        # 断句：句末标点 + 换行，外加冒号与顿号 —— 它们本身就是分句/分项符，
        # 不分的话"列一串东西"会被当成一个长句（误报）。
        for sent in re.split(r"[。！？…；\n：、]", text):
            s = re.sub(r"[\s·—\-]+", "", sent)
            if len(CJK.findall(s)) > MAX_LEN:
                hits.append({"file": rel, "line": ln, "kind": "过长句", "word": f"{len(CJK.findall(s))} 字",
                             "text": s[:120], "level": "warn"})
    return hits


def main() -> int:
    hits: list[dict] = []
    for f in collect_files():
        hits += scan(f)
    if os.environ.get("COPY_FORCE") == "bad":
        hits.append({"file": "frontend/js/__force__.js", "line": 1, "kind": "语气词", "word": "呀",
                     "text": "呃这个是某本书的小方块呀", "level": "red"})
        print("  ⚠ 反证模式 COPY_FORCE=bad：塞了一条口语文案（必须报红）")
    if os.environ.get("COPY_FORCE") == "jargon":
        hits.append({"file": "frontend/js/__force__.js", "line": 1, "kind": "开发术语", "word": "落盘",
                     "text": "写进去的内容会进「改动」收件箱等你确认", "level": "red"})
        print("  ⚠ 反证模式 COPY_FORCE=jargon：塞了一条黑话（必须报红）")
    red = [h for h in hits if h["level"] == "red"]
    warn = [h for h in hits if h["level"] != "red"]
    OUT.write_text(json.dumps({
        "files": [str(f.relative_to(ROOT)) for f in collect_files()],
        "rules": {"particles": PARTICLES, "fillers": FILLERS, "jargon": DEV_JARGON,
                  "max_len": MAX_LEN},
        "red": red, "warn": warn,
        "count": {"red": len(red), "warn": len(warn)},
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    for h in (red + warn if VERBOSE else red):
        print(f"  {'✗' if h['level'] == 'red' else '·'} [{h['kind']}:{h['word']}] {h['file']}:{h['line']} —— {h['text']}")
    print(f"语气词/口水话 {len(red)} 条（判红）；过长句 {len(warn)} 条（供人工收）→ {OUT.relative_to(ROOT)}")
    return 1 if red else 0


if __name__ == "__main__":
    sys.exit(main())
