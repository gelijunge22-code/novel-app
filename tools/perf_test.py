#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""性能实测（阶段 22.6「百万字级别不卡；大章节秒开」）。

做法：临时建一本名字唯一的大书（200 章 × 5000 字 ≈ 100 万字），
把每个常用接口真打一遍并计时，跑完**把这本临时书删掉**（走 /api/book/delete 进 trash，
再把属于自测的那份回收站目录清掉 —— 绝不碰用户的书）。

跑法：server/venv/bin/python tools/perf_test.py
"""
from __future__ import annotations

import json
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8899"
SLUG = "zz-perf-"
PFX = "ZZPERF"          # 自测书的标题前缀：只认这个名字的才敢删（绝不碰用户的书）
CHAPTERS = 200
CHARS_PER = 5800          # 每章约 5800 字 → 全书 201 章 ≈ 116 万字（字数按纯汉字算，约 100 万+）
results: list[dict] = []


def pw() -> str:
    f = Path("/home/ubuntu/nbapp/config.json")
    try:
        return str(json.loads(f.read_text("utf-8")).get("app_password") or "")
    except Exception:
        return ""


class C:
    def __init__(self):
        self.cookie = ""
        self.op = urllib.request.build_opener()

    def call(self, path, method="GET", body=None):
        req = urllib.request.Request(BASE + path, method=method)
        if self.cookie:
            req.add_header("cookie", self.cookie)
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode()
            req.add_header("content-type", "application/json")
        t0 = time.perf_counter()
        try:
            with self.op.open(req, data, timeout=180) as r:
                sc = r.headers.get("set-cookie")
                if sc:
                    self.cookie = sc.split(";")[0]
                txt = r.read().decode("utf-8", "replace")
                ms = (time.perf_counter() - t0) * 1000
                try:
                    return r.status, json.loads(txt), ms, len(txt.encode())
                except Exception:
                    return r.status, txt, ms, len(txt.encode())
        except urllib.error.HTTPError as e:
            ms = (time.perf_counter() - t0) * 1000
            txt = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(txt), ms, len(txt.encode())
            except Exception:
                return e.code, txt, ms, len(txt.encode())


def measure(c: C, name: str, path: str, method="GET", body=None, budget_ms: float = 1500) -> dict:
    st, d, ms, size = c.call(path, method, body)
    ok = st == 200 and ms <= budget_ms
    row = {"name": name, "path": path, "method": method, "status": st, "ms": round(ms),
           "kb": round(size / 1024, 1), "budgetMs": budget_ms, "ok": ok}
    results.append(row)
    print("  %s %-28s %6.0f ms  %7.1f KB  预算<%.0fms" %
          ("✓" if ok else "✗", name, ms, size / 1024, budget_ms))
    if st != 200:
        print("      —— 出错了：", str(d)[:200])
    return row


def main() -> int:
    c = C()
    st, d, _, _ = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1
    Q = urllib.parse.quote
    slug = SLUG + time.strftime("%m%d-%H%M%S")
    print("登录 ok；临时大书 =", slug)

    # 先清掉上一次跑挂在书架上的自测书（名字带 ZZPERF 的才是我们的）
    st0, d0, _, _ = c.call("/api/shelf")
    for b in ((d0 or {}).get("projects") or []):
        t, sl = str(b.get("title") or ""), str(b.get("slug") or "")
        if PFX in t.upper() or "zz-perf" in sl:
            print("  清掉上次残留的自测书：", sl)
            c.call("/api/book/delete", "POST", {"slug": sl})

    st, d, _, _ = c.call("/api/book", "POST", {"title": PFX + " 性能自测 " + slug})
    if st != 200:
        print("建不了书：", st, d)
        return 1
    real = (d or {}).get("slug") or ""
    if not real:
        print("建书返回里没给 slug：", d)
        return 1
    print("建好了：", real)

    # 造 200 章 × 5000 字
    para = ("他抬起手，雪落在刀鞘上，很快化成一层薄薄的水。远处的山脊被风刮得发白，"
            "营火噼啪响了一声，没人说话。")
    body = (para * (CHARS_PER // len(para) + 1))[:CHARS_PER]
    t0 = time.perf_counter()
    for i in range(1, CHAPTERS + 1):
        p = "manuscript/第%03d章-自测.md" % i
        st, d, _, _ = c.call("/api/chapter/new", "POST",
                             {"slug": real, "path": p, "content": "# 第%03d章\n\n" % i + body})
        if st != 200:
            print("第 %d 章建失败了：%s %s" % (i, st, str(d)[:160]))
            break
    build_s = time.perf_counter() - t0
    print("造完 %d 章，用时 %.1f 秒" % (CHAPTERS, build_s))

    # ① 书架（多本书时的列表）
    measure(c, "书架列表", "/api/shelf", budget_ms=1500)
    # ② 打开书：目录（200 章）+ 全书字数
    st, d, ms, _ = c.call("/api/book?slug=" + Q(real))
    chapters = len((d or {}).get("chapters") or []) if st == 200 else 0
    words = (d or {}).get("totalWords") if st == 200 else 0
    ok = st == 200 and ms <= 2000 and chapters >= CHAPTERS
    results.append({"name": "打开书（目录）", "path": "/api/book", "status": st, "ms": round(ms),
                    "chapters": chapters, "totalWords": words, "budgetMs": 2000, "ok": ok})
    print("  %s %-28s %6.0f ms  %d 章 / %s 字" % ("✓" if ok else "✗", "打开书（目录）", ms, chapters, words))
    # ③ 读一章正文（大章节秒开）
    measure(c, "读一章正文", "/api/chapter?slug=%s&path=%s" % (Q(real),
          urllib.parse.quote("manuscript/第100章-自测.md")), budget_ms=600)
    # ④ 全书搜索
    measure(c, "全书搜索", "/api/search?slug=%s&q=%s" % (Q(real), urllib.parse.quote("雪落在刀鞘上")),
            budget_ms=3000)
    # ⑤ 统计
    measure(c, "全书统计", "/api/stats/book?slug=" + Q(real), budget_ms=3000)
    # ⑥ 质检扫全书（真扫 100 万字，最重的一个）
    measure(c, "全书质检扫描", "/api/lint/scan-book?slug=" + Q(real),
            method="POST", body={"slug": real}, budget_ms=15000)
    # ⑦ 写作上下文（每次生成都要拼，必须快）
    measure(c, "写作上下文拼装", "/api/write/context?slug=" + Q(real), budget_ms=1500)
    # ⑧ 导出 TXT 整本
    measure(c, "导出整本 TXT", "/api/export/text?slug=" + Q(real), budget_ms=5000)
    # ⑨ 数据体检
    measure(c, "数据体检", "/api/backup/doctor", budget_ms=5000)
    # ⑩–⑱ 写作辅助面板那一排（第 8 遍打磨补的：这些是用户点得最多的按钮，
    #      以前只量了"读一章/搜索/统计"，这几个重接口压根没人量过）
    measure(c, "角色出场统计", "/api/plot/cast?slug=" + Q(real), budget_ms=8000)
    measure(c, "节奏曲线", "/api/pacing/curve?slug=" + Q(real), budget_ms=8000)
    measure(c, "世界总览", "/api/world/overview?slug=" + Q(real), budget_ms=5000)
    measure(c, "剧情总览", "/api/plot/overview?slug=" + Q(real), budget_ms=5000)
    measure(c, "伏笔到期", "/api/plot/promises/due?slug=" + Q(real), budget_ms=3000)
    measure(c, "统计周报", "/api/stats/report?slug=" + Q(real), budget_ms=8000)
    measure(c, "记忆体检", "/api/projects/rag/inspector?projectRoot=" + Q(real), budget_ms=5000)
    measure(c, "质检报告（第一次·冷）", "/api/lint/report?slug=" + Q(real), budget_ms=20000)
    # 第 8 遍打磨加的：面板开屏读的就是这个接口，以前**每次都把全书重扫**（100 万字 6.5 秒）。
    # 现在按章缓存 —— 第一次慢是应该的，第二次必须快，而且要能从返回里看到"复用了多少章"。
    st, d, ms, _ = c.call("/api/lint/report?slug=" + Q(real))
    reused = ((d or {}).get("book") or {}).get("reused")
    ok = st == 200 and ms <= 800 and (reused or 0) >= CHAPTERS
    results.append({"name": "质检报告（第二次·热缓存）", "path": "/api/lint/report", "method": "GET",
                    "status": st, "ms": round(ms), "budgetMs": 800, "reused": reused, "ok": ok})
    print("  %s %-28s %6.0f ms  复用 %s 章  预算<800ms" %
          ("✓" if ok else "✗", "质检报告（第二次·热缓存）", ms, reused))
    measure(c, "导出整本 Markdown", "/api/export/markdown?slug=" + Q(real), budget_ms=5000)

    # 收尾：删掉这本临时书（进 trash），再把这份自测的回收站目录清掉
    st, d, _, _ = c.call("/api/book/delete", "POST", {"slug": real})
    gone = st == 200
    trashed = None
    if isinstance(d, dict):
        for k in ("trashedTo", "trash", "path", "moved"):
            if isinstance(d.get(k), str) and d[k]:
                trashed = d[k]
    print("删除临时书：", st, str(d)[:160])
    if trashed:
        p = Path(trashed) if trashed.startswith("/") else Path("data/trash") / Path(trashed).name
        if p.exists() and "zz-perf" in str(p):
            shutil.rmtree(p, ignore_errors=True)
            print("清掉自测的回收站目录：", p)
    st, d, _, _ = c.call("/api/shelf")
    still = [b.get("slug") for b in ((d or {}).get("projects") or [])
             if PFX in str(b.get("title") or "").upper() or "zz-perf" in str(b.get("slug") or "")]
    print("书架上还有没有自测书：", still)

    bad = [r for r in results if not r["ok"]]
    print("\n=== 大书（%d 章 / 约 %s 字）：共 %d 项，达标 %d，超标/失败 %d ===" %
          (chapters, words, len(results), len(results) - len(bad), len(bad)))
    out = Path("docs/性能实测.json")
    out.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "book": {"slug": real, "chapters": chapters, "totalWords": words,
                 "builtInSec": round(build_s, 1)},
        "deleted": gone, "leftOnShelf": still,
        "total": len(results), "ok": len(results) - len(bad), "fail": len(bad),
        "results": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("报告：", out)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
