#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多 Agent 真分工实测（监督人 N5）：三种模式各跑一次**真模型**，看编排是不是真的分工。

和引擎单测的分工：
  * tools/test_engine.py 的 E 段 —— 不花钱，打在函数上（权限矩阵、越权真被挡）；
  * 这个脚本 —— 真调模型，验"编排层有没有真的把活分下去"：
      讨论：只有主创与挑刺来回，没人动文件
      计划：主创排 → 取上下文取料 → 查证核实 → 主创定稿，没人写正文
      执行：七个角色步骤全跑，写手只往 manuscript/ 写，挑刺拿到初稿，主创收尾
    还要验：每一棒真的读到了上一棒交的东西（handoff 非空且递增）、
            角色可见范围不同、被权限挡下来的调用都被记下来了。

跑法：server/venv/bin/python tools/verify_orchestra.py
产出：docs/多Agent编排实测.json
规矩：在**临时测试书**上跑（跑完进回收站），不碰用户的书。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "多Agent编排实测.json"
MODEL = "渠道/[渠道]某模型"
STAMP = time.strftime("%m%d-%H%M%S")
TITLE = f"编排实测-{STAMP}"
results: list[dict] = []
cli = httpx.Client(base_url=BASE, timeout=120.0)


def password() -> str:
    d = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
    return str(d.get("app_password") or "")


def check(name: str, ok: bool, why: str = "", data=None) -> None:
    results.append({"name": name, "ok": bool(ok), "why": str(why)[:400],
                    "data": data if data is not None else None})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:300]))


def api(method: str, path: str, **kw):
    r = cli.request(method, path, **kw)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


def new_session(slug: str) -> int:
    st, d = api("POST", "/api/agent/sessions", json={
        "profileKey": "leader.default", "currentProjectRoot": slug,
        "modelKey": MODEL, "title": "编排实测"})
    assert st == 200, (st, d)
    return int(d["sessionId"])


def invoke(sid: int, mode: str, text: str) -> None:
    st, d = api("POST", f"/api/agent/sessions/{sid}/invocations",
                json={"mode": mode, "text": text})
    assert st == 200, (st, d)
    # 等它跑完（编排要串好几次模型，给足时间）
    for _ in range(120):
        time.sleep(3)
        _, snap = api("GET", f"/api/agent/sessions/{sid}/runs?limit=1")
        runs = snap.get("runs") or []
        if runs and runs[0]["status"] != "running":
            return
    raise TimeoutError("编排跑太久没结束：" + mode)


def last_run(sid: int) -> dict:
    _, d = api("GET", f"/api/agent/sessions/{sid}/runs?limit=1")
    return (d.get("runs") or [{}])[0]


