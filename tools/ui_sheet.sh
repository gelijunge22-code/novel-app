#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 底部弹层（sheet/drawer）的 CSS ═══"
grep -nE "\.sheet|\.drawer|\.modal|slideUp|\.pop" frontend/css/*.css | head -20
echo
echo "═══ 2. sheet 的圆角和背景定义 ═══"
for f in frontend/css/*.css; do
  grep -n "\.sheet" -A 10 "$f" 2>/dev/null | grep -E "\.sheet|border-radius|background|overflow|padding-bottom|safe-area" | head -14
done
echo
echo "═══ 3. 有没有漏掉圆角/背景的地方（只圆上面 vs 全圆） ═══"
grep -rnE "border-radius: *(14px|16px|18px|20px) +(14px|16px|18px|20px) +0 +0" frontend/css/*.css | head -10
echo
echo "═══ 4. 夜间模式下弹层的背景色变量 ═══"
grep -nE "^\s*--paper|^\s*--bg|^\s*--card|^\s*--line" frontend/css/base.css | head -12
echo
echo "═══ 5. Codex 现在在干什么 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json,time
d=json.load(open('/home/ubuntu/novel-app/logs/goal-state.json'))
g=d.get('goal') or d
print('  目标:',g.get('status'),'| 已用:',round((g.get('tokensUsed') or 0)/10000)/100,'万 token')
" 2>/dev/null
echo "  日志最后 3 行:"
tail -3 /home/ubuntu/novel-app/logs/codex-goal.log 2>/dev/null | cut -c1-160 | sed 's/^/    /'
echo "  最后活动: $(stat -c %y /home/ubuntu/novel-app/logs/codex-goal.log 2>/dev/null | cut -d. -f1)"
