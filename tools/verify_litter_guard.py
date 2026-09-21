#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反证：`verify_no_litter.py` 的判据**真的会红**（不是永远绿的摆设）。

做法（三段，全程真库真跑）：
  ① 先跑一遍基线：应该 6/6；
  ② 往 `note` 表塞一行"书都没了"的孤儿行（slug 是编的）→ 再跑 → **必须**失败（退出码 1，
     且点名 `note`）；
  ③ 把那行删掉 → 再跑 → 回到 6/6。
任一段不符合预期就退 1。

用法：server/venv/bin/python tools/verify_litter_guard.py
产出：docs/残留判据反证.json
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data/app.db"
OUT = ROOT / "docs/残留判据反证.json"
PY = str(ROOT / "server/venv/bin/python")
FAKE = "残留判据反证-X"


def run() -> tuple[int, str]:
    p = subprocess.run([PY, str(ROOT / "tools/verify_no_litter.py")],
                       capture_output=True, text=True, cwd=str(ROOT))
    return p.returncode, (p.stdout + p.stderr)


def main() -> int:
    rows = []
    code0, out0 = run()
    rows.append({"step": "① 基线", "exit": code0, "ok": code0 == 0,
                 "tail": out0.strip().splitlines()[-1][:120]})

    con = sqlite3.connect(DB)
    con.execute("INSERT INTO note(slug,path,percent,quote,text,created_at,updated_at)"
                " VALUES(?,?,0,'','',1,1)", (FAKE, "manuscript/反证.md"))
    con.commit()
    con.close()
    code1, out1 = run()
    hits = "note" in out1 and "✗" in out1
    rows.append({"step": "② 塞一行孤儿 → 判据必须报", "exit": code1,
                 "ok": code1 == 1 and hits,
                 "tail": out1.strip().splitlines()[-1][:120]})

    con = sqlite3.connect(DB)
    con.execute("DELETE FROM note WHERE slug=?", (FAKE,))
    con.commit()
    con.close()
    code2, out2 = run()
    rows.append({"step": "③ 撤掉那行 → 回到全绿", "exit": code2, "ok": code2 == 0,
                 "tail": out2.strip().splitlines()[-1][:120]})

    ok = sum(1 for r in rows if r["ok"])
    OUT.write_text(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"),
                               "total": len(rows), "ok": ok, "items": rows},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    for r in rows:
        print(("  ✓ " if r["ok"] else "  ✗ ") + r["step"] + f"（退出码 {r['exit']}） {r['tail']}")
    print(f"\n=== 残留判据反证 {ok}/{len(rows)} ===")
    print("报告：docs/残留判据反证.json")
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
