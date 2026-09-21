#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 它最近在想什么/做什么（去掉刷屏 delta，看真实动作） ═══"
grep -vE 'textDelta|reasoning/summaryTextDelta|outputDelta' logs/codex-goal.log | tail -40 | cut -c1-190
echo
echo "═══ 2. 最近 40 分钟碰过哪些业务文件（排除编译产物） ═══"
find . -newermt '-40 minutes' -type f ! -path './.git/*' ! -path './logs/*' ! -path '*__pycache__*' \
  ! -path '*/venv/*' ! -path './apk/build/*' ! -name '*.class' ! -name '*.apk' 2>/dev/null | head -25
