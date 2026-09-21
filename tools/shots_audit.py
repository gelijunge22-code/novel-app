#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""截图目录审计 / 清理（治"攒垃圾截图"）。

规矩（都是巡检时被抓到之后定的）：
  1. 同一 md5 的图**只留一份**。留谁：优先留"名字最像正主"的那份（`r9-` 轮次前缀 > 老名），
     其余列进作废清单再删。
  2. 明确标注「返回键回到同一屏」的图（名字里带 `-back` / `back-` / `-same`）
     允许与上一屏相同，但**同样只留一份**——它证明的事只有一件。
  3. 作废目录（`作废-*`）整体清掉，内容记进清单，别混在有效证据里。
  4. 目录里只允许 `.png` / `.md` / `.json`，别的（日志、临时文件）一律清。
  5. **判"重复"要分轮次**（第 11 轮补）："同一屏在不同轮拍的一样"是正常的
     （设定页这种东西本来就不会变），真正该报的是**同一轮里**两张图一样
     —— 那说明某一步根本没生效（脚本点了、界面没动）。所以按文件名前缀的轮次分组判。
  6. **轮次要认到"批次"**（第 30 轮补）：`r19` / `r19ui` / `r19sa` / `r19st` / `r19old` 是**同一轮的
     不同批次**（不同脚本、不同阶段），`-反证` / `-改前` / `-改后` / `-old` 也是不同批次 ——
     旧写法把 `r19ui-…` 一律归成 `old`，于是"`j1-①-故事线.png` 与它的反证图一样"这种
     **跨批次**的正常情况被误报成"同一轮重复"（实测 19 组里有 13 组是这么误报的）。
  7. **误报要能被逐个核销，但核销要留痕**（第 30 轮补）：真"同一批次里两张一样"的组，
     允许写进 `docs/截图重复核销.json`（`{md5前8位: 理由}`）逐组核销；
     **没核销的一律算问题、退出码 1**（判据能报红）。核销内容要写清"为什么它一样是正常的"，
     写"历史遗留"这种不算。反证：`SHOTS_AUDIT_FORCE=1` 会假装核销清单不存在 → 必须报红。

用法：
    server/venv/bin/python tools/shots_audit.py            # 只审计，不改
    server/venv/bin/python tools/shots_audit.py --clean    # 清理并写作废清单
产出：docs/截图审计.json（+ 清理时写 docs/前端截图/作废清单.md）
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOT = ROOT / "docs" / "前端截图"
OUT = Path(os.environ.get("SHOTS_AUDIT_OUT") or (ROOT / "docs" / "截图审计.json"))
# ↑ 反证要留证据、又不能盖掉正跑的报告（第 30 轮补）
WAIVER = ROOT / "docs" / "截图重复核销.json"
CLEAN = "--clean" in sys.argv

# 允许"与上一屏相同"的命名（返回键回到原处、同一状态的复拍）
SAME_OK = ("-back", "back-", "-same", "回到宫格")


def round_of(name: str) -> str:
    """从文件名里认轮次：`r11-fm-05-设定.png` → `r11`；认不出就归 `old`。

    第 30 轮修：`r19ui` / `r19sa` / `r19st` / `r19old` 这种**同轮不同批次**的前缀，
    以前因为 `'19ui'.isdigit()` 是假 → 全都归成 `old`，把跨批次当成同一轮。"""
    head = name.split("-")[0]
    if head.startswith("probe"):
        return "probe"                     # 探针脚本自己的一批（跟正式那轮不是同一批）
    m = re.fullmatch(r"r(\d+)([a-z]*)", head) or re.fullmatch(r"r([a-z]+)(\d+)", head)
    return head if m else "old"


# 同一轮里不同**阶段**拍出来的图（改前/改后/反证/同轮旧版）本来就该不一样，
# 它们属于不同批次；只有"同一批次里的两张一样"才说明那一步没生效。
def batch_of(name: str) -> str:
    role = ""
    for kw, tag in (("反证", "反证"), ("改前", "改前"), ("改后", "改后"),
                    ("-old", "old"), ("old-", "old")):
        if kw in name:
            role = tag
            break
    return round_of(name) + "|" + role
KEEP_EXT = {".png", ".md", ".json"}


