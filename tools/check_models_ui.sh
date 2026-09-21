#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 这个「模型与手感」面板在哪 ═══"
grep -rn "模型与手感\|跟随平台默认\|和平台一致\|越高越发散" frontend/js/*.js | head -12 | cut -c1-165
echo
echo "═══ 2. 那排分类胶囊怎么定义的（会不会被截断成一个字）═══"
grep -rn "chip\|胶囊\|cat-row\|seg-chip" frontend/css/panels.css frontend/css/components.css 2>/dev/null | head -14 | cut -c1-160
echo
echo "═══ 3. 关闭键 / 标题这个头是什么结构（跟别的弹层一致吗）═══"
grep -rn "rs-head\|panel-head\|t-head" frontend/js/chat.js frontend/js/preset.js 2>/dev/null | head -10 | cut -c1-160
echo
echo "═══ 4. 底部那条"和平台一致 + 保存"怎么写的 ═══"
grep -rn "和平台一致" -A 4 -B 2 frontend/js/*.js | head -14 | cut -c1-165
