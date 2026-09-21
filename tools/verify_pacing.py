#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""节奏/情绪曲线 + 角色一致性体检 + 参考书架 三块的实测。

三块都是"写完才有用"的东西，所以测法也是**造一本有毛病的书**，看它挑不挑得出来：
  节奏：连着几章都在吵 / 连着几章没对话 → 必须报警，并指出是哪几章
  一致性：年龄漂移、发色冲突、他她混用、名字只差一个字、角色消失 → 每条带出处
  参考书架：增删改查 + 标签/关键词筛选 + **挑的范文真的进写正文的提示词** + 边界
跑法：server/venv/bin/python tools/verify_pacing.py
产出：docs/节奏与一致性实测.json
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "节奏与一致性实测.json"
TITLE = "节奏实测-" + time.strftime("%m%d-%H%M%S")
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


PAD = ("天亮了。院子里的柴垛码得整整齐齐，门上贴的红纸被雨水泡得发白。\n"
       "屋里有一张旧桌子，两条腿用麻绳捆着，桌角刻着几道记号。\n")

CH = {
 "001-开篇": PAD + """那年林诺十七岁，黑发，瘦得像根竹竿。沈岩站在门口，看了他很久。老周蹲在门槛上抽烟，没说话。

“进来。”沈岩说。
“我不冷。”林诺说。
沈岩说：“进来。”
林诺跺了跺脚，他还是进去了。他站在灯下，慢慢把帽子摘下来，把雪抖在地上。
老周把烟头按灭了，说了一句“这娃子倔”，就往屋里走，再没回头。
""",
 "002-争吵一": PAD + """林诺把碗摔在桌上，汤水淌了一桌。

“凭什么是我去。”林诺说。
“因为你年纪小。”沈岩说。
“这也是理由？”林诺说。
林诺很生气，他觉得委屈，他难受极了，他恨透了这间屋子，恨透了这张桌子。
他咬着牙不说话，屋里的灯芯跳了跳，他忽然觉得胸口很闷，闷得喘不上气。
他恨这种被人安排的日子，恨得手都在发抖。
""",
 "003-争吵二": PAD + """第二天他们又吵。林诺不肯低头，沈岩也不肯。

“你就是看不起我。”林诺说。
“随你怎么想。”沈岩说。
林诺疼得不想说话。他恨自己没用，恨自己害怕，恨自己哭，恨得眼泪都下来了。
他觉得委屈，觉得难受，觉得这屋子压得他喘不过气。他攥紧了拳头，一句话都说不出来。
他沉默了很久，最后摔门出去了。门外很冷，冷得他发抖。
""",
 "004-争吵三": PAD + """雪还在下。林诺银发被风吹乱，她站在门口不肯进来。沈岩已经十九岁了，他不想再哄。

“我恨你。”林诺说。
“恨吧。”沈岩说。
林诺绝望地看着门外，她哭不出来，只觉得冷。他疼。他难受。他委屈。
他恨这雪，恨这屋子，恨自己走不动。她咬着牙，把眼泪咽了回去。
他最后还是没进来，就在雪里站着，站到灯都灭了。
""",
 "005-动手": PAD + """刀突然劈下来，沈岩猛地扑上去，抓住林诺的手腕，撞开窗户，血色在雪上炸开。

“跑！”沈岩吼道。
林诺拼命地跑，跳下台阶，翻过墙，摔在雪里。他咬着牙爬起来，冲着黑暗里吼了一声。
紧张攥住了他的心，他忽然觉得，这一夜会改变一切。远处传来一声闷响，火光照亮了半边的林子。
他攥紧手里的东西，冷汗顺着背往下淌，心跳得几乎要炸开。
""",
 "006-喘息": PAD + """事情过去了。他一个人坐在墙角，手还在抖，疼得厉害，怎么也缓不下来。

他把刀放在脚边，看着上面的血，心里发冷。他害怕，怕得说不出话，也恨自己刚才那一下。
锅在火上响着，他一口都没喝。他缩在墙边，闭着眼，很久很久没有动。
""",
 "007-平静": PAD + """接下来的几天很平静。他们修好了窗户，煮了热汤，把门前的雪扫出一条路。

“以后别乱跑。”沈岩说。
“知道了。”林诺说。
林诺把汤喝完了，觉得很舒服。他笑起来，眼角都是暖的，觉得日子还可以这么过。
他靠在门框上，看着路上的脚印一条一条被雪填平，心里踏实得很。
""",
 "008-尾声": PAD + """春天来了。林偌说：“我们该走了。”

沈岩没有回答。他看着远处的山，慢慢地笑了。林诺也笑了，他们一起把门关上。
远处的雪线退了下去，路上开始有人。他们不知道该去哪里，但知道要往前走。
风是暖的，路是软的，两个人的影子拉得很长很长。
""",
}


