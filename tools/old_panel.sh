#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 大改前那一版（af9c0f1，09-20 12:21）里，阅读器设置面板长什么样 ═══"
git show af9c0f1:frontend/js/reader.js 2>/dev/null | grep -n "rd-quick\|排版\|背景\|听书\|书签\|笔记" | head -20 | cut -c1-150
echo
echo "═══ 那一版的面板 HTML（quickTab 附近）═══"
git show af9c0f1:frontend/js/reader.js 2>/dev/null > /tmp/old_reader.js
grep -n "function quickBody\|function quickTab\|rd-quick-bar\|rd-tab" /tmp/old_reader.js | head -10 | cut -c1-140
echo
echo "═══ 现在这一版同样位置 ═══"
grep -n "rd-quick-bar\|rd-tab\|function quickTab" frontend/js/reader.js | head -10 | cut -c1-140
echo
echo "═══ 两版行数 ═══"
wc -l /tmp/old_reader.js frontend/js/reader.js
