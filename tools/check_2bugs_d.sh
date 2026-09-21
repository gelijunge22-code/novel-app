#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ bug1: reader-quick 这个动作怎么处理的（它读不读 data-q）═══"
grep -nE "reader-quick" frontend/js/reader.js | head -10 | cut -c1-170 | sed 's/^/  /'
echo
echo "  ── 找到处理分支后看上下文:"
grep -n "reader-quick" -A 6 frontend/js/reader.js | head -30 | cut -c1-170 | sed 's/^/  /'
echo
echo "═══ bug2: 小方块的定位（height:0 会不会溢出压住下面）═══"
grep -nE "^\.bk-bar\{|^\.bk-mini\{|^\.bk-bar-host" frontend/css/base.css | head -6 | sed 's/^/  /'
echo
sed -n "$(grep -n '^\.bk-mini{' frontend/css/base.css | cut -d: -f1),+12p" frontend/css/base.css | sed 's/^/  /'
echo
echo "  ── 对话页里 chat-body 有没有给这块留位置:"
grep -nE "#chat-book|chat-body|\.bk-bar-host" frontend/css/panels.css frontend/css/base.css | head -10 | cut -c1-150 | sed 's/^/  /'
