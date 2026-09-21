#!/bin/bash
cd /home/ubuntu/novel-app
L=logs/r19h.log
run () { echo "=== $*  $(date +%H:%M:%S) ===" >> $L; "$@" >> $L 2>&1; echo "exit=$? ===" >> $L; }
: > $L
run node tools/e2e-uicheck.js
run node tools/e2e-states.js
run env STATES_FORCE=nopatch node tools/e2e-states.js
run env UICHK_FORCE=wrap  node tools/e2e-uicheck.js
run env UICHK_FORCE=small node tools/e2e-uicheck.js
run env UICHK_FORCE=wide  node tools/e2e-uicheck.js
# 切书自测要书架上有两本：临时建一本，跑完删掉（用户的稿子一个字不动）
echo "=== bookctx(临时书) $(date +%H:%M:%S) ===" >> $L
TB=$(node tools/tmpbook.js new 2>>$L); echo "临时书 $TB" >> $L
node tools/e2e-bookctx.js >> $L 2>&1; echo "exit=$? ===" >> $L
node tools/tmpbook.js del "$TB" >> $L 2>&1
run node tools/e2e-night.js
run env NIGHT_FORCE=cover NIGHT_OUT=docs/夜间体检实测-反证-cover.json node tools/e2e-night.js
run env NIGHT_FORCE=dim   NIGHT_OUT=docs/夜间体检实测-反证-dim.json   node tools/e2e-night.js
run server/venv/bin/python tools/night_check.py
run server/venv/bin/python tools/shots_check.py r19
run python3 tools/shots_audit.py
echo "=== 全部结束 $(date +%H:%M:%S) ===" >> $L
