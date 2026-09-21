#!/bin/bash
cd /home/ubuntu/novel-app
L=logs/r19g.log
run () { echo "=== $*  $(date +%H:%M:%S) ===" >> $L; "$@" >> $L 2>&1; echo "exit=$? ===" >> $L; }
: > $L
run node tools/e2e-uicheck.js
run env UICHK_FORCE=wrap  node tools/e2e-uicheck.js
run env UICHK_FORCE=small node tools/e2e-uicheck.js
run env UICHK_FORCE=wide  node tools/e2e-uicheck.js
run node tools/e2e-pl.js
run env PL_FORCE=notab node tools/e2e-pl.js
run env PL_FORCE=nokey node tools/e2e-pl.js
run node tools/e2e-new5.js
run node tools/e2e-readerquick.js
run node tools/e2e-bkmini.js
run node tools/e2e-cover.js
run node tools/e2e-iface.js
run node tools/e2e-bookctx.js
echo "=== 全部结束 $(date +%H:%M:%S) ===" >> $L
