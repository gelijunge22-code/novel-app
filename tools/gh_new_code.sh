#!/bin/bash
cd /home/ubuntu/novel-app
# 停掉旧的在等的脚本
for p in $(pgrep -f "gh_wait.py" 2>/dev/null); do kill "$p" 2>/dev/null; done
sleep 1
echo "=== 重新申请设备码 ==="
python3 tools/gh_device.py 2>&1 | tail -8
