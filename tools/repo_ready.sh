#!/bin/bash
# 仓库就绪检查 + 提交（推送等用户给令牌后再做）
cd /home/ubuntu/novel-app
git add -A >/dev/null 2>&1
git -c user.email=hermes@local -c user.name=hermes commit -q -m "仓库就绪：README（方案总览）+ docs/安装说明（装机/升级/构建/部署）" 2>/dev/null && echo "已提交新文件" || echo "没有新变更"
echo
echo "=== 仓库现状 ==="
echo "  提交数: $(git rev-list --count HEAD)"
echo "  跟踪文件: $(git ls-files | wc -l)"
echo "  分支: $(git branch --show-current)"
echo
echo "=== 确认敏感文件不在版本控制里 ==="
for p in data/ apk/keystore.jks server/config.json logs/ apk/*.apk; do
  n=$(git ls-files | grep -c "^$p" 2>/dev/null || echo 0)
  printf "  %-22s 被跟踪: %s\n" "$p" "$n"
done
echo
echo "=== 顶层文件清单 ==="
ls -1
