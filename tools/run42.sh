#!/bin/bash
# 第 42 轮全量回归
cd /home/ubuntu/novel-app
echo "════════ run42 @ $(date '+%F %T') ════════"
run() { echo; echo "──── $1 ────"; shift; "$@" 2>&1 | tail -10; }
run "verify_tokens"        python3 tools/verify_tokens.py
run "verify_layout"        python3 tools/verify_layout.py
run "verify_no_litter"     python3 tools/verify_no_litter.py
run "verify_book_scope"    python3 tools/verify_book_scope.py
run "textfit 正常"          node tools/e2e-textfit.js
run "layout"               node tools/e2e-layout.js
run "uicheck"              node tools/e2e-uicheck.js
run "j1"                   node tools/e2e-j1.js
run "new5"                 node tools/e2e-new5.js
run "decor"                node tools/e2e-decor.js
run "readerquick"          node tools/e2e-readerquick.js
run "bkmini"               node tools/e2e-bkmini.js
run "chatmsg"              node tools/e2e-chatmsg.js
run "chatsafe"             node tools/e2e-chatsafe.js
run "菜单"                  node tools/e2e-menu.js
run "联网搜索"              node tools/e2e-websearch.js
echo; echo "──── 无头浏览器残留 ────"; ps -eo args | grep -c '[h]eadless'
echo "════════ run42 结束 @ $(date '+%F %T') ════════"