def md5_of(p: Path) -> str:
    h = hashlib.md5()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def selftest() -> int:
    """判据自己的单测（第 30 轮补）：`名字 → 批次` 这张映射表**要能报红**。

    以前 `'19ui'.isdigit()` 是假 → r19ui/r19sa/probe 全归成 `old`，于是
    「某张图与它自己的反证图一样」被误报成"同一轮重复"（19 组误报 13 组）。
    这里把当时误报的名字逐对钉住：改回去就得红。"""
    cases = [
        # ① 阶段不同（改前/改后/反证/探针）→ 不算同一批，不该报"那一步没生效"
        (("j1-①-故事线.png", "j1-①-故事线-反证.png"), False),
        (("r28-空间-改前-preset.png", "r28-空间-改后-preset.png"), False),
        # ② 同轮不同批次的前缀（r19ui / r19sa / r19st / rd1 / probe）→ 认到子批次，别全归 old
        (("r19-preset-预设-日间.png", "r19ui-preset-预设.png"), False),
        (("r19-工具-history.png", "r19ui-tool-工具-history.png"), False),
        (("probe-rdshell-chromeON.png", "rd1-reader-阅读.png"), False),
        (("r29old-a.png", "r29st-a.png"), False),
        # ③ 反过来：**真**同一批次里两张一样，必须仍然判得出来（别越修越松）
        (("r30-书架.png", "r30-大设置.png"), True),
        (("r19-工具-history.png", "r19-工具-notes.png"), True),
        (("r19sa-反证-pad0-shelf.png", "r19sa-反证-trap-shelf.png"), True),
        (("r29old-tool-backup-empty.png", "r29old-tool-backup-error.png"), True),
    ]
    # 旧写法（第 30 轮修之前那版：只认 r<数字> 前缀、没有"阶段"这一维）——
    # 留着当**反证**：同一批案例喂给它，它必须判错，否则说明这些案例根本测不出东西。
    def legacy_batch_of(name: str) -> str:
        head = name.split("-")[0]
        return head if (head.startswith("r") and head[1:].isdigit()) else "old"

    bad = 0
    legacy_bad = 0
    for (a, b), want in cases:
        got = batch_of(a) == batch_of(b)
        ok = got == want
        bad += 0 if ok else 1
        legacy_bad += 0 if (legacy_batch_of(a) == legacy_batch_of(b)) != want else 1
        print(("  ✓ " if ok else "  ✗ ") + f"{a} ↔ {b} → 同批次={got}（期望 {want}）")
    print(f"批次映射自检：{len(cases) - bad}/{len(cases)} 过" + ("" if not bad else "  ← 判据自己坏了"))
    print(f"  反证 · 旧写法在这批案例上判错 {legacy_bad}/{len(cases)} 条"
          + ("（>0 = 案例没有白写）" if legacy_bad else "  ← **一条都没判错，说明案例是空的**"))
    return 0 if (bad == 0 and legacy_bad > 0) else 1


