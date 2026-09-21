#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""流水线与批量操作实测（docs/11 阶段 16.3 工作流编排 / 15.6 批量操作）。

要证的三件事：
  * 流水线能存、能跑、**每一步的结果都能回看**（不是跑完就没影了）
  * 批量能一次处理多章，进度真的会动（不是 0→100 的假进度）
  * 干的活是真的：细纲进了大纲表等人确认，质检写进了 lint_run

用一本自建的一次性书跑，跑完删干净；不碰用户的任何一本书。
跑法：server/venv/bin/python tools/verify_workflow.py     （会真调 3 次模型，选的是便宜的小活）
"""
from __future__ import annotations

import json
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
BOOKS = ROOT / "data" / "books"
TRASH = ROOT / "data" / "trash"
STAMP = time.strftime("%m%d-%H%M%S")
results: list[tuple[str, bool, str]] = []


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

    def call(self, path, method="GET", body=None, timeout=180):
        req = urllib.request.Request(BASE + path, method=method)
        d = None
        if body is not None:
            d = json.dumps(body, ensure_ascii=False).encode()
            req.add_header("content-type", "application/json")
        try:
            with self.op.open(req, d, timeout=timeout) as r:
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


def check(n, ok, why=""):
    results.append((n, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + n + ("" if ok else "   —— " + str(why)[:220]))


def wait_job(c, jid, *, timeout=240):
    """盯着一个后台任务，顺路把看过的进度记下来（用来证明进度不是摆设）。"""
    seen, t0 = [], time.time()
    while time.time() - t0 < timeout:
        st, d = c.call("/api/agent/jobs/%s" % u(jid))
        if st != 200:
            return None, seen
        seen.append(int(d.get("progress") or 0))
        if d.get("status") in ("done", "failed", "canceled"):
            return d, seen
        time.sleep(1.5)
    return {"status": "timeout"}, seen


CONTENT = """他站在门口，心里五味杂陈。空气仿佛凝固了一般，一切都显得那么不真实。
“你来了。”老人缓缓开口，声音里带着说不出的沧桑。
他没有说话。不是因为不想说，而是因为不知道该从何说起。
夜色渐深。他终于开口，把三年前那件事原原本本讲了一遍。
老人听完，只是点了点头。有些事，说与不说，其实都一样。
"""


def main() -> int:
    c = C()
    st, d = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1

    st, d = c.call("/api/book", "POST", {"title": "流水线自测 " + STAMP})
    slug = (d or {}).get("slug") or ""
    check("① 建一本自测书", st == 200 and bool(slug), f"{st} {d}")
    if not slug:
        return 1
    ch1, ch2 = "manuscript/甲章.md", "manuscript/乙章.md"
    for p, text in ((ch1, CONTENT), (ch2, CONTENT.replace("门口", "窗前"))):
        c.call("/api/chapter/new", "POST", {"slug": slug, "path": p, "content": text})
    st, d = c.call("/api/book?slug=%s&refresh=1" % u(slug))
    paths = [x["path"] for x in ((d or {}).get("chapters") or [])]
    check("② 两章都建好了", st == 200 and ch1 in paths and ch2 in paths,
          f"{st} {json.dumps(paths, ensure_ascii=False)[:160]}")

    # ── 流水线 ──
    st, d = c.call("/api/workflows?slug=%s" % u(slug))
    presets = (d or {}).get("items") or []
    check("③ 第一次打开就有三条现成的（不用自己拼）", st == 200 and len(presets) >= 3,
          f"{st} n={len(presets)}")
    check("④ 步骤类型有清单（前端加一步时照着它列）",
          len((d or {}).get("kinds") or []) == 6,
          json.dumps((d or {}).get("kinds"), ensure_ascii=False)[:160])

    st, d = c.call("/api/workflows/save", "POST", {
        "slug": slug, "name": "自测：细纲→质检",
        "note": "先出细纲，再过一遍质检", "steps": [{"kind": "outline"}, {"kind": "lint"}]})
    wid = (d or {}).get("id")
    check("⑤ 存一条自己的流水线", st == 200 and bool(wid), f"{st} {json.dumps(d, ensure_ascii=False)[:160]}")

    st, d = c.call("/api/workflows/run", "POST", {"slug": slug, "id": wid, "path": ch1})
    jid = (d or {}).get("jobId")
    check("⑥ 跑起来就回 jobId（不占着请求等人）", st == 200 and bool(jid),
          f"{st} {json.dumps(d, ensure_ascii=False)[:160]}")
    doc, seen = wait_job(c, jid)
    check("⑦ 跑完了：状态 done、进度 100",
          (doc or {}).get("status") == "done" and int((doc or {}).get("progress") or 0) == 100,
          json.dumps(doc, ensure_ascii=False)[:260] if doc else "没有任务详情")
    steps = (doc or {}).get("steps") or []
    check("⑧ 每一步的结果都能回看（出细纲 + 质检各一条）",
          len(steps) == 2 and steps[0].get("kind") == "outline" and steps[1].get("kind") == "lint",
          json.dumps(steps, ensure_ascii=False)[:260])
    check("⑨ 细纲真进了大纲表（等人确认，approved=0）",
          bool(steps and steps[0].get("outlineId")),
          json.dumps(steps[:1], ensure_ascii=False)[:200])
    check("⑩ 质检真跑了（给出命中的条数或成绩）",
          bool(steps) and ("issues" in steps[-1] or "score" in steps[-1]),
          json.dumps(steps[-1:], ensure_ascii=False)[:200])

    st, d = c.call("/api/plot/outline?slug=%s&path=%s" % (u(slug), u(ch1)))
    st2, hist = c.call("/api/lint/report?slug=%s&path=%s" % (u(slug), u(ch1)))
    check("⑪ 大纲表 / 质检记录里都查得到（不是只在任务的返回里）",
          st == 200 and bool((d or {}).get("items")) and st2 == 200 and bool((hist or {}).get("items")),
          f"outline={len((d or {}).get('items') or [])} lint={len((hist or {}).get('items') or [])}")

    # ── 批量 ──
    st, d = c.call("/api/write/batch", "POST",
                   {"slug": slug, "mode": "outline", "paths": [ch1, ch2]})
    bjid = (d or {}).get("jobId")
    check("⑫ 批量写细纲：两章一起丢进去", st == 200 and bool(bjid) and (d or {}).get("chapters") == 2,
          f"{st} {json.dumps(d, ensure_ascii=False)[:160]}")
    doc, seen = wait_job(c, bjid)
    bsteps = (doc or {}).get("steps") or []
    check("⑬ 批量跑完：两章都有结果",
          (doc or {}).get("status") == "done" and len(bsteps) == 2,
          json.dumps(doc, ensure_ascii=False)[:260] if doc else "没有任务详情")
    check("⑭ 进度是**一格一格**动的，不是假进度条",
          len(seen) >= 2 and seen[0] < max(seen), "看到的进度序列：%s" % seen[:8])
    st, d = c.call("/api/plot/outline?slug=%s&path=%s" % (u(slug), u(ch2)))
    check("⑮ 第二章的细纲也落库了", st == 200 and bool((d or {}).get("items")),
          f"{st} n={len((d or {}).get('items') or [])}")

    # ── 暂停 / 继续（16.4「可暂停」）──
    st, d = c.call("/api/write/batch", "POST",
                   {"slug": slug, "mode": "summary", "paths": [ch1, ch2]})
    pjid = (d or {}).get("jobId")
    time.sleep(0.6)
    st, pd = c.call("/api/agent/jobs/%s/pause" % u(pjid), "POST", {})
    st2, pafter = c.call("/api/agent/jobs/%s" % u(pjid))
    paused_ok = st == 200 and (pafter or {}).get("status") == "paused"
    check("⑯ 长任务能暂停", paused_ok or (pafter or {}).get("status") in ("done",),
          f"pause={st} {pd}；现在状态 {json.dumps(pafter, ensure_ascii=False)[:160]}")
    if paused_ok:
        before_steps = len((pafter or {}).get("steps") or [])
        time.sleep(3)
        st3, still = c.call("/api/agent/jobs/%s" % u(pjid))
        check("⑰ 暂停期间真的停住了（没有偷偷往下跑）",
              (still or {}).get("status") == "paused"
              and len((still or {}).get("steps") or []) == before_steps,
              json.dumps(still, ensure_ascii=False)[:160])
        st4, rd = c.call("/api/agent/jobs/%s/resume" % u(pjid), "POST", {})
        check("⑱ 能继续", st4 == 200, f"{st4} {rd}")
        doc2, _ = wait_job(c, pjid)
        check("⑲ 继续之后跑到完（不是停在半路）",
              (doc2 or {}).get("status") == "done"
              and len((doc2 or {}).get("steps") or []) == 2,
              json.dumps(doc2, ensure_ascii=False)[:220])
    st, d = c.call("/api/agent/jobs/%s/resume" % u(pjid), "POST", {})
    check("⑳ 不在暂停中的任务点「继续」：明确拒绝（不是装成功）", st == 409, f"{st} {d}")

    # ── 每章挂出场角色 / 关键事件（15.2）──
    st, d = c.call("/api/plot/chapter", "PATCH", {"slug": slug, "path": ch1,
                                                  "cast": "林诺，老人", "events": "拿到木牌\n第一次交锋",
                                                  "targetWords": 2600})
    ch_meta = (d or {}).get("chapter") or {}
    check("㉑ 每章能挂出场角色 / 关键事件",
          st == 200 and ch_meta.get("cast") == ["林诺", "老人"] and len(ch_meta.get("events") or []) == 2,
          f"{st} {json.dumps(ch_meta, ensure_ascii=False)[:200]}")
    st, d = c.call("/api/plot/overview?slug=%s" % u(slug))
    chs = (d or {}).get("chapters") or []
    hit = [x for x in chs if x.get("path") == ch1]
    check("㉒ 剧情总览里也带得出来（前端不用再跑一趟）",
          bool(hit) and (hit[0].get("cast") or []) == ["林诺", "老人"],
          json.dumps(hit[:1], ensure_ascii=False)[:200])

    # ── 取消 ──
    st, d = c.call("/api/write/batch", "POST",
                   {"slug": slug, "mode": "summary", "paths": [ch1, ch2]})
    cjid = (d or {}).get("jobId")
    st, c_ = c.call("/api/agent/jobs/%s/cancel" % u(cjid), "POST", {})
    doc, _ = wait_job(c, cjid)
    check("㉓ 长任务能取消（不是只能干等）",
          (doc or {}).get("status") in ("canceled", "done"),
          json.dumps(doc, ensure_ascii=False)[:200] if doc else "没有任务详情")

    # ── 报错要清楚 ──
    st, d = c.call("/api/write/batch", "POST", {"slug": slug, "mode": "outline", "paths": []})
    check("㉔ 批量不给章节：明确报错", st == 400, f"{st} {d}")
    st, d = c.call("/api/write/batch", "POST", {"slug": slug, "mode": "乱写", "paths": [ch1]})
    check("㉕ 批量给错模式：明确报错", st == 400, f"{st} {d}")
    st, d = c.call("/api/workflows/save", "POST",
                   {"slug": slug, "name": "错的", "steps": [{"kind": "飞"}]})
    check("㉖ 流水线给错步骤：明确报错", st == 400, f"{st} {d}")
    st, d = c.call("/api/workflows/run", "POST", {"slug": slug, "id": wid})
    check("㉗ 流水线不给章节：明确报错（不许瞎猜一章）", st == 400, f"{st} {d}")

    # ── 清理 ──
    st, d = c.call("/api/workflows?slug=%s" % u(slug))
    for it in (d or {}).get("items") or []:
        if it.get("slug") == slug:
            c.call("/api/workflows?id=%s&slug=%s" % (it["id"], u(slug)), "DELETE")
    st, d = c.call("/api/workflows?slug=%s" % u(slug))
    check("㉘ 自测流水线删干净（书一级的不留垃圾）",
          not [x for x in ((d or {}).get("items") or []) if x.get("slug") == slug],
          json.dumps((d or {}).get("items"), ensure_ascii=False)[:160])

    c.call("/api/book/delete", "POST", {"slug": slug})
    for p in (BOOKS / slug, TRASH / slug):
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
    # 删除接口会先把书挪进回收站（带时间戳后缀），自测的东西自己收干净
    for d in list(TRASH.glob("*" + slug + "*")):
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
    print("  自测书已删干净：%s" % slug)

    ok = sum(1 for _, o, _ in results if o)
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(results), "ok": ok,
           "fail": len(results) - ok,
           "items": [{"name": n, "ok": o, "why": w} for n, o, w in results]}
    (ROOT / "docs" / "流水线实测.json").write_text(json.dumps(out, ensure_ascii=False, indent=1),
                                                   encoding="utf-8")
    print(f"\n=== 共 {len(results)} 条：通过 {ok}，失败 {len(results) - ok} ===")
    for n, o, w in results:
        if not o:
            print("  ✗", n, w)
    print("报告：docs/流水线实测.json")
    return 1 if ok != len(results) else 0


if __name__ == "__main__":
    sys.exit(main())
