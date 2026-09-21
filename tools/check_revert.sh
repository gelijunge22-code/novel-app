#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 书里的设置：回退了没有？（看最近提交有没有动它）═══"
git log --oneline -6 --date=format:'%H:%M' --pretty=format:'  %h %ad %s' -- frontend/js/reader.js | cut -c1-140
echo
echo "  ── 现在 rd-quick 面板的 tab 定义（回退成功的话应该贴近旧版）:"
grep -n "rd-quick-bar\|data-q=\"type\"\|data-q=\"bg\"\|排版\|背景" frontend/js/reader.js | head -8 | cut -c1-150
echo
echo "═══ 2. 切书小方块：改回原来的样子了吗 ═══"
grep -rn "bk-mini\|bk-bar" frontend/css/*.css frontend/js/*.js 2>/dev/null | head -12 | cut -c1-155
echo
echo "═══ 3. 最近 5 个提交（看它到底做到哪了）═══"
git log --oneline -5 --date=format:'%m-%d %H:%M' --pretty=format:'  %h %ad %s' | cut -c1-150
echo
echo
echo "═══ 4. 工作区有没有正在改这些 ═══"
git status --short | head -14 | sed 's/^/  /'
