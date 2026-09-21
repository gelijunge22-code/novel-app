#!/bin/bash
cd /home/ubuntu/novel-app
BT=/home/ubuntu/android-sdk/build-tools/34.0.0
A=apk/手机写作台.apk
echo "=== 1. 包信息 ==="
ls -la "$A" | awk '{printf "  %s  %.1fMB  %s\n",$9,$5/1048576,$6" "$7" "$8}'
echo "  sha256: $(sha256sum "$A" | cut -c1-32)..."
python3 -c "
import json
d=json.load(open('apk/apk-version.json'))
print('  声明: v%s (code %s)  %s' % (d['versionName'], d['versionCode'], d['builtAt']))
" 2>/dev/null

echo
echo "=== 2. 签名指纹（必须和以前一致才能覆盖装） ==="
if [ -x "$BT/apksigner" ]; then
  "$BT/apksigner" verify --print-certs "$A" 2>/dev/null | grep -iE "SHA-256 digest|signer #1 certificate" | head -4 | sed 's/^/  /'
else
  echo "  找不到 apksigner: $BT/apksigner"
fi

echo
echo "=== 3. 包里的版本号（从包里读回来） ==="
"$BT/aapt2" dump badging "$A" 2>/dev/null | grep -E "^package" | sed 's/^/  /' || \
  unzip -p "$A" AndroidManifest.xml 2>/dev/null | strings | grep -E "^2\.[0-9]" | head -3 | sed 's/^/  /'

echo
echo "=== 4. 后端进包了吗 ==="
echo "  前端文件: $(unzip -l "$A" 2>/dev/null | grep -c 'assets/www/')"
echo "  后端 py:  $(unzip -l "$A" 2>/dev/null | grep -cE '\.py$|\.imy$|python')"
echo "  Python运行时: $(unzip -l "$A" 2>/dev/null | grep -c 'libpython')"

echo
echo "=== 5. 复制一份到桌面（好拿） ==="
cp -f "$A" "/home/ubuntu/写作台-2.0.2.apk" && echo "  ✅ /home/ubuntu/写作台-2.0.2.apk"
ls -la /home/ubuntu/写作台-2.0.2.apk | awk '{printf "  %.1fMB\n",$5/1048576}'
