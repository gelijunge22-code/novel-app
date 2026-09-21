#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 阅读器里所有"目录"入口 ═══"
grep -nE "目录" frontend/js/reader.js frontend/index.html | head -14 | cut -c1-160 | sed 's/^/  /'
echo
echo "═══ 2. 阅读页底部那条（showChrome 里的底栏）═══"
grep -nE "rd-foot|rd-bottom|rd-bar|footer" frontend/js/reader.js | head -10 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 3. toc() 被谁调用 ═══"
grep -rnE "toc\(\)|Reader.toc|data-act=\"toc\"|'toc'" frontend/js/*.js | head -12 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 4. 阅读器底栏按钮定义（在 index.html 里）═══"
grep -nE "data-act|rd-qbtn|rd-quick" frontend/index.html | head -20 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 5. 对话页整段结构（找小方块位置）═══"
sed -n '118,142p' frontend/index.html | sed 's/^/  /'
