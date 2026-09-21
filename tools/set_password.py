#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重设 App 登录口令（管理员）。

用法：
  python3 tools/set_password.py                 # 随机生成一个（好念、好打），打印出来
  python3 tools/set_password.py 我的新口令        # 设成指定的
  python3 tools/set_password.py --user admin     # 指定用户（默认 admin）

为什么需要它：下载本仓库的人**第一次启动时口令是随机生成的**（写在 data/initial-password.txt），
忘了或者想换一个就用这个脚本。改完立刻生效，不用重启后端。
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import db as dbm            # noqa: E402
from server.security import hash_password  # noqa: E402
from server.store import P, now_ms      # noqa: E402

# 好念好打的字母表：去掉了容易看错的 0/O/1/l/I
ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def gen_password(n: int = 10) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(n))


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    user = "admin"
    if "--user" in sys.argv:
        i = sys.argv.index("--user")
        if i + 1 < len(sys.argv):
            user = sys.argv[i + 1]
    pw = args[0] if args else gen_password()
    if len(pw) < 6:
        print("口令太短了（至少 6 位）")
        return 2

    dbm.init(P.db)
    d = dbm.db()
    row = d.query("SELECT id FROM user WHERE username=?", (user,))
    if not row:
        print("找不到用户 %r —— 先启动一次后端让账号建出来" % user)
        return 1
    h, salt = hash_password(pw)
    d.execute("UPDATE user SET password_hash=?, salt=?, updated_at=? WHERE username=?",
              (h, salt, now_ms(), user))
    # 顺手把"首次生成的口令文件"更新掉，免得它跟实际不一致
    try:
        f = P.data / "initial-password.txt"
        f.write_text(pw + "\n", encoding="utf-8")
        os.chmod(f, 0o600)
        t = P.data / "口令.txt"          # 中文名，文件管理器里一眼能看到
        t.write_text("App 登录口令：%s\n\n"
                     "(改口令： python3 tools/set_password.py 新口令；\n"
                     " 也能在 App 的「设置」里改)\n" % pw, encoding="utf-8")
        os.chmod(t, 0o600)
    except Exception:
        pass
    # 再往 setting 表记一份 —— 前端「设置 → 关于」要显示它（见 server/routers/core.py）
    try:
        d.execute("DELETE FROM setting WHERE key=?", ("app.password_plain",))
        d.execute("INSERT INTO setting(key, value_json, updated_at) VALUES(?,?,?)",
                  ("app.password_plain", d.jdumps(pw), now_ms()))
    except Exception as e:
        print("   （setting 表没写进去：%s —— 不影响口令本身）" % e)
    print("✅ 已重设 %s 的口令：%s" % (user, pw))
    print("   （现在就能用，不用重启后端；在 App 的「设置」里也能自己再改）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
