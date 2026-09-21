#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 待办清单总体 ═══"
F=docs/待办清单.md
echo "  改动: $(stat -c %y $F | cut -d. -f1)"
echo "  总: $(grep -cE '^[[:space:]]*[-*] \[' $F)  已勾: $(grep -cE '^[[:space:]]*[-*] \[x\]' $F)  未勾: $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)"
echo
echo "  未勾的："
grep -nE '^[[:space:]]*[-*] \[ \]' $F | head -10
echo
echo "═══ 2. 它自列的 20 条（I 节）现在什么状态 ═══"
grep -nE "^\*\*I[0-9]+" $F | head -22 | cut -c1-100
echo
echo "═══ 3. 进度.md 最近在做什么 ═══"
grep -nE "^#{2,3} 第1[0-9]轮|^### .*轮" docs/进度.md 2>/dev/null | tail -6 | cut -c1-100
echo
echo "═══ 4. 当前书/切书 相关记录 ═══"
grep -nE "切书|当前书|bookctx" docs/进度.md 2>/dev/null | tail -6 | cut -c1-120
echo
echo "═══ 5. 它现在在做哪一件 ═══"
tail -4 logs/codex-goal.log | cut -c1-140
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)"
