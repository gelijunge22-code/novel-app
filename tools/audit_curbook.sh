#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 预设里的「这本书」是怎么定的（S.slug 从哪来） ═══"
grep -nE "S\.slug\s*=|slug:" frontend/js/preset.js | head -14
echo
echo "═══ 2. 能不能选书（有没有选书入口） ═══"
grep -nE "pickProject|选书|选择书|Shelf|projects" frontend/js/preset.js | head -10
echo
echo "═══ 3. 切书按钮长什么样（setScope） ═══"
sed -n '308,330p' frontend/js/preset.js
echo
echo "═══ 4. 有没有「当前书」的全局状态 ═══"
grep -rnE "currentBook|currentProject|curBook|activeBook|state.book" frontend/js/*.js | head -10
echo
echo "═══ 5. AI 对话有没有跟书绑定 ═══"
grep -nE "slug|book" frontend/js/chat.js | head -10
