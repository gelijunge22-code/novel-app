#!/bin/bash
cd /home/ubuntu/novel-app
pkill -f 'tools/gh_wait' 2>/dev/null
sleep 1
python3 tools/gh_device.py 2>&1 | tail -6
