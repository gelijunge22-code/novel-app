#!/bin/bash
cd /tmp
echo "=== 走代理下载 Chrome 官方 deb ==="
curl -sL -m 240 -x http://本地代理 -o chrome.deb \
  https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  -w "  http=%{http_code}  大小=%{size_download}B  用时=%{time_total}s\n"
ls -la chrome.deb 2>/dev/null | awk '{print "  文件:",$5,"字节"}'
file chrome.deb 2>/dev/null | cut -c1-80
echo
echo "=== 安装 ==="
sudo dpkg -i chrome.deb 2>&1 | tail -5
sudo apt-get install -f -y -q 2>&1 | tail -3
echo
echo "=== 验证 ==="
which google-chrome google-chrome-stable 2>/dev/null
google-chrome --version 2>/dev/null || google-chrome-stable --version 2>/dev/null
