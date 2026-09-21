#!/bin/bash
D=/home/ubuntu/nbapp/apk
NEW=/home/ubuntu/novel-app/apk/手机写作台.apk

echo "=== 备份旧的 ==="
cp -f $D/app-release.apk /tmp/old-apk-backup.apk 2>/dev/null && echo "  已备份到 /tmp"
cp -f $D/apk-version.json /tmp/old-apk-version.json 2>/dev/null

echo
echo "=== 换上新包 ==="
cp -f "$NEW" $D/app-release.apk
cp -f "$NEW" $D/手机写作台.apk
SHA=$(sha256sum "$NEW" | cut -d' ' -f1)
SIZE=$(stat -c%s "$NEW")
cat > $D/apk-version.json <<EOF
{
  "versionCode": 22,
  "versionName": "2.0.2",
  "size": $SIZE,
  "sha256": "$SHA",
  "builtAt": "2026-09-20 07:51:36 CST",
  "file": "app-release.apk",
  "note": "2.0.2：修闪退/黄屏根因 + 启动看门狗；当前书全站上线（26 个面板可切书）；弹层白边/圆角修复；UI 规范"
}
EOF
echo "  版本文件已更新"
cat $D/apk-version.json | sed 's/^/    /'
echo
echo "  文件："
ls -la $D/app-release.apk | awk '{printf "    %.1fMB  %s\n",$5/1048576,$6" "$7" "$8}'

echo
echo "=== 重启服务读新版本 ==="
systemctl --user restart nbapp.service 2>/dev/null && echo "  已重启"
sleep 4
systemctl --user is-active nbapp.service | sed 's/^/  服务: /'

echo
echo "=== 线上接口现在报什么 ==="
curl -s -m 10 http://127.0.0.1:8890/api/apk/version 2>/dev/null | head -c 300
echo
echo
echo "=== 公网下载口 ==="
curl -s -m 25 -o /tmp/dl.apk -w "  http=%{http_code}  大小=%{size_download}B\n" http://<你的服务器地址>/nbapp/apk
echo "  下载到的包 sha256: $(sha256sum /tmp/dl.apk 2>/dev/null | cut -c1-32)..."
echo "  本地新包   sha256: $(echo $SHA | cut -c1-32)..."
