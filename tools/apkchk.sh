#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ APK 里打包了前端吗 ═══"
unzip -l apk/手机写作台.apk 2>/dev/null | grep "assets/www" | head -14
echo "  assets/www 文件数: $(unzip -l apk/手机写作台.apk 2>/dev/null | grep -c 'assets/www')"
echo
echo "═══ APK 版本 ═══"
cat apk/apk-version.json 2>/dev/null
echo
echo "═══ 新增面板截图 ═══"
ls docs/前端截图/ | grep "^st-" | head -20
echo
echo "═══ 截图总数 ═══"
ls docs/前端截图/ | wc -l
