#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-145 | sed 's/^/  /'
echo
echo "═══ 2. 我刚报的两个 bug 修了吗 ═══"
echo "  ── bug1: reader-quick 还读不读 currentTarget（该改成 target）:"
grep -nE "reader-quick" -A 5 frontend/js/app.js | grep -E "currentTarget|closest|dataset.q" | head -4 | sed 's/^/     /'
echo
echo "  ── bug2: bk-bar 还是不是 height:0 + overflow:visible:"
grep -nE "^\.bk-bar\{|^\.bk-mini\{" -A 2 frontend/css/base.css | head -10 | sed 's/^/     /'
echo
echo "═══ 3. 最近 25 分钟的新报告 ═══"
ls -t docs/*.json 2>/dev/null | head -7 | while read f; do
  printf "  %-34s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 4. 最近 25 分钟改的代码 ═══"
find . -newermt '-25 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.py' \) -not -path './.git/*' -not -path './apk/build/*' -not -path './apk/assets/www/*' -not -path './data/*' -not -path './docs/*' 2>/dev/null | head -12 | sed 's/^/  /'
echo
echo "═══ 5. 5 个新功能 ═══"
for k in 故事线 常用指令 小批注 点一下看设定 章节顺序; do
  code=$(grep -rl "$k" frontend/js/*.js frontend/css/*.css server/routers/*.py 2>/dev/null | wc -l)
  printf "  %-12s %s 个文件\n" "$k" "$code"
done
echo "  ── 新文件 authoring.js 在不在:"
ls -la frontend/js/authoring.js 2>/dev/null | awk '{printf "     %s %s字节 %s %s\n",$9,$5,$6,$7}' || echo "     还没建"
echo
echo "═══ 6. 待办 / 包 / 内存 ═══"
F=docs/待办清单.md
echo "  待办: 总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)  (清单改动 $(stat -c %y $F | cut -d. -f1))"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
free -h | head -2 | sed 's/^/  /'
