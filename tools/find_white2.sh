#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. index.html 里 #sheet 的结构 ═══"
grep -nE "id=\"sheet|sheet" frontend/index.html | head -10
echo
echo "═══ 2. 有没有 #sheet-panel 的额外样式 ═══"
grep -rnE "#sheet-panel|#sheet\b" frontend/css/*.css frontend/js/*.js | head -10
echo
echo "═══ 3. 阅读器自己的纸色（reader 主题） ═══"
grep -nE "reader-page|--paper|paperOf|rd-paper|bgOf" frontend/js/reader.js | head -14
echo
echo "═══ 4. 阅读器设置弹层里怎么设底色的（关键） ═══"
sed -n '1275,1300p' frontend/js/reader.js
echo
echo "═══ 5. 全仓找「白」背景的写法 ═══"
grep -rnE "background:\s*(#fff|#ffffff|white|#FFF)\b" frontend/css/*.css | head -12