def main() -> int:
    st, _ = api("POST", "/api/app/login", json={"password": password()})
    assert st == 200, "登录失败"
    st, born = api("POST", "/api/projects", json={
        "title": TITLE, "summary": "自动化测试用书（跑完自删）", "kind": "novel"})
    assert st == 200, (st, born)
    slug = born.get("projectRoot") or born.get("slug")
    print("测试书：%s → %s" % (TITLE, slug))
    # 两章正文：写手要有个"上一章"可接
    for i, body in ((1, "雪停的时候，林诺把最后一块木牌按进雪里。他数了数，一百零八块。\n\n"
                        "\"够了吗？\"沈岩搓着手问。\n\n林诺没答。他盯着最上面那块，"
                        "木纹里嵌着半截发黑的线。\n"),
                    (2, "第二天早上，木牌少了一块。\n\n林诺蹲下去看那个坑，雪是新的。\n\n"
                        "\"谁来过？\"沈岩的声音在背后。\n")):
        api("POST", "/api/import/text", json={
            "slug": slug, "name": f"第{i:03d}章-测试", "text": body, "prefix": "manuscript"})

    # ── 目录：模式与角色（前端要显示的东西，后端先得对） ──
    st, cat = api("GET", "/api/agent/orchestra")
    modes = {m["key"]: m for m in (cat.get("modes") or [])}
    roles = {r["key"]: r for r in (cat.get("roles") or [])}
    check("目录里有三种模式（讨论/计划/执行）",
          set(modes) == {"discuss", "plan", "execute"}, str(list(modes)))
    check("目录里有五个角色（主创/取上下文/查证/写手/挑刺）",
          set(roles) == {"leader", "retriever", "researcher", "writer", "critic"},
          str(list(roles)))
    check("五个角色的可见范围与工具集各不相同",
          len({tuple(r["tools"]) for r in roles.values()}) == 5
          and len({tuple(r["sees"]) for r in roles.values()}) == 5,
          json.dumps({k: v["tools"] for k, v in roles.items()}, ensure_ascii=False))
    check("写权限的差别写在目录里（只有写手能写正文、只有主创能改设定）",
          roles["writer"]["scope"] == "prose" and roles["critic"]["scope"] == "read"
          and roles["leader"]["scope"] == "all",
          json.dumps({k: v["scope"] for k, v in roles.items()}, ensure_ascii=False))

    goal = "接着第002章往下写第003章，接上木牌被动的线，大概 800 字。"

    # ── 讨论模式 ──
    sid = new_session(slug)
    invoke(sid, "discuss", goal)
    run = last_run(sid)
    seq = [s["role"] for s in run["steps"]]
    check("讨论：走完四棒，主创与挑刺来回（role 序列正确）",
          seq == ["leader", "critic", "leader", "critic"], str(seq))
    real_writes = [c for s in run["steps"] for c in s["calls"]
                   if c["tool"] == "write_file" and not c.get("blocked")]
    check("讨论：没人动文件（wrote 为空；模型想写也被挡下并留了记录）",
          run["wrote"] == [] and not real_writes,
          json.dumps({"wrote": run["wrote"],
                      "blockedTries": [c.get("why") for s in run["steps"] for c in s["rejected"]]},
                     ensure_ascii=False))
    check("讨论：主创真的读到挑刺的批注（第二棒 handoff 里有挑刺的文字）",
          len(run["steps"][2]["handoff"]) > 50, str(len(run["steps"][2]["handoff"])))
    check("讨论：最后的方案非空（不是空转）",
          len(run["steps"][-1]["output"]) > 80, str(len(run["steps"][-1]["output"])))
    discuss = run

    # ── 计划模式 ──
    sid = new_session(slug)
    invoke(sid, "plan", goal)
    run = last_run(sid)
    seq = [s["role"] for s in run["steps"]]
    check("计划：角色序列 = 主创排 → 取上下文 → 查证 → 主创定稿",
          seq == ["leader", "retriever", "researcher", "leader"], str(seq))
    check("计划：没人写正文（不落盘）",
          run["wrote"] == [], json.dumps(run["wrote"], ensure_ascii=False))
    check("计划：取上下文真的给主创交了料（交接非空）",
          len(run["steps"][3]["handoff"]) > 50, str(len(run["steps"][3]["handoff"])))
    check("计划：定稿计划里写了要动哪个文件",
          "manuscript/" in run["steps"][-1]["output"], run["steps"][-1]["output"][:120])
    check("计划：取上下文这一步的可见范围与写手不同（列表不同）",
          run["steps"][1]["sees"] != roles["writer"]["sees"], "")
    plan = run

    # ── 执行模式 ──
    sid = new_session(slug)
    invoke(sid, "execute", goal)
    run = last_run(sid)
    seq = [s["role"] for s in run["steps"]]
    check("执行：七个角色步骤全跑（计划→取料→查证→初稿→挑刺→改稿→汇总）",
          seq == ["leader", "retriever", "researcher", "writer", "critic", "writer", "leader"],
          str(seq))
    wr = run["steps"][3]
    check("执行：写手真的落盘了，而且只往 manuscript/ 写",
          bool(run["wrote"]) and all(p.startswith("manuscript/") for p in run["wrote"]),
          json.dumps(run["wrote"], ensure_ascii=False))
    check("执行：挑刺拿到的是写手的初稿（handoff 里有正文片段）",
          len(run["steps"][4]["handoff"]) > 100, str(len(run["steps"][4]["handoff"])))
    check("执行：挑刺的批注又交回给写手（改稿这一棒读到批注）",
          len(run["steps"][5]["handoff"]) > 60, str(len(run["steps"][5]["handoff"])))
    check("执行：主创收尾，说明改了什么",
          len(run["steps"][6]["output"]) > 20, run["steps"][6]["output"][:120])
    check("执行：写手这一棒能用的工具与挑刺不同（可见范围不同）",
          wr["tools"] != run["steps"][4]["tools"], "")
    bad_rej = [c for s in run["steps"] for c in s["rejected"] if not c.get("why")]
    check("执行：被挡下来的调用都写清了理由（可见范围不是嘴上说说）",
          not bad_rej, json.dumps(bad_rej, ensure_ascii=False)[:200])
    check("执行：写出来的文件带扩展名（.md）",
          all(p.endswith(".md") for p in run["wrote"]),
          json.dumps(run["wrote"], ensure_ascii=False))
    # 正文真的落进书里了吗（写手的 write_file 会进"改动"收件箱，文件本身应已写入）
    st, tree = api("GET", f"/api/workspace-files/tree?projectRoot={slug}")
    paths = json.dumps(tree, ensure_ascii=False)
    check("执行：写出来的新章节确实出现在工作区里",
          "003" in paths, paths[:160])
    execute = run

    # ── 三个模式确实不同 ──
    check("三种模式的角色序列互不相同（模式在编排层真的生效）",
          len({tuple(x["steps"][i]["role"] for i in range(len(x["steps"])))
               for x in (discuss, plan, execute)}) == 3, "")
    check("讨论与计划都不落盘、执行才落盘",
          discuss["wrote"] == [] and plan["wrote"] == [] and bool(execute["wrote"]), "")

    # ── 收尾：测试书进回收站（不删用户数据；这里删的是本次自建的） ──
    st, trashed = api("DELETE", "/api/projects/item", params={"projectRoot": slug})
    check("测试书跑完进回收站（不留垃圾，也不碰用户的书）",
          st == 200 and trashed.get("ok"), f"{st} {trashed}")
    ok = sum(1 for r in results if r["ok"])
    OUT.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE, "model": MODEL,
        "scratchBook": {"title": TITLE, "slug": slug, "deleted": "已进回收站"},
        "total": len(results), "passed": ok, "failed": len(results) - ok,
        "runs": {"discuss": discuss, "plan": plan, "execute": execute},
        "items": results}, ensure_ascii=False, indent=1), "utf-8")
    print(f"\n=== 多 Agent 编排实测：{ok}/{len(results)} ===")
    print("报告：docs/多Agent编排实测.json")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
