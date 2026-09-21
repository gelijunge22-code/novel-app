#!/usr/bin/env bash
# 反证：把后端指到**死端口**，ServerClient 那一串判据**必须报红**。
# 判据先能红，绿才算数（监督人立的规矩）。
set -euo pipefail
REPO=/home/ubuntu/novel-app
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}
PATH="$JAVA_HOME/bin:$PATH"
OUT=$(mktemp -d /tmp/nbapp-scproof.XXXXXX)
javac -encoding UTF-8 -d "$OUT" "$REPO/apk/src/com/nbapp/desk/ServerClient.java" "$REPO/tools/java/ServerClientTest.java"
cd "$REPO"
set +e
java -Dfile.encoding=UTF-8 -cp "$OUT" ServerClientTest \
  "http://127.0.0.1:9/" "http://127.0.0.1:9/" "绝对不是口令" "docs/服务器后端实测-反证.json" > /tmp/scproof.out 2>&1
CODE=$?
set -e
REDS=$(grep -c '✗' /tmp/scproof.out || true)
GREENS=$(grep -c '✓' /tmp/scproof.out || true)
echo "[反证] 后端指到死端口：报红 $REDS 条 / 报绿 $GREENS 条（退出码 $CODE，必须非 0）"
grep '✗' /tmp/scproof.out | head -8
if [ "$CODE" -ne 0 ] && [ "$REDS" -ge 8 ]; then
  echo "[反证通过] 判据能报红 —— 不是空判据"
else
  echo "[反证失败] 判据是空的！"; exit 1
fi
python3 - "$OUT" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY
