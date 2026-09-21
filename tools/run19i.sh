#!/bin/bash
# 第 19 轮收口 · 第二批：夜间（正跑 + 两条反证，截图分目录）→ 三态 → UI 硬判据 → 安全区/手势 → 切书 → 截图台账
cd /home/ubuntu/novel-app
L=logs/r19i.log
run () { echo "=== $*  $(date +%H:%M:%S) ===" >> $L; "$@" >> $L 2>&1; echo "exit=$? ===" >> $L; }
: > $L
echo "=== 开始 $(date +%H:%M:%S) ===" >> $L

echo "=== 夜间正跑（重拍 docs/前端截图/r19-*）$(date +%H:%M:%S) ===" >> $L
node tools/e2e-night.js >> $L 2>&1; echo "exit=$? ===" >> $L
run env NIGHT_REPORT=docs/夜间体检报告.json server/venv/bin/python tools/night_check.py

echo "=== 夜间反证 cover（图存 docs/截图反证-夜间cover/）$(date +%H:%M:%S) ===" >> $L
env NIGHT_FORCE=cover NIGHT_OUT=docs/夜间体检实测-反证-cover.json NIGHT_SHOTS=docs/截图反证-夜间cover \
  node tools/e2e-night.js >> $L 2>&1; echo "exit=$? ===" >> $L
run env NIGHT_SRC=docs/夜间体检实测-反证-cover.json NIGHT_REPORT=docs/夜间体检报告-反证-cover.json \
  NIGHT_SHOTDIR=docs/截图反证-夜间cover server/venv/bin/python tools/night_check.py

echo "=== 夜间反证 dim（图存 docs/截图反证-夜间dim/）$(date +%H:%M:%S) ===" >> $L
env NIGHT_FORCE=dim NIGHT_OUT=docs/夜间体检实测-反证-dim.json NIGHT_SHOTS=docs/截图反证-夜间dim \
  node tools/e2e-night.js >> $L 2>&1; echo "exit=$? ===" >> $L
run env NIGHT_SRC=docs/夜间体检实测-反证-dim.json NIGHT_REPORT=docs/夜间体检报告-反证-dim.json \
  NIGHT_SHOTDIR=docs/截图反证-夜间dim server/venv/bin/python tools/night_check.py

run node tools/e2e-states.js
run env STATES_FORCE=nopatch node tools/e2e-states.js
run node tools/e2e-uicheck.js
run env UICHK_FORCE=wide node tools/e2e-uicheck.js
run node tools/e2e-safearea.js
run env SAFE_FORCE=nopad node tools/e2e-safearea.js
run env SAFE_FORCE=clip node tools/e2e-safearea.js
run env SAFE_FORCE=trap node tools/e2e-safearea.js

echo "=== 切书（临时造一本，跑完删）$(date +%H:%M:%S) ===" >> $L
TB=$(node tools/tmpbook.js new 2>>$L); echo "临时书 $TB" >> $L
node tools/e2e-bookctx.js >> $L 2>&1; echo "exit=$? ===" >> $L
env E2E_OLDBUG=1 node tools/e2e-bookctx.js >> $L 2>&1; echo "反证 exit=$? ===" >> $L
node tools/tmpbook.js del "$TB" >> $L 2>&1

run server/venv/bin/python tools/shots_check.py r19
run python3 tools/shots_audit.py
echo "=== 全部结束 $(date +%H:%M:%S) ===" >> $L
