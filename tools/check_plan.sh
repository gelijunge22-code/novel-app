#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 进度文档里有没有排期/接单记录 ═══"
grep -n "排期\|接单\|联网搜索\|派活\|大纲\|华丽\|花纹\|波纹\|竹子" docs/进度.md | head -20 | cut -c1-155
echo
echo "═══ 2. 待办清单里有没有新增这几条 ═══"
grep -n "联网搜索\|派活\|华丽\|花纹\|大纲\|素材库" docs/待办清单.md | head -20 | cut -c1-155
echo
echo "═══ 3. 进度文档最顶部 16 行 ═══"
head -16 docs/进度.md | grep -vE '^[[:space:]]*$' | cut -c1-150
echo
echo "═══ 4. 现在的提交清单（最近 5 条）═══"
git log --pretty=format:'  %ad %s' --date=format:'%m-%d %H:%M' | head -5 | cut -c1-140
echo
echo
echo "═══ 5. 心跳 ═══"
stat -c "  %y" logs/codex-goal.log | cut -d. -f1
date '+  现在 %H:%M:%S'
