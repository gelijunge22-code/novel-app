#!/bin/bash
cd /home/ubuntu/novel-app/apk
echo "=== build.sh 现在怎么打的 ==="
head -30 build.sh
echo
echo "=== 有没有 gradlew ==="
ls -la gradlew gradle/wrapper/*.jar 2>/dev/null | awk '{print "  ",$9,$5"B"}'
echo "=== gradle 命令 ==="
which gradle 2>/dev/null || ls /home/ubuntu/novel-app/apk/gradle* -d 2>/dev/null
cat /home/ubuntu/novel-app/apk/local.properties 2>/dev/null | sed 's/sdk.dir/sdk.dir/'