def main() -> int:
    if not SHOT.is_dir():
        print("没有截图目录：", SHOT)
        return 1
    files = sorted(p for p in SHOT.iterdir() if p.is_file())
    dirs = sorted(p for p in SHOT.iterdir() if p.is_dir())
    groups: dict[str, list[Path]] = defaultdict(list)
    for p in files:
        groups[md5_of(p)].append(p)

    dup_groups = {h: ps for h, ps in groups.items() if len(ps) > 1}

    def same_round_dup(ps):
        """同一个**批次**（轮次 + 阶段）里出现两张一样的 = 有问题（那一步没生效）。"""
        seen = {}
        for p in ps:
            b = batch_of(p.name)
            if b in seen:
                return True
            seen[b] = p
        return False

    bad = {h: ps for h, ps in dup_groups.items() if same_round_dup(ps)}
    allowed = {h: ps for h, ps in dup_groups.items()
               if h not in bad and all(any(k in p.name for k in SAME_OK) for p in ps)}
    cross = {h: ps for h, ps in dup_groups.items() if h not in bad and h not in allowed}
    junk_ext = [p for p in files if p.suffix.lower() not in KEEP_EXT]

    # 逐组核销（第 30 轮补）：真"同一批次里两张一样"的组，理由写进 docs/截图重复核销.json 才算过；
    # 没写的 / 写了"待查"的，一律算问题、退出码 1。
    waiver = {}
    if WAIVER.exists() and not os.environ.get("SHOTS_AUDIT_FORCE"):
        try:
            waiver = {k.replace("…", ""): v for k, v in json.loads(
                WAIVER.read_text("utf-8")).get("已核销", {}).items()}
        except Exception as e:            # noqa: BLE001
            print("核销清单读不动：", e)
    waived, unwaived = {}, {}
    for h, ps in bad.items():
        key = h[:8]
        reason = waiver.get(key)
        if reason and len(str(reason)) >= 12:
            waived[h] = ps
        else:
            unwaived[h] = ps

    report = {
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "force": bool(os.environ.get("SHOTS_AUDIT_FORCE")),
        "dir": str(SHOT), "files": len(files), "sizeMB": round(
            sum(p.stat().st_size for p in files) / 1048576, 1),
        "uniqueMd5": len(groups),
        "dupGroupsAllowed（返回键这类，本来就该一样）": {
            h[:8]: [p.name for p in ps] for h, ps in allowed.items()},
        "dupGroupsProblem（**同一批次**里两张一样 = 那一步没生效）": {
            h[:8]: [p.name for p in ps] for h, ps in bad.items()},
        "dupGroupsWaived（逐组核销过，理由见 docs/截图重复核销.json）": {
            h[:8]: [p.name for p in ps] for h, ps in waived.items()},
        "dupGroupsUnwaived（**没核销 = 问题**）": {
            h[:8]: [p.name for p in ps] for h, ps in unwaived.items()},
        "dupGroupsCrossRound（不同轮同一屏，正常）": {
            h[:8]: [p.name for p in ps] for h, ps in cross.items()},
        "wasteDirs": [p.name for p in dirs],
        "badFiles": [p.name for p in junk_ext],
        "cleaned": None,
    }

    print(f"截图 {len(files)} 个文件 / {report['sizeMB']}MB；不同内容 {len(groups)} 种")
    print(f"  可以一样的重复组（返回键）：{len(allowed)}")
    print(f"  **同一批次里重复**：{len(bad)}（其中已逐组核销 {len(waived)}）")
    for h, ps in list(bad.items())[:6]:
        print("    ✗", h[:8], [p.name for p in ps][:4])
    print(f"  **没核销的（= 问题，要红）**：{len(unwaived)}"
          + ("  ← SHOTS_AUDIT_FORCE=1，装作核销清单不存在" if os.environ.get("SHOTS_AUDIT_FORCE") else ""))
    for h, ps in unwaived.items():
        print("    ✗✗", h[:8], [p.name for p in ps][:4], "→ 要么补核销理由，要么 --clean 合并")
    print(f"  跨轮同一屏（正常，不用管）：{len(cross)}")
    for h, ps in list(cross.items())[:6]:
        print("    · ", h[:8], [p.name for p in ps][:4])
    if dirs:
        print("  作废/杂物目录：", [p.name for p in dirs])

    if CLEAN:
        removed = []
        # 1) 重复图：**同一轮里**只留一份；跨轮的各自留（各是本轮证据）
        for h, ps in bad.items():
            if h in waived:
                continue                  # 核销过的（例如"改前缺陷存档"）不许删
            keep = min(ps, key=lambda p: (len(p.name), p.name))
            for p in ps:
                if p is keep:
                    continue
                removed.append({"name": p.name, "md5": h, "why":
                                f"与同轮的 {keep.name} 逐字节相同（那一步没生效，只留一份）"})
                p.unlink()
        # 2) 作废目录整体清掉（内容记进清单）
        for d in dirs:
            for p in sorted(d.rglob("*")):
                if p.is_file():
                    removed.append({"name": str(p.relative_to(SHOT)), "md5": md5_of(p),
                                    "why": "作废目录（拍错屏/重复的旧证据）"})
            shutil.rmtree(d, ignore_errors=True)
        # 3) 非图片杂物
        for p in junk_ext:
            removed.append({"name": p.name, "md5": md5_of(p), "why": "不是截图（杂物）"})
            p.unlink()
        manifest = SHOT / "作废清单.md"
        lines = ["# 作废清单（自动生成）", "",
                 f"清理时间：{report['at']}", f"清掉：{len(removed)} 个文件", "",
                 "| 文件 | md5 | 为什么作废 |", "|---|---|---|"]
        lines += [f"| {r['name']} | `{r['md5'][:8]}` | {r['why']} |" for r in removed]
        lines += ["", "留下的都是**内容各不相同**的有效证据；",
                  "「返回键回到同一屏」这类本来就一样的图，只保留一份代表。", ""]
        manifest.write_text("\n".join(lines), "utf-8")
        report["cleaned"] = {"removed": len(removed), "manifest": str(manifest.relative_to(ROOT)),
                             "keptFiles": len(
                                 [p for p in SHOT.iterdir() if p.is_file() and p.suffix == '.png'])}
        print(f"\n清理：删掉 {len(removed)} 个，剩下 "
              f"{report['cleaned']['keptFiles']} 张图；清单见 {report['cleaned']['manifest']}")

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1), "utf-8")
    print("报告：", OUT.relative_to(ROOT) if str(OUT).startswith(str(ROOT)) else OUT)
    if unwaived:
        print(f"\n判红：{len(unwaived)} 组'同一批次里两张一样'且没核销 —— "
              f"要么在 docs/截图重复核销.json 里逐组写清理由，要么 --clean 合并。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
