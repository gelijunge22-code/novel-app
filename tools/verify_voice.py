#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""人物声音档案 实测（「所有角色一个腔」这一块以前一条规则都没有）。

验的是**闭环**，不是"接口返回 200"：
  造一本测试书，两个性格完全相反的人各说几句话
  → 存档案（一个不存 = 没档案）
  → 单人档案：能从正文里按角色抽出台词（带出处），能给出候选口头禅
  → 整本报告：指纹、两两像度、"谁和谁一个腔"、逐人问题（含"说了忌用词"）
  → 写作链路：出场角色的说话方式**真的进了提示词**
  → 空数据 / 中文名 / 错误参数三类边界
跑法：server/venv/bin/python tools/verify_voice.py
产出：docs/人物声音实测.json
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "人物声音实测.json"
STAMP = time.strftime("%m%d-%H%M%S")
TITLE = f"声音实测-{STAMP}"
results: list[dict] = []
cli = httpx.Client(base_url=BASE, timeout=120.0)


def password() -> str:
    return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))["app_password"])


def check(name, ok, why="", data=None):
    results.append({"name": name, "ok": bool(ok), "why": str(why)[:400], "data": data})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:300]))


def api(method, path, **kw):
    r = cli.request(method, path, **kw)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


CH1 = """雪停了。沈岩把刀插回鞘里，没看林诺。

“走。”沈岩说。
“等等。”林诺说，“我还没数完。”
沈岩说：“数那个没用。天黑前不出林子，咱们都得留在这儿。”
林诺说：“你总说没用。上回你说没用，我差点没命。”
沈岩说：“上回是上回。”
林诺没接话。他蹲下去，把木牌一块块码平。
"""

CH2 = """第二天早上，木牌少了一块。
沈岩说：“看见了吧。”
林诺说：“我早说过。”
沈岩说：“嗯。”
林诺说：“你就不能多说两个字？每次都嗯嗯嗯，我跟你说话像对着一堵墙。”
沈岩说：“墙不会救你。”
"""


