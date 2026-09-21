#!/bin/bash
cd /home/ubuntu/novel-app/apk/src/com/nbapp/desk
echo "═══ 1. 启动视图/错误页的颜色（黄屏从哪来） ═══"
grep -nE "0xFFF|0xFFE|Color\.rgb|setBackgroundColor|#F|#E|#D" MainActivity.java | head -12
echo
echo "═══ 2. 启动流程：loadShellFromAssets / dropBootView / localFailed ═══"
grep -nE "private void (dropBootView|loadShellFromAssets|localFailed|showBootView)" MainActivity.java
echo
echo "═══ 3. loadShellFromAssets 怎么加载的（file:// ? loadDataWithBaseURL?） ═══"
grep -n "loadShellFromAssets" -A 22 MainActivity.java | head -30
echo
echo "═══ 4. localFailed 显示什么 ═══"
grep -n "localFailed" -A 18 MainActivity.java | head -24
