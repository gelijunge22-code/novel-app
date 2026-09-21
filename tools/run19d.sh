#!/bin/bash
# 第19轮 · 顺序跑一批自测（一次只起一个无头浏览器，跑完收干净）
cd /home/ubuntu/novel-app
L=logs/r19d.log
run () {
  echo "=== $*  $(date +%H:%M:%S) ===" >> $L
  "$@" >> $L 2>&1
  echo "exit=$? ===" >> $L
  ps -eo args | grep -q "[h]eadless" && node tools/sweep_chrome.js >> $L 2>&1
}
: > $L
run env COVER_FORCE=pad0 node tools/e2e-cover.js
run env COVER_FORCE=bar  node tools/e2e-cover.js
run node tools/e2e-pl.js
run env PL_FORCE=notab node tools/e2e-pl.js
run env PL_FORCE=nokey node tools/e2e-pl.js
run node tools/e2e-new5.js
echo "=== 全部结束 $(date +%H:%M:%S) ===" >> $L
