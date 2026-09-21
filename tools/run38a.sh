#!/usr/bin/env bash
# 第 38 轮第一批回归：文字出框判据（含三条反证）+ 被改动波及的判据
cd /home/ubuntu/novel-app || exit 1
run() { echo "=== $* ==="; "$@"; echo "exit=$?"; }
echo "--- 环境 ---"; free -m | head -2

run node tools/e2e-textfit.js
run env TEXTFIT_FORCE=longtitle node tools/e2e-textfit.js
run env TEXTFIT_FORCE=clip      node tools/e2e-textfit.js
run env TEXTFIT_FORCE=tiny      node tools/e2e-textfit.js
run node tools/e2e-readerquick.js
run node tools/e2e-layout.js
run node tools/e2e-uicheck.js
run python3 tools/verify_layout.py
echo "--- 收尾 ---"
ps -eo args | grep -c '[h]eadless'
