#!/bin/bash
cd /home/ubuntu/novel-app
L=logs/r19k.log
run () { echo "=== $*  $(date +%H:%M:%S) ===" >> $L; "$@" >> $L 2>&1; echo "exit=$? ===" >> $L; }
: > $L
echo "=== 开始 $(date +%H:%M:%S) ===" >> $L
run node tools/e2e-uicheck.js
run env UICHK_FORCE=wide node tools/e2e-uicheck.js
run env UICHK_FORCE=wrap node tools/e2e-uicheck.js
run env UICHK_FORCE=small node tools/e2e-uicheck.js
run node tools/e2e-safearea.js
run env SAFE_FORCE=nopad node tools/e2e-safearea.js
run env SAFE_FORCE=clip  node tools/e2e-safearea.js
run env SAFE_FORCE=trap  node tools/e2e-safearea.js
run env SAFE_FORCE=pad0  node tools/e2e-safearea.js
echo "=== 切书（临时造一本，跑完删）$(date +%H:%M:%S) ===" >> $L
TB=$(node tools/tmpbook.js new 2>>$L); echo "临时书 $TB" >> $L
node tools/e2e-bookctx.js >> $L 2>&1; echo "exit=$? ===" >> $L
env E2E_OLDBUG=1 node tools/e2e-bookctx.js >> $L 2>&1; echo "反证 exit=$? ===" >> $L
node tools/tmpbook.js del "$TB" >> $L 2>&1
run server/venv/bin/python tools/shots_check.py r19
run python3 tools/shots_audit.py
echo "=== 全部结束 $(date +%H:%M:%S) ===" >> $L
