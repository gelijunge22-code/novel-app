#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 驱动器活着吗 ═══"
systemctl --user is-active codex-goal.service
echo
echo "═══ 收件箱投递进度 ═══"
echo "  inbox.txt 大小: $(stat -c%s logs/inbox.txt) 字节"
echo "  已投递到: $(cat logs/inbox.offset 2>/dev/null) 字节"
echo
echo "═══ 最近有没有注入记录 ═══"
grep -aE "inbox|注入|投递" logs/codex-goal.log 2>/dev/null | tail -5 | cut -c1-160
echo
echo "═══ Codex 最新动作 ═══"
tail -5 logs/codex-goal.log 2>/dev/null | cut -c1-150
echo "  日志时间: $(stat -c %y logs/codex-goal.log | cut -d. -f1)  现在: $(date '+%H:%M:%S')"
