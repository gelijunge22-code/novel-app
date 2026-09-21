#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub 设备码授权：申请一段短码，用户在手机上输入后，我这边拿令牌。"""
import json, urllib.request, urllib.parse, time, sys

CLIENT_ID = "178c6fc778ccc68e1d6a"          # GitHub CLI 的公开 client_id
SCOPE = "repo"

def post(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Accept": "application/json",
                                          "User-Agent": "novel-app-setup"})
    # 走本机梯子（github 直连不稳定）
    proxy = urllib.request.ProxyHandler({
        "http": "http://本地代理", "https": "http://本地代理"})
    op = urllib.request.build_opener(proxy)
    with op.open(req, timeout=40) as r:
        return json.loads(r.read().decode())

print("=== 申请设备码 ===")
d = post("https://github.com/login/device/code", {"client_id": CLIENT_ID, "scope": SCOPE})
print(json.dumps(d, ensure_ascii=False, indent=1)[:400])
open('/tmp/gh_device.json', 'w').write(json.dumps(d))
print()
print("  ★ 请用户在手机上打开:", d.get("verification_uri"))
print("  ★ 输入这段码:", d.get("user_code"))
print("  ★ 有效期:", d.get("expires_in"), "秒")
