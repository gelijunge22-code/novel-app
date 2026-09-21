#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 所有 sheet/modal 面板定义（找冲突） ═══"
grep -rnE "^\.sheet-panel|^\.modal-panel|^\.sheet-body|^\.sheet-head|\.sheet-panel\s*\{|\.modal-panel\s*\{" frontend/css/*.css | head -20
echo
echo "  具体值:"
grep -rn "border-radius" frontend/css/*.css | grep -E "0 0|0 0$" | head -12
echo
echo "═══ 2. sheet-panel 有没有 overflow:hidden（不隐藏就盖不住圆角） ═══"
grep -n "\.sheet-panel" -A 12 frontend/css/base.css | grep -E "\.sheet-panel|overflow|border-radius|background" | head -12
echo
echo "═══ 3. 阅读器右上角「...」菜单里，设置是怎么弹的 ═══"
grep -nE "设置|sheet|openSheet" frontend/js/reader.js | head -12
echo
echo "═══ 4. Codex 状态 ═══"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
python3 -c "
import json
d=json.load(open('/home/ubuntu/novel-app/logs/goal-state.json'))
g=d.get('goal') or d
print('  目标状态:',g.get('status'),'| token:',round((g.get('tokensUsed') or 0)/10000)/100,'万')
" 2>/dev/null
echo "  日志改动: $(stat -c %y logs/codex-goal.log 2>/dev/null | cut -d. -f1)  (现在 $(date '+%H:%M:%S'))"
echo "  最后几条:"
tail -4 logs/codex-goal.log 2>/dev/null | cut -c1-150 | sed 's/^/    /'
