#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ map 是怎么被绑定的（决定 e.currentTarget 是谁）═══"
sed -n '660,680p' frontend/js/app.js | sed 's/^/  /'
echo
echo "  ── 找 addEventListener 绑定处:"
grep -nE "addEventListener\('click'|body.addEventListener|document.addEventListener" frontend/js/app.js | head -8 | cut -c1-150 | sed 's/^/  /'
echo
echo "  ── 委托绑定那段（看 currentTarget 会不会是容器）:"
grep -n "map\[" -B 8 -A 6 frontend/js/app.js | head -40 | cut -c1-150 | sed 's/^/  /'
