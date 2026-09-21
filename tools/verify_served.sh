#!/usr/bin/env bash
# 关键核对：服务器实际吐给用户的前端，跟仓库里的 frontend/ 是不是同一份
cd /home/ubuntu/novel-app
echo "═══ 1. 8899 服务从哪个目录读前端 ═══"
grep -rn "StaticFiles\|mount\|assets\|web/\|frontend" server/app.py 2>/dev/null | head -12 | cut -c1-160
echo
echo "═══ 2. 公网吐出来的 reader.js 跟仓库逐字节比 ═══"
for f in js/reader.js js/api.js js/chat.js index.html css/base.css; do
  curl -s "http://<你的服务器地址>/novel/$f" -o /tmp/served_$(basename $f) 2>/dev/null
  if [ -f "frontend/$f" ]; then
    a=$(md5sum "frontend/$f" | cut -d' ' -f1)
    b=$(md5sum "/tmp/served_$(basename $f)" | cut -d' ' -f1)
    if [ "$a" = "$b" ]; then echo "  ✅ 一致  $f"; else echo "  ❌ 不一致 $f   仓库=$a  线上=$b"; fi
  else
    echo "  ?? 仓库里没这个文件: $f"
  fi
done
echo
echo "═══ 3. 线上那份里，我的听书修复标志在不在 ═══"
echo "  ── 仓库 frontend/js/reader.js 里搜「同步解锁 / 听书自检 / ttsdiag」:"
grep -c "ttsdiag\|解锁\|听书自检" frontend/js/reader.js 2>/dev/null | sed 's/^/    命中 /'
echo "  ── 线上 /js/reader.js 里搜同样东西:"
grep -c "ttsdiag\|解锁\|听书自检" /tmp/served_reader.js 2>/dev/null | sed 's/^/    命中 /'
echo
echo "═══ 4. 线上那份里，自动播放解锁在不在（我刚才让做的）═══"
grep -n "autoplay\|play().catch\|同步解锁" /tmp/served_reader.js 2>/dev/null | head -6 | cut -c1-150
echo
echo "═══ 5. apk 里内嵌的前端是哪个年代 ═══"
ls -la apk/assets/www/js/reader.js 2>/dev/null | awk '{print "  apk/assets/www/js/reader.js  ", $5"字节  ", $6" "$7" "$8}'
[ -f apk/assets/www/js/reader.js ] && echo "    apk 内嵌版里 ttsdiag 命中: $(grep -c 'ttsdiag\|听书自检' apk/assets/www/js/reader.js)"
