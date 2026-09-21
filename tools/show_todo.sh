#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ GOAL.md 勾选情况 ═══"
echo "  已完成: $(grep -c '^\- \[x\]' GOAL.md)   未完成: $(grep -c '^\- \[ \]' GOAL.md)"
grep -n '^\- \[ \]' GOAL.md | head -10 | cut -c1-130
echo
echo "═══ 待办清单.md 第 91-140 行（并入前端大改的表）═══"
sed -n '91,140p' docs/待办清单.md | grep -vE '^[[:space:]]*$' | cut -c1-140
echo
echo "═══ 待办清单.md 第 630-649 行（最后的收尾账）═══"
sed -n '630,649p' docs/待办清单.md | grep -vE '^[[:space:]]*$' | cut -c1-140
