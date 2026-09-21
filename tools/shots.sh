#!/bin/bash
cd /home/ubuntu/novel-app/docs/前端截图
echo "=== 截图总数: $(ls | wc -l) ==="
echo
echo "=== 按类别分组 ==="
ls | sed 's/[0-9]\+//g; s/\.png$//' | sort | uniq -c | sort -rn | head -25
echo
echo "=== 最新的 30 张 ==="
ls -t | head -30
