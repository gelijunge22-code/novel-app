#!/bin/bash
cd /home/ubuntu/novel-app
echo "=== 本地 git 仓库 ==="
git log --oneline 2>/dev/null | head -5
echo "  提交数: $(git rev-list --count HEAD 2>/dev/null)"
echo "  跟踪文件数: $(git ls-files 2>/dev/null | wc -l)"
echo "  分支: $(git branch --show-current 2>/dev/null)"
echo
echo "=== 最大的跟踪文件（看有没有不该进仓库的） ==="
git ls-files -z 2>/dev/null | xargs -0 -I{} sh -c 'test -f "{}" && printf "%s %s\n" "$(stat -c%s "{}")" "{}"' 2>/dev/null | sort -rn | head -10
echo
echo "=== .gitignore 有没有挡住大件 ==="
head -20 .gitignore 2>/dev/null
echo
echo "=== 有没有残留的 chrome 进程 ==="
pgrep -af "gh-login-profile" | head -2 || echo "  已清理"
