#!/usr/bin/env bash
# 第 39 轮回归：书里设置还原旧版后，跑一遍会被波及的判据
cd /home/ubuntu/novel-app || exit 1
run() { echo "=== $* ==="; "$@"; echo "exit=$?"; }
echo "--- 环境 ---"; free -m | head -2
run node tools/e2e-readerquick.js
run node tools/e2e-j1.js
run node tools/e2e-menu.js
run node tools/e2e-new5.js
run node tools/shots-30.js
run node tools/e2e-textfit.js
run node tools/e2e-layout.js
run node tools/e2e-uicheck.js
run python3 tools/verify_layout.py
echo "--- 收尾 ---"
node tools/sweep_chrome.js
ps -eo args | grep -c '[h]eadless'
