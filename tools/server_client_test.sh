#!/usr/bin/env bash
# ServerClient（装进 APK 的那份 Java 源码）在桌面上的单测。
#   跑法：bash tools/server_client_test.sh
# 为什么能这么测：它是**纯 Java**（不许 import android.*），所以 javac/java 直接跑得动。
set -euo pipefail
REPO=/home/ubuntu/novel-app
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}
PATH="$JAVA_HOME/bin:$PATH"
OUT_DIR=$(mktemp -d /tmp/nbapp-sctest.XXXXXX)
SRC=$REPO/apk/src/com/nbapp/desk/ServerClient.java
TST=$REPO/tools/java/ServerClientTest.java

# 口令：从老 App 的配置里读，**不打印**
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null || echo "")
[ -n "$PW" ] || { echo "读不到口令" >&2; exit 1; }

javac -encoding UTF-8 -d "$OUT_DIR" "$SRC" "$TST"
cd "$REPO"
java -Dfile.encoding=UTF-8 -cp "$OUT_DIR" ServerClientTest \
  "http://127.0.0.1:8899/" "http://[REDACTED-HOST]/novel/" "$PW" "docs/服务器后端实测.json"
rm -rf "$OUT_DIR"
