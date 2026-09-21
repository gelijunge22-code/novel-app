#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══════ 1. 配置 ═══════"
cat server/config.json 2>/dev/null | head -30
echo
echo "═══════ 2. 依赖装了没 ═══════"
ls server/venv/bin/python 2>/dev/null && server/venv/bin/python -c "import fastapi, uvicorn; print(' fastapi', fastapi.__version__)" 2>&1 | head -3
echo
echo "═══════ 3. 端口起不起得来（用测试端口，不碰生产） ═══════"
cd server
timeout 25 ./venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8899 --log-level warning > /tmp/boot.log 2>&1 &
BP=$!
sleep 12
echo "--- 启动日志 ---"
tail -15 /tmp/boot.log
echo "--- 探测 ---"
curl -s -m 5 -o /dev/null -w "  /api/app/info -> %{http_code}\n" http://127.0.0.1:8899/api/app/info 2>&1
curl -s -m 5 -o /dev/null -w "  /docs         -> %{http_code}\n" http://127.0.0.1:8899/docs 2>&1
curl -s -m 5 http://127.0.0.1:8899/api/app/info 2>&1 | head -c 300
echo
kill $BP 2>/dev/null
