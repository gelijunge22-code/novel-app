#!/bin/bash
# 把 2.0 修复版放到线上下载口，手机浏览器可直下
set -e
SRC=/home/ubuntu/novel-app/apk/手机写作台.apk
DST=/home/ubuntu/nbapp/apk
cd $DST
# 备份旧的（不动数据，只是保底）
[ -f 手机写作台.apk ] && cp -f 手机写作台.apk 备份-1.3-$(date +%H%M).apk 2>/dev/null || true
cp -f "$SRC" $DST/手机写作台.apk
cp -f "$SRC" $DST/app-release.apk
# 版本清单（服务器据此报"有新版本"）
python3 - <<'PY'
import json, hashlib, pathlib, datetime
p = pathlib.Path('/home/ubuntu/nbapp/apk/手机写作台.apk')
d = {
  "versionCode": 20,
  "versionName": "2.0",
  "size": p.stat().st_size,
  "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
  "builtAt": datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S CST'),
  "file": "手机写作台.apk",
  "note": "自研后端版：前端+后端+Python 运行时全在包内，可断网使用",
}
pathlib.Path('/home/ubuntu/nbapp/apk/apk-version.json').write_text(
    json.dumps(d, ensure_ascii=False, indent=1), encoding='utf-8')
print("版本清单已更新:", d['versionName'], d['versionCode'], round(d['size']/1048576,1), "MB")
PY
echo
echo "=== 线上核对 ==="
curl -s -m 20 http://127.0.0.1:8890/api/apk/version | head -c 260; echo
curl -s -m 30 -o /dev/null -w "  手机下载口 http=%{http_code} 大小=%{size_download}B\n" http://<你的服务器地址>/nbapp/apk
echo
echo "=== 下载下来的包是不是就是 2.0 修复版 ==="
curl -s -m 60 http://<你的服务器地址>/nbapp/apk -o /tmp/dl.apk
sha256sum /tmp/dl.apk | cut -c1-40 | sed 's/^/  下载到: /'
sha256sum $SRC | cut -c1-40 | sed 's/^/  源文件: /'
