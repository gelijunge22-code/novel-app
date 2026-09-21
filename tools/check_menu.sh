#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 这个菜单在哪定义（继续阅读/全书搜索/换封面/改书名/重新开始/刷新字数/删除）═══"
grep -rn "继续阅读\|全书搜索\|刷新字数\|重新开始" frontend/js/*.js | head -12 | cut -c1-165
echo
echo "═══ 2. 全书搜索 的实现 ═══"
grep -rn "全书搜索\|search" frontend/js/studio.js frontend/js/app.js frontend/js/reader.js 2>/dev/null | grep -iE "search" | head -16 | cut -c1-165
echo
echo "═══ 3. 这个弹层用了什么容器/tab 结构 ═══"
grep -rn "data-q=\"search\|q:'search'\|'search'" frontend/js/*.js | head -10 | cut -c1-165
echo
echo "═══ 4. 关闭键 × 在这个弹层里怎么写 ═══"
grep -rn "closeBtn\|sheet-close\|×" frontend/js/studio.js 2>/dev/null | head -10 | cut -c1-150
