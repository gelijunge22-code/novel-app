#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 进度 / 提交节奏（今天）═══"
git log --since="today 00:00" --pretty=format:'  %ad %s' --date=format:'%H:%M' | cut -c1-120
echo; echo
echo "═══ 2. 前端体积 ═══"
B=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
echo "  现在 $B 字节   /  目标 1453142  →  $(python3 -c "print('%.1f%%'%($B/1453142*100))")"
echo
echo "═══ 3. 还剩哪些（进度文档里最后一次写的'下一步'）═══"
grep -a "下一步\|接着做\|还欠" docs/进度.md | head -8 | cut -c1-165
echo
echo "═══ 4. 用户点名、我确认过还没提交的 ═══"
echo "  [ ] 切书控件改回原样（不穿模）      ← 催了2次"
echo "  [ ] 大设置 16 处文字出框"
echo "  [ ] 对话页：标题省略号 + 底部半截按钮 + 展开态收紧"
echo "  [ ] 清测试会话（冒烟-出字判据 等 7 个）"
echo "  [ ] 预设页按用途分组重排"
echo "  [ ] AI 真会用工具 + 看得见"
echo "  [ ] 全站尺度再收一档"
echo
echo "═══ 5. 收尾件 ═══"
echo "  [ ] 重写 DONE.md"
echo "  [ ] 只打一次最终 APK（版本递增 + 签名一致）"
echo
echo "═══ 6. 现在在这轮待了多久 ═══"
echo "  最后一次提交: $(git log -1 --pretty=format:'%ad' --date=format:'%m-%d %H:%M')"
echo "  现在: $(date '+%m-%d %H:%M')"
echo "  工作区改动: $(git status --short | wc -l) 个文件"
