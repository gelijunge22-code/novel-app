#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 阅读器菜单里的「设置/颜色」在哪 ═══"
grep -nE "米黄|跟随系统|切换|theme" frontend/js/reader.js | head -15
echo
echo "═══ 2. 那些选项的 HTML 结构（是圆的还是方的） ═══"
grep -nE "rd-theme|theme-dot|data-theme" frontend/js/reader.js frontend/js/app.js frontend/index.html 2>/dev/null | head -12
echo
echo "═══ 3. 对应的 CSS ═══"
grep -nE "rd-theme|theme-dot|data-theme|border-radius: *50%|border-radius:50%" frontend/css/*.css | head -20
echo
echo "═══ 4. 全局圆角规范（其他地方用的什么） ═══"
grep -nE "^\s*--(r|radius)" frontend/css/base.css | head -10
grep -oE "border-radius: *[0-9]+px" frontend/css/*.css | sort | uniq -c | sort -rn | head -8
