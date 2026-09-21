#!/bin/bash
# 第 41 轮全量回归（后半段：run41 被通道中断掐掉，从这里接着跑）
cd /home/ubuntu/novel-app
echo "════════ run41b @ $(date '+%F %T') ════════"
run() { echo; echo "──── $1 ────"; shift; "$@" 2>&1 | tail -8; }
run "uicheck"           node tools/e2e-uicheck.js
run "decor（纹样真的渲染了？）" node tools/e2e-decor.js
run "readerquick"       node tools/e2e-readerquick.js
run "bkmini"            node tools/e2e-bkmini.js
run "verify_layout"     python3 tools/verify_layout.py
run "verify_tokens"     python3 tools/verify_tokens.py
echo; echo "──── 无头浏览器残留 ────"; ps -eo args | grep -c '[h]eadless'
echo "════════ run41b 结束 @ $(date '+%F %T') ════════"
