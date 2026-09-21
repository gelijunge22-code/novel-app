#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 服务 ═══"
echo "  驱动器: $(systemctl --user is-active codex-goal.service)"
python3 -c "
import json,time
d=json.load(open('logs/goal-state.json'))
g=d.get('goal') or d
print('  目标状态:',g.get('status'))
print('  token:',round((g.get('tokensUsed') or 0)/10000)/100,'万')
s=g.get('startedAt') or d.get('startedAt')
if s: print('  已跑:',round((time.time()-s/1000)/3600,1),'小时')
" 2>/dev/null
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo
echo "═══ 待办清单（有没有交总表） ═══"
stat -c "  改动时间: %y  大小: %s字节" docs/待办清单.md
echo "  总条数: $(grep -cE '^[[:space:]]*[-*] \[' docs/待办清单.md)  已勾: $(grep -cE '^[[:space:]]*[-*] \[x\]' docs/待办清单.md)  未勾: $(grep -cE '^[[:space:]]*[-*] \[ \]' docs/待办清单.md)"
echo "  有没有提到 20 条新任务:"
grep -nE "T0[1-9]|T1[0-9]|T20|超难|20 个|20个" docs/待办清单.md | head -8
echo
echo "═══ 自审清单 ═══"
stat -c "  改动时间: %y  大小: %s字节" docs/自审清单.md 2>/dev/null
echo
echo "═══ 最近改动过的文件 ═══"
find . -newermt '-90 minutes' -type f \( -name '*.py' -o -name '*.js' -o -name '*.css' -o -name '*.md' \) -not -path './.git/*' 2>/dev/null | head -12
echo
echo "═══ APK ═══"
ls -la apk/*.apk 2>/dev/null | awk '{print "  ",$9,$5"B",$6,$7,$8}'
echo
echo "═══ 它最新在干什么 ═══"
tail -4 logs/codex-goal.log | cut -c1-140
