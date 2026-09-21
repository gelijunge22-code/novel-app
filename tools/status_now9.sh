#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-145 | sed 's/^/  /'
echo
echo "═══ 2. 两个 bug 的状态 ═══"
echo "  ── bug1(目录/设置): $(grep -c 'currentTarget = document' frontend/js/app.js) 处已修注释"
echo "  ── bug2(对话页穿模): .bk-bar 现在长什么样:"
grep -nE "^\.bk-bar\{" frontend/css/base.css | sed 's/^/     /'
echo
echo "═══ 3. 最近 20 分钟新报告 ═══"
ls -t docs/*.json 2>/dev/null | head -8 | while read f; do
  printf "  %-34s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 4. 最近 20 分钟改了什么 ═══"
find . -newermt '-20 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.py' -o -name '*.java' \) -not -path './.git/*' -not -path './apk/build/*' -not -path './apk/assets/www/*' -not -path './data/*' 2>/dev/null | head -12 | sed 's/^/  /'
echo
echo "═══ 5. 死代码审计结果 ═══"
ls -t docs/*死代码* docs/*deadcode* 2>/dev/null | head -2 | while read f; do
  echo "  $f ($(stat -c %y "$f" | cut -d. -f1))"
done
python3 -c "
import json,glob
for f in glob.glob('docs/*死代码*')+glob.glob('docs/*deadcode*'):
    try:
        d=json.load(open(f)); print('  ',f,str(d)[:300])
    except: pass
" 2>/dev/null
echo
echo "═══ 6. 待办 / 包 ═══"
F=docs/待办清单.md
echo "  待办: 总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)  (清单改动 $(stat -c %y $F | cut -d. -f1))"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
