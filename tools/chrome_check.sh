#!/bin/bash
echo "=== 修依赖 ==="
sudo apt-get install -f -y -q 2>&1 | tail -4
echo
echo "=== 版本 ==="
/usr/bin/google-chrome --version
echo
echo "=== 能不能真启动（headless 快速自检） ==="
timeout 30 /usr/bin/google-chrome --headless=new --no-sandbox --disable-gpu \
  --dump-dom about:blank 2>/dev/null | head -2
echo "  退出码: $?"
