#!/bin/bash
# 第 41 轮全量回归：跑完每一件都把结论写进 logs/run41.log
cd /home/ubuntu/novel-app
echo "════════ run41 @ $(date '+%F %T') ════════"
run() { echo; echo "──── $1 ────"; shift; "$@" 2>&1 | tail -8; }
run "textfit 正常"      node tools/e2e-textfit.js
for f in longtitle clip tiny; do run "textfit 反证 $f" env TEXTFIT_FORCE=$f node tools/e2e-textfit.js; done
run "layout"            node tools/e2e-layout.js
run "j1"                node tools/e2e-j1.js
run "new5"              node tools/e2e-new5.js
run "uicheck"           node tools/e2e-uicheck.js
run "decor（纹样真的渲染了？）" node tools/e2e-decor.js
run "readerquick"       node tools/e2e-readerquick.js
run "bkmini"            node tools/e2e-bkmini.js
run "verify_layout"     python3 tools/verify_layout.py
run "verify_tokens"     python3 tools/verify_tokens.py
echo; echo "──── 无头浏览器残留 ────"; ps -eo args | grep -c '[h]eadless'
echo "════════ run41 结束 @ $(date '+%F %T') ════════"
