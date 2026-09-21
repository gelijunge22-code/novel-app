#!/bin/bash
set -e
echo "=== 架构 ==="
uname -m
echo
echo "=== 下载 本地代理（GitHub 直连可通） ==="
cd /tmp
VER=$(curl -s -m 20 https://api.github.com/repos/MetaCubeX/本地代理/releases/latest | python3 -c "import json,sys;print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null)
echo "  最新版本: $VER"
[ -z "$VER" ] && VER="v1.19.12"
URL="https://github.com/MetaCubeX/本地代理/releases/download/$VER/本地代理-linux-amd64-$VER.gz"
echo "  下载 $URL"
curl -sL -m 180 -o 本地代理.gz "$URL" && ls -la 本地代理.gz | awk '{print "  下载完成:",$5"B"}'
gunzip -f 本地代理.gz && chmod +x 本地代理 && mv -f 本地代理 /usr/local/bin/本地代理
echo "  ✅ 装到 /usr/local/bin/本地代理"
/usr/local/bin/本地代理 -v 2>&1 | head -2