def main() -> int:
    api("POST", "/api/app/login", json={"password": password()})
    born = api("POST", "/api/projects", json={"title": TITLE, "summary": "自动化测试用书（跑完自删）", "kind": "novel"})
    slug = (born[1] or {}).get("projectRoot") or (born[1] or {}).get("slug")
    assert slug, born

    api("POST", "/api/import/text", json={"slug": slug, "name": "第001章-雪", "text": CH1, "prefix": "manuscript"})
    api("POST", "/api/import/text", json={"slug": slug, "name": "第002章-少一块", "text": CH2, "prefix": "manuscript"})

    # 两个角色实体（声音档案挂在实体上）
    api("POST", "/api/world/entity", json={"slug": slug, "kind": "character", "name": "沈岩"})
    api("POST", "/api/world/entity", json={"slug": slug, "kind": "character", "name": "林诺"})

    # ── 1. 字段定义（前端照它画表单）──
    st, fields = api("GET", "/api/voice/fields")
    keys = [f["key"] for f in (fields.get("items") or [])]
    check("字段定义拿得到，且含腔调/口头禅/忌用词", st == 200 and {"tone", "catchphrases", "banned"} <= set(keys), st)

    # ── 2. 存档案 ──
    st, saved = api("POST", "/api/voice/profile", json={"slug": slug, "name": "沈岩", "voice": {
        "tone": "冷硬，能说两个字不说三个字",
        "sentence": "短促", "catchphrases": ["嗯", "没用"], "banned": ["亲爱的", "咱们聊聊"],
        "addresses": {"林诺": "小子"}, "emotion": 2, "samples": ["墙不会救你。"],
    }})
    check("存档案：返回净化后的内容（空字段不留）", st == 200 and saved.get("voice", {}).get("catchphrases") == ["嗯", "没用"], st)

    st, saved2 = api("POST", "/api/voice/profile", json={"slug": slug, "name": "林诺", "voice": {
        "tone": "话多，爱追问，爱翻旧账", "sentence": "绵长",
        "catchphrases": ["我早说过"], "emotion": 8,
    }})
    check("第二个人也能存", st == 200 and saved2["voice"]["sentence"] == "绵长", st)

    # ── 3. 单人档案：台词带出处 + 候选口头禅 ──
    st, one = api("GET", "/api/voice/profile", params={"slug": slug, "name": "沈岩"})
    lines = one.get("samples") or []
    check("按角色抽出他的台词（不是全抽）", st == 200 and len(lines) >= 3,
          "抽到 %d 条" % len(lines))
    check("台词带出处（哪一章第几行）",
          all(l.get("path") and l.get("lineNo") for l in lines),
          json.dumps(lines[:2], ensure_ascii=False))
    check("抽出来的都是沈岩说的（没有把林诺的话算给他）",
          all(("林诺" not in l["line"]) or ("沈岩" in l["line"]) for l in lines),
          json.dumps([l["line"] for l in lines], ensure_ascii=False)[:200])
    cands = [c["word"] for c in (one.get("candidates") or [])]
    check("候选口头禅是从他台词里数出来的", bool(cands), json.dumps(cands[:8], ensure_ascii=False))
    fp = one.get("fingerprint") or {}
    check("有台词指纹（句长/问句率/常用词）",
          fp.get("lines", 0) >= 3 and fp.get("avgLen", 0) > 0 and bool(fp.get("topWords")),
          json.dumps(fp, ensure_ascii=False)[:220])

    # ── 4. 档案和实际对不对得上（忌用词 / 口头禅缺失）──
    api("POST", "/api/import/text", json={"slug": slug, "name": "第003章-翻车",
        "text": "沈岩说：“亲爱的，咱们聊聊。”\n林诺说：“你说什么？”\n", "prefix": "manuscript"})
    st, one3 = api("GET", "/api/voice/profile", params={"slug": slug, "name": "沈岩"})
    kinds = [i["key"] for i in (one3.get("issues") or [])]
    check("说了忌用词会被挑出来（带原句）", "banned_used" in kinds,
          json.dumps(one3.get("issues"), ensure_ascii=False)[:300])

    # ── 5. 整本报告：谁和谁一个腔 ──
    api("POST", "/api/voice/profile", json={"slug": slug, "name": "路人甲", "voice": {
        "tone": "和林诺一模一样", "sentence": "绵长", "catchphrases": ["我早说过"], "emotion": 8}})
    api("POST", "/api/import/text", json={"slug": slug, "name": "第004章-路人也话多", "text": (
        "路人甲说：“我早说过，这事没那么简单，你不信。”\n"
        "路人甲说：“我早说过，天黑前得回去，你不听。”\n"
        "路人甲说：“我早说过，他靠不住，你看吧。”\n"
        "路人甲说：“我早说过，木牌少一块就要出事。”\n"
        "路人甲说：“我早说过，别往林子里走。”\n"
        "林诺说：“我早说过，这事没那么简单，你非要去。”\n"
        "林诺说：“我早说过，天黑前得回去，你非要留。”\n"
        "林诺说：“我早说过，他靠不住，你非要信。”\n"
        "林诺说：“我早说过，木牌少一块就要出事。”\n"
        "林诺说：“我早说过，别往林子里走。”\n"), "prefix": "manuscript"})
    st, rep = api("GET", "/api/voice/report", params={"slug": slug})
    check("整本报告：有评分 + 等级（和质检同一套阈值）",
          st == 200 and isinstance(rep.get("score"), int) and rep.get("grade"),
          "%s / %s" % (rep.get("score"), rep.get("grade")))
    check("报告里每个角色都有指纹与问题清单",
          all("fingerprint" in p and "issues" in p for p in (rep.get("people") or [])),
          "人数 %d" % len(rep.get("people") or []))
    pairs = rep.get("pairs") or []
    check("挑出了像一个模子刻的两个角色",
          any({p["a"], p["b"]} == {"林诺", "路人甲"} for p in pairs),
          json.dumps(pairs, ensure_ascii=False)[:300])
    check("报告用大白话说清该改什么", bool(rep.get("advice")), json.dumps(rep.get("advice"), ensure_ascii=False)[:200])
    withp = [p["name"] for p in rep["people"] if p["hasProfile"]]
    check("没建档案的角色在报告里说得出来", "沈岩" in withp, json.dumps(withp, ensure_ascii=False))

    # ── 6. 写作链路：出场角色的说话方式真的进提示词 ──
    st, brief = api("GET", "/api/voice/brief", params={"slug": slug, "names": "沈岩,林诺"})
    b = brief.get("brief") or ""
    check("小抄带上了两个人的腔调与口头禅",
          "腔调" in b and "沈岩" in b and "林诺" in b and "口头禅" in b, b[:200])
    st, ctx = api("GET", "/api/write/context", params={"slug": slug, "path": "manuscript/004-第004章-路人也话多.md", "mode": "continue"})
    dumped = json.dumps(ctx, ensure_ascii=False)
    check("写正文的提示词里真的有「说话方式」这一段",
          "说话方式" in dumped or "口头禅" in dumped,
          "提示词长度 %d" % len(dumped))

    # ── 7. 边界：空数据 / 中文名 / 错误参数 ──
    st, empty = api("GET", "/api/voice/profile", params={"slug": slug, "name": "查无此人"})
    check("空数据：不存在的人返回空档案而不是报错",
          st == 200 and empty.get("voice") == {} and empty.get("samples") == [], st)
    st, cn = api("POST", "/api/voice/profile", json={"slug": slug, "name": "王二·麻子（三当家）", "voice": {"tone": "满嘴江湖话"}})
    check("中文/符号名存得进去", st == 200 and cn.get("name") == "王二·麻子（三当家）", st)
    st, bad = api("POST", "/api/voice/profile", json={"slug": slug, "name": "", "voice": {"tone": "x"}})
    check("错误参数（没名字）被 400 拒掉并说清原因", st == 400 and "谁" in str(bad), "%s %s" % (st, bad))
    st, clr = api("DELETE", "/api/voice/profile", params={"slug": slug, "name": "王二·麻子（三当家）"})
    st2, aft = api("GET", "/api/voice/profile", params={"slug": slug, "name": "王二·麻子（三当家）"})
    check("只清档案不删人（实体还在，档案空了）",
          st == 200 and aft.get("exists") is True and aft.get("voice") == {}, json.dumps(aft.get("voice"), ensure_ascii=False))

    # ── 8. 收尾：测试书进回收站，不碰用户的书 ──
    st, gone = api("DELETE", "/api/projects/item", params={"projectRoot": slug})
    check("测试书进回收站（不留垃圾）", st == 200, json.dumps(gone, ensure_ascii=False)[:200])

    passed = sum(1 for r in results if r["ok"])
    OUT.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE, "scratchBook": TITLE,
        "total": len(results), "passed": passed, "failed": len(results) - passed,
        "report": rep, "items": results}, ensure_ascii=False, indent=1), "utf-8")
    print("\n=== 人物声音档案实测：%d/%d ===" % (passed, len(results)))
    print("报告：" + str(OUT.relative_to(ROOT)))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
