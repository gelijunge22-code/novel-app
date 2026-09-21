#!/bin/bash
A=/home/ubuntu/novel-app/frontend/js/api.js
S=/home/ubuntu/novel-app/server/_legacy_nbapp_server.py
echo "########## A. 前端 api.js 里对外的方法 ##########"
grep -oE "^  [a-zA-Z_]+[a-zA-Z0-9_]*\s*(:|\()" $A | sed 's/[:( ]//g' | sort -u | tr '\n' ' '
echo; echo "方法总数: $(grep -cE "^  [a-zA-Z_]+[a-zA-Z0-9_]*\s*(:|\()" $A)"
echo
echo "########## B. api.js 里真正请求的路径 ##########"
grep -oE "['\"\`]/api/[^'\"\`]*" $A | sed "s/['\"\`]//" | sort -u
echo
echo "########## C. 反代层转发的路径 ##########"
grep -oE "['\"\`]/[a-zA-Z0-9_/.-]*['\"\`]" $S | sed "s/['\"\`]//g" | grep -vE "^/$|^/home" | sort -u | head -60
echo
echo "########## D. 反代层大小 ##########"
wc -l $S
