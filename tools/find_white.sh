#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 弹层构造代码里的白色/背景 ═══"
grep -nE "App.sheet *=|sheet *= *function|function sheet" frontend/js/app.js | head -5
echo
grep -nE "background:\s*#fff|background:\s*white|background:#ffffff|#fff\b" frontend/js/app.js | head -15
echo
echo "═══ 2. sheet 相关 CSS 里所有 background 写法 ═══"
grep -rnE "sheet|modal" frontend/css/*.css | grep -E "background" | head -20
echo
echo "═══ 3. --card 在夜间和日间的值（确认不是变量问题） ═══"
grep -nE "^\s*--card" frontend/css/base.css | sed 's/^/    /'
echo
echo "═══ 4. 有没有针对 .sheet-panel 的 白色 或 默认背景 ═══"
grep -rnB2 -A6 "\.sheet-panel{" frontend/css/base.css | head -40
