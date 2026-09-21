#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 参考书架：支持什么输入 ═══"
grep -nE "refs|参考书架" frontend/js/studio.js | head -8
echo "  上传/图片相关:"
grep -nE "type=\"file\"|accept=|input.*file|上传|选择文件|image" frontend/js/studio.js | head -10
echo
echo "═══ 2. 切书条的样子（是不是太显眼） ═══"
grep -rnE "bookctx|book-bar|bookbar|当前书" frontend/css/*.css | head -8
echo
grep -rnE "bookctx" frontend/js/*.js frontend/index.html | head -8
echo
echo "═══ 3. 工具面板的退出/返回逻辑 ═══"
grep -nE "pushOverlay|popOverlay|push\(|pop\(|返回" frontend/js/tools.js | head -14
echo
echo "═══ 4. TTS 接口状态 ═══"
grep -nE "tts|voice|speak" frontend/js/studio.js | head -8
echo
echo "  服务器 TTS 接口:"
curl -s -m 10 -o /dev/null -w "    /api/tts  http=%{http_code}\n" http://127.0.0.1:8899/api/tts
curl -s -m 10 http://127.0.0.1:8899/api/tts/voices 2>/dev/null | head -c 200
echo
echo "  听书面板用的哪个接口:"
grep -rnE "/api/tts|tts/segments|tts/voices" frontend/js/*.js | head -6
echo
echo "═══ 5. 服务器上有 TTS 依赖吗 ═══"
python3 -c "
import importlib
for m in ('edge_tts','azure.cognitiveservices.speech','pyttsx3'):
    try:
        importlib.import_module(m); print('  ✅',m)
    except Exception as e: print('  ❌',m)
" 2>&1 | head -5
