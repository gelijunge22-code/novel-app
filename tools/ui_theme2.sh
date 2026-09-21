#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 设置页里「主题」那一行怎么渲染的 ═══"
grep -nE "主题|theme" frontend/js/app.js | head -12
echo
echo "═══ 2. 主题选项的 HTML（找 swatch/dot/seg） ═══"
grep -nE "swatch|theme-dot|th-dot|data-theme" frontend/js/app.js frontend/js/reader.js frontend/index.html 2>/dev/null | head -12
echo
echo "═══ 3. CSS 里主题色块的定义 ═══"
grep -nE "swatch|theme-dot|th-dot|\.seg\b|seg-" frontend/css/*.css | head -20
echo
echo "═══ 4. .seg（选项胶囊）定义 ═══"
grep -n "\.seg" -A 6 frontend/css/base.css | head -24
