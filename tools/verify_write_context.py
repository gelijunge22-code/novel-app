#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""写作链路注料实测：写正文时，**用户填过的东西有没有真喂进提示词**。

盯的是三样以前"填了等于白填"的东西：
  ① 章节挂的角色与事件（chapter_meta）
  ② 出场角色在世界引擎里的事实（性格/称呼/武魂…）
  ③ 记忆（memory —— 以前只有对话页吃，写正文时等于不存在）

怎么验：造一本测试书 → 填上这三样 → 调 `/api/write/context`（前端「看看到底喂了什么」用的同一个接口）
→ 断言这段提示词里**真的**出现了它们；再验空数据时不会留下空标题。

跑法：server/venv/bin/python tools/verify_write_context.py
产出：docs/写作链路注入实测.json
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "写作链路注入实测.json"
STAMP = time.strftime("%m%d-%H%M%S")
results: list[dict] = []
cli = httpx.Client(base_url=BASE, timeout=120.0)


def password() -> str:
    return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))["app_password"])


def check(name, ok, why="", data=None):
    results.append({"name": name, "ok": bool(ok), "why": str(why)[:400],
                    "data": data if data is not None else None})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:300]))


def api(method, path, **kw):
    r = cli.request(method, path, **kw)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


def main() -> int:
    if api("POST", "/api/app/login", json={"password": password()})[0] != 200:
        print("登录失败"); return 1
    title = f"注料测试-{STAMP}"
    src = api("POST", "/api/projects", json={"title": title, "kind": "novel"})[1]["projectRoot"]
    print("测试书：", src)
    # 第 0 章（上一章）与第 1 章（要写的那章）
    api("POST", "/api/import/text", json={"slug": src, "name": "第001章-雪夜",
                                          "text": "雪落了一夜。林诺把木牌一块块按进雪里。\n"})
    api("POST", "/api/import/text", json={"slug": src, "name": "第002章-脚印",
                                          "text": "第二天，木牌少了一块。\n"})
    p1, p2 = "manuscript/第001章-雪夜.md", "manuscript/第002章-脚印.md"
    # ① 挂角色与事件
    st, _ = api("PATCH", "/api/plot/chapter", json={"slug": src, "path": p2,
                                                    "cast": ["林诺", "沈岩"],
                                                    "events": ["发现木牌少了一块", "雪地上有别人的脚印"]})
    # ② 世界引擎里给角色记事实
    eid = api("POST", "/api/world/entity", json={"slug": src, "kind": "character",
                                                 "name": "林诺"})[1]["id"]
    api("POST", "/api/world/fact", json={"slug": src, "entityId": eid, "key": "性格",
                                         "value": "沉默，遇事先动手", "sourcePath": p1})
    api("POST", "/api/world/fact", json={"slug": src, "entityId": eid, "key": "随身物",
                                         "value": "一百零八块木牌", "sourcePath": p1})
    # ③ 建记忆（真实路径：从世界引擎重建索引）
    st_rb, rb = api("POST", "/api/projects/rag/rebuild", params={"projectRoot": src}, json={})
    n_mem = (rb.get("memories") or rb.get("memory") or rb.get("items") or 0) if isinstance(rb, dict) else 0
    check("记忆索引能从世界引擎重建出来（不是空壳）",
          st_rb == 200 and (n_mem or 0) >= 2, f"{st_rb} {str(rb)[:200]}")

    ctx = api("GET", "/api/write/context", params={"slug": src, "path": p2, "mode": "continue"})[1]
    prompt = (ctx.get("system") or "") + "\n" + "\n".join(m.get("content", "")
                                                          for m in (ctx.get("messages") or []))
    for tag, must in (("这一章挂的角色与事件", ["林诺", "沈岩", "木牌少了一块"]),
                      ("出场角色的既有设定", ["性格", "沉默"]),
                      ("相关记忆", ["性格"])):
        i = prompt.find(tag)
        check(f"提示词里出现了「{tag}」", i >= 0, prompt[:200] if i < 0 else "")
        if i >= 0:
            seg = prompt[i:i + 800]
            miss = [m for m in must if m not in seg]
            check(f"「{tag}」里带上了具体内容（{'、'.join(must)}）", not miss, "缺：" + str(miss))
    check("喂进去的字数被如实报出来（前端「看看到底喂了什么」要用）",
          (ctx.get("chars") or 0) > 500, str(ctx.get("chars")))

    # 空数据：不挂角色、没有事实的那一章，不该出现空标题
    api("POST", "/api/import/text", json={"slug": src, "name": "第003章-空", "text": "空章。\n"})
    p3 = "manuscript/第003章-空.md"
    ctx2 = api("GET", "/api/write/context", params={"slug": src, "path": p3, "mode": "chapter"})[1]
    p2s = (ctx2.get("system") or "") + "\n" + "\n".join(m.get("content", "")
                                                        for m in (ctx2.get("messages") or []))
    check("没挂角色的章不会有空的「这一章挂的角色与事件」标题（不留空壳）",
          "这一章挂的角色与事件" not in p2s, "")
    check("没事实的角色不会被硬塞一段空设定", "出场角色的既有设定" not in p2s or "：" in p2s, "")

    api("DELETE", "/api/projects/item", params={"projectRoot": src})
    ok = sum(1 for r in results if r["ok"])
    OUT.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE, "scratch": src,
        "total": len(results), "passed": ok, "failed": len(results) - ok,
        "items": results}, ensure_ascii=False, indent=1), "utf-8")
    print(f"\n=== 写作链路注料实测：{ok}/{len(results)} ===")
    print("报告：docs/写作链路注入实测.json")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
