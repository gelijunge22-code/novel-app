#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 活着吗 / 多久没动 ═══"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)"
echo "  现在: $(date '+%H:%M:%S')"
echo "  日志大小: $(stat -c%s logs/codex-goal.log) 字节"
echo
echo "═══ 2. 最近 15 条命令（看是不是在重复同一件事） ═══"
grep -a "cmd:" logs/codex-goal.log | tail -15 | sed 's/.*cmd: //' | cut -c1-120 | nl | sed 's/^/  /'
echo
echo "═══ 3. 命令去重（看有没有死循环） ═══"
grep -a "cmd:" logs/codex-goal.log | tail -40 | sed 's/.*cmd: //' | cut -c1-70 | sort | uniq -c | sort -rn | head -8 | sed 's/^/  /'
echo
echo "═══ 4. 最近改动的文件（15分钟） ═══"
find . -newermt '-15 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.java' -o -name '*.py' -o -name '*.md' \) -not -path './.git/*' -not -path './apk/build/*' -not -path './apk/assets/www/*' 2>/dev/null | head -12 | sed 's/^/  /'
echo
echo "═══ 5. 检查点：那几件没干的活有没有动静 ═══"
echo "  ── 参考书架收图片（找 image/图片 input）:"
grep -cE "accept=.*image|data-img|收图片" frontend/js/studio.js 2>/dev/null | sed 's/^/     studio.js 里: /'
echo "  ── 切书条是否已改成小方块:"
grep -nE "bk-mini|bk-bar-mini|bk-fab|收成|小方块" frontend/css/base.css frontend/js/bookctx.js 2>/dev/null | head -3 | sed 's/^/     /'
echo "  ── 5 个新功能有没有开始:"
ls docs/进度.md >/dev/null 2>&1 && grep -nE "5 个新功能|五个新功能|新功能" docs/待办清单.md 2>/dev/null | tail -3 | sed 's/^/     /'
echo
echo "═══ 6. token / 目标状态 ═══"
python3 -c "
import json
d=json.load(open('logs/goal-state.json')); g=d.get('goal') or d
print('  状态:',g.get('status'),'| token:',round((g.get('tokensUsed') or 0)/10000)/100,'万')
" 2>/dev/null
echo
echo "═══ 7. 最近有没有报错堆积 ═══"
grep -aE "error|Error|失败|FATAL" logs/codex-goal.log | tail -5 | cut -c1-140 | sed 's/^/  /'
