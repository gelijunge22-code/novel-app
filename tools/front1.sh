#!/bin/bash
# 从代码里自动扒出「前端到底有什么」，供 Codex 读懂
W=/home/ubuntu/novel-app/frontend
echo "################ 1. 页面与容器（index.html 的骨架） ################"
grep -oE '<(section|div|nav|header|footer|main)[^>]*(id="[^"]+"|class="[^"]+")' $W/index.html \
  | grep -oE 'id="[^"]+"|class="[^"]+"' | sed 's/id=//;s/class=//' | sort -u | head -70
echo
echo "################ 2. 底栏页签 ################"
grep -oE 'data-tab="[^"]+"' $W/index.html | sort -u
grep -oE 'data-tab="[^"]+"' $W/js/*.js | sed 's/.*://' | sort -u
echo
echo "################ 3. 所有可点元素（data-* 动作） ################"
grep -ohE 'data-[a-z]+="[^"]+"' $W/index.html $W/js/*.js | sort | uniq -c | sort -rn | head -50
echo
echo "################ 4. 工具页有哪些（12 件） ################"
grep -oE "key: *'[a-z-]+'|id: *'[a-z-]+'|title: *'[^']+'" $W/js/tools.js | head -40
