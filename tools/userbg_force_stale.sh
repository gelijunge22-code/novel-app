#!/usr/bin/env bash
# 反证：`APPEARANCE_FORCE=stale` 把「上传/删除时不删旧文件」那个 bug 人为放回来
#       → 甲7 / 丙0b / 己2 必须报红（绿了说明那三条判据是空的）。
#
# 为什么要另起一个服务：那个开关是服务端启动时读的环境变量。
# 所以起一个**临时** uvicorn（8901，只在 127.0.0.1），拿它跑一遍同一份判据，
# 跑完立刻收掉 —— 不动 8899 那个正式服务。
set -u
cd /home/ubuntu/novel-app
PORT=8901
LOG=logs/userbg-stale.log
mkdir -p logs
setsid nohup env APPEARANCE_FORCE=stale server/venv/bin/python -m uvicorn server.app:app \
  --host 127.0.0.1 --port $PORT --log-level warning >>"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null' EXIT
for i in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
  sleep 0.5
done
E2E_URL="http://127.0.0.1:$PORT/" UBG_FORCE=stale node tools/e2e-userbg.js
RC=$?
exit $RC
