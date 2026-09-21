#!/bin/bash
W=/home/ubuntu/novel-app/frontend
echo "################ 5. api.js 暴露的全部接口方法 ################"
grep -nE "^\s+[A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*(async\s*)?(function|\()" $W/js/api.js | sed 's/^\([0-9]*\):\s*/\1| /' | head -60
echo
echo "################ 6. api.js 里出现的后端路径 ################"
grep -oE "['\"\`][^'\"\`]*(/api/|/nb/|/apk|/tts)[^'\"\`]*" $W/js/*.js | sed "s/^[^:]*://;s/^['\"\`]//" | sort -u | head -60
echo
echo "################ 7. 设置项（store.js 里的偏好键） ################"
sed -n '1,80p' $W/js/store.js | grep -oE "^\s+[a-zA-Z_]+:" | tr -d ' :' | tr '\n' ' '
echo
echo
echo "################ 8. 工具页清单（tools.js 标题） ################"
grep -oE "'[^']{2,12}'" $W/js/tools.js | sort -u | head -60