def main() -> int:
    api("POST", "/api/app/login", json={"password": password()})
    b = api("POST", "/api/projects", json={"title": TITLE, "summary": "自动化测试用书（跑完自删）", "kind": "novel"})
    slug = (b[1] or {}).get("projectRoot") or (b[1] or {}).get("slug")
    assert slug, b
    for name, text in CH.items():
        api("POST", "/api/import/text", json={"slug": slug, "name": name, "text": text, "prefix": "manuscript"})
    api("POST", "/api/world/entity", json={"slug": slug, "kind": "character", "name": "林诺"})
    api("POST", "/api/world/entity", json={"slug": slug, "kind": "character", "name": "沈岩"})
    api("POST", "/api/world/entity", json={"slug": slug, "kind": "character", "name": "老周"})

    # ── 一、节奏曲线 ──
    st, cur = api("GET", "/api/pacing/curve", params={"slug": slug})
    pts = cur.get("points") or []
    check("曲线按章给出（8 章 8 个点，按顺序）",
          st == 200 and len(pts) >= 8 and [p["index"] for p in pts] == sorted(p["index"] for p in pts),
          "点数 %d" % len(pts))
    check("每个点都有张力/情绪/对话占比/句长/动作密度",
          all(all(k in p for k in ("arousal", "valence", "dialogue", "avgSent", "action")) for p in pts),
          json.dumps(pts[0], ensure_ascii=False)[:220])
    keys = {a["key"] for a in (cur.get("alerts") or [])}
    check("挑出「连着几章都在吵」（情绪同向没起伏）", "flat_negative" in keys, json.dumps(sorted(keys), ensure_ascii=False))
    check("挑出「连着几章没对话」", "no_dialogue" in keys, json.dumps(sorted(keys), ensure_ascii=False))
    check("报警指得出是哪几章、并且给得出改法",
          all(a.get("from") and a.get("to") and a.get("chapters") and a.get("advice") and a.get("paths")
              for a in cur["alerts"]),
          json.dumps((cur.get("alerts") or [{}])[0], ensure_ascii=False)[:300])
    def at(name):
        return next(p for p in pts if p["path"].endswith(name))
    fight, calm = at("005-动手.md"), at("007-平静.md")
    check("打斗那一章的张力明显高于平静章（曲线分得开，不是一条直线）",
          fight["arousal"] > calm["arousal"] and fight["arousal"] - calm["arousal"] >= 0.2
          and fight["action"] > calm["action"],
          "动手 %.2f/%.2f vs 平静 %.2f/%.2f" % (fight["arousal"], fight["action"], calm["arousal"], calm["action"]))
    check("情绪正负也是分得开的（争吵章偏负、喘息章偏正）",
          at("003-争吵二.md")["valence"] < -0.2 and at("007-平静.md")["valence"] > 0.2,
          "争吵二 %.2f / 平静 %.2f" % (at("003-争吵二.md")["valence"], at("007-平静.md")["valence"]))
    check("摘要给得出全书平均与最高点在第几章",
          (cur.get("summary") or {}).get("chapters") == len(pts) and cur["summary"].get("arousalMaxAt"),
          json.dumps(cur.get("summary"), ensure_ascii=False)[:220])

    # 单章
    st, one = api("GET", "/api/pacing/one", params={"slug": slug, "path": "manuscript/005-动手.md"})
    check("单章形状算得出来（写作台要看这一章的节奏）", st == 200 and one["metrics"]["chars"] > 50, st)
    st, bad = api("GET", "/api/pacing/one", params={"slug": slug, "path": ""})
    check("单章不带 path 会被 400 拒掉", st == 400, "%s %s" % (st, bad))

    # ── 二、角色一致性体检 ──
    st, rep = api("GET", "/api/consistency/report", params={"slug": slug})
    iss = rep.get("issues") or []
    ks = {i["key"] for i in iss}
    check("体检报告有评分/等级/统计", st == 200 and isinstance(rep.get("score"), int) and rep.get("grade")
          and rep["stats"]["people"] >= 2, json.dumps(rep.get("stats"), ensure_ascii=False))
    check("年龄漂移被挑出来（17 岁 → 19 岁）", "age_drift" in ks, json.dumps(sorted(ks), ensure_ascii=False))
    check("发色冲突被挑出来（黑发 → 银发）", "hair_conflict" in ks, json.dumps(sorted(ks), ensure_ascii=False))
    check("他/她混用被挑出来", "pronoun_mix" in ks, json.dumps(sorted(ks), ensure_ascii=False))
    check("名字只差一个字被挑出来（林偌 / 林诺）", "similar_name" in ks, json.dumps(sorted(ks), ensure_ascii=False))
    check("消失的角色被点名（老周只在第 1 章出现）", "missing_character" in ks, json.dumps(sorted(ks), ensure_ascii=False))
    age = next((i for i in iss if i["key"] == "age_drift"), None)
    check("每条都带出处（哪一章第几行 + 原句）",
          bool(age and age["where"] and age["where"][0]["path"] and age["where"][0]["line"] >= 1
               and age["where"][0]["quote"]),
          json.dumps(age, ensure_ascii=False)[:300] if age else "没有 age_drift")
    sim = next((i for i in iss if i["key"] == "similar_name"), None)
    st, ali = api("POST", "/api/consistency/alias", json={"slug": slug, "name": "林诺", "alias": "林偌"})
    st2, rep2 = api("GET", "/api/consistency/report", params={"slug": slug})
    check("「是笔误/是另一个人」能一键登记成别名，登记后不再报",
          st == 200 and ali.get("ok") and "similar_name" not in {i["key"] for i in rep2.get("issues") or []},
          json.dumps({"alias": ali, "left": [i for i in (rep2.get("issues") or []) if i["key"] == "similar_name"]}, ensure_ascii=False)[:400])
    st, bad = api("POST", "/api/consistency/alias", json={"slug": slug, "name": "林诺", "alias": ""})
    check("别名参数不全时 400", st == 400, st)

    # ── 三、参考书架 ──
    st, r1 = api("POST", "/api/refs/item", json={"slug": slug, "title": "打斗怎么写（范例）",
        "source": "某武侠小说第 3 章", "tags": "打斗,节奏", "kind": "excerpt",
        "text": "刀光一闪，他没有退。风从左侧压过来，他侧身，刀背贴着小臂滑过去，鞋底在碎石上碾出一声轻响。" * 8})
    check("能往书架里放一条（带标签）", st == 200 and r1.get("id"), st)
    rid = r1.get("id")
    st, r2 = api("POST", "/api/refs/item", json={"slug": slug, "title": "对白心得", "source": "自己记的",
        "tags": ["对白"], "kind": "note", "text": "短句让人显得冷。"})
    st, lst = api("GET", "/api/refs", params={"slug": slug})
    check("列得出来，标签聚合也对", len(lst.get("items") or []) == 2 and set(lst.get("tags") or []) == {"打斗", "节奏", "对白"},
          json.dumps(lst.get("tags"), ensure_ascii=False))
    st, fq = api("GET", "/api/refs", params={"slug": slug, "q": "刀光"})
    check("关键词搜得到（搜正文而不只是标题）", len(fq.get("items") or []) == 1 and fq["items"][0]["id"] == rid, len(fq.get("items") or []))
    st, ft = api("GET", "/api/refs", params={"slug": slug, "tag": "对白"})
    check("按标签筛得到", len(ft.get("items") or []) == 1 and ft["items"][0]["title"] == "对白心得", len(ft.get("items") or []))
    st, got = api("GET", "/api/refs/item", params={"slug": slug, "id": rid})
    st, lst0 = api("GET", "/api/refs", params={"slug": slug})
    prev = next(i["preview"] for i in lst0["items"] if i["id"] == rid)
    check("打开一条能看到**全文**（列表里那个只是摘要）",
          st == 200 and len(got.get("text") or "") > len(prev) + 50,
          "全文 %d 字 vs 列表摘要 %d 字" % (len(got.get("text") or ""), len(prev)))
    st, upd = api("POST", "/api/refs/item", json={"slug": slug, "id": rid, "title": "打斗怎么写（改过）",
        "text": "改过的正文。", "tags": ["打斗"]})
    st2, got2 = api("GET", "/api/refs/item", params={"slug": slug, "id": rid})
    check("能改（id 给了就是改，不新增）", upd.get("updated") is True and got2["title"].endswith("（改过）")
          and len((api("GET", "/api/refs", params={"slug": slug})[1]).get("items") or []) == 2, "条数 %d" % len((api("GET", "/api/refs", params={"slug": slug})[1]).get("items") or []))
    st, snip = api("GET", "/api/refs/snippets", params={"slug": slug, "ids": str(rid)})
    check("按 id 取片段（给写作链路用）", st == 200 and len(snip.get("items") or []) == 1, st)
    st, ctx2 = api("POST", "/api/write/preview", json={"slug": slug, "path": "manuscript/005-动手.md",
                                                       "mode": "continue", "refs": [rid]})
    txt = json.dumps(ctx2, ensure_ascii=False)
    check("挑的范文真的进了写正文的提示词（带「不要抄句子」的提醒）",
          st == 200 and "参考写法" in txt and "不要抄句子" in txt and "改过的正文" in txt,
          "preview 返回 %s / 字数 %s" % (st, (ctx2 or {}).get("chars")))
    check("预演同时报出「这次带了参考/带了声音档案」",
          (ctx2 or {}).get("hasRefs") is True, json.dumps({k: (ctx2 or {}).get(k) for k in ("hasRefs", "hasVoice")}, ensure_ascii=False))
    st, e1 = api("POST", "/api/refs/item", json={"slug": slug, "title": "", "text": "x"})
    check("空标题被 400 拒掉", st == 400, st)
    st, e2 = api("POST", "/api/refs/item", json={"slug": slug, "title": "太长", "text": "字" * 200_001})
    check("超长文本被 400 拒掉（不静默截断）", st == 400 and "太长" in str(e2), "%s %s" % (st, str(e2)[:120]))
    st, e3 = api("DELETE", "/api/refs/item", params={"slug": slug, "id": 999999})
    check("删不存在的条目返回 404", st == 404, st)
    st, d1 = api("DELETE", "/api/refs/item", params={"slug": slug, "id": rid})
    check("删得掉（软删不适用：这里就是用户的摘抄，删了就是删了）", st == 200 and d1.get("deleted") == 1, st)
    st, empty = api("GET", "/api/refs", params={"slug": slug})
    check("空数据：书里没参考时返回空数组而不是报错", st == 200 and isinstance(empty.get("items"), list), st)

    # ── 收尾 ──
    st, gone = api("DELETE", "/api/projects/item", params={"projectRoot": slug})
    check("测试书进回收站（不留垃圾）", st == 200, str(gone)[:120])

    passed = sum(1 for r in results if r["ok"])
    OUT.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE, "scratchBook": TITLE,
        "total": len(results), "passed": passed, "failed": len(results) - passed,
        "curve": cur, "consistency": rep, "items": results}, ensure_ascii=False, indent=1), "utf-8")
    print("\n=== 节奏/一致性/参考书架 实测：%d/%d ===" % (passed, len(results)))
    print("报告：" + str(OUT.relative_to(ROOT)))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
