#!/usr/bin/env bash
# 监督人亲验：自定义背景 能不能真的换、能不能真的移除
cd /home/ubuntu/novel-app
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null)
TOK=$(curl -s -X POST "http://127.0.0.1:8899/api/app/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
B=http://127.0.0.1:8899
SLUG=example-book

echo "═══ 0. 先看现在状态 + 目录里有几个文件 ═══"
curl -s "$B/api/appearance/bg?slug=$SLUG&token=$TOK" | head -c 300; echo
echo "  目录文件数: $(ls data/appearance/ 2>/dev/null | wc -l)"
ls data/appearance/ 2>/dev/null | sed 's/^/     /'

echo
echo "═══ 1. 造一张明显的测试图（纯色+文字）作背景 ═══"
python3 -c "
from PIL import Image, ImageDraw
im = Image.new('RGB', (900, 1600), (30, 90, 160))     # 蓝色底
d = ImageDraw.Draw(im)
for y in range(0, 1600, 120): d.line([(0,y),(900,y)], fill=(255,220,80), width=8)
im.save('/tmp/bgtest.png')
print('  造好 /tmp/bgtest.png  900x1600')
"
ls -la /tmp/bgtest.png | awk '{print "  大小:", $5, "字节"}'

echo
echo "═══ 2. 上传（走前端同一条路）═══"
for scope in global; do
  code=$(curl -s -o /tmp/up.json -w "%{http_code}" -X POST "$B/api/appearance/bg?scope=$scope&slug=$SLUG&token=$TOK" \
    -H "x-token: $TOK" -F "file=@/tmp/bgtest.png" 2>/dev/null)
  echo "  POST scope=$scope → HTTP $code"
  head -c 250 /tmp/up.json | sed 's/^/     /'; echo
done

echo
echo "═══ 3. 传完再看状态（has 应该 = true）═══"
curl -s "$B/api/appearance/bg?slug=$SLUG&token=$TOK" | head -c 300; echo
echo "  目录文件数: $(ls data/appearance/ 2>/dev/null | wc -l)"

echo
echo "═══ 4. 取背景图本身（前端就是这么显示的）═══"
curl -s -o /tmp/bgget.bin -w "  GET bg/file → HTTP %{http_code}  %{size_download}B  %{content_type}\n" "$B/api/appearance/bg/file?scope=global&slug=$SLUG&token=$TOK"

echo
echo "═══ 5. 移除（还原用户原来的状态 = 没有背景）═══"
code=$(curl -s -o /tmp/del.json -w "%{http_code}" -X POST "$B/api/appearance/bg/clear?scope=global&slug=$SLUG&token=$TOK" -H "x-token: $TOK" 2>/dev/null)
echo "  POST bg/clear → HTTP $code"; head -c 200 /tmp/del.json | sed 's/^/     /'; echo
curl -s "$B/api/appearance/bg?slug=$SLUG&token=$TOK" | head -c 300; echo
echo "  目录文件数: $(ls data/appearance/ 2>/dev/null | wc -l)"
ls data/appearance/ 2>/dev/null | sed 's/^/     /'
