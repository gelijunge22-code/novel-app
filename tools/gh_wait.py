#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""等用户授权 → 拿令牌 → 建仓库 → 推代码 → 打印链接"""
import json, time, os, subprocess, urllib.request, urllib.parse, urllib.error, sys

CLIENT_ID = "178c6fc778ccc68e1d6a"
d = json.load(open('/tmp/gh_device.json'))
DEVICE_CODE = d['device_code']
INTERVAL = d.get('interval', 5)
REPO = "novel-app"

def post(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Accept": "application/json",
                                          "User-Agent": "novel-app-setup"})
    proxy = urllib.request.ProxyHandler({
        "http": "http://本地代理", "https": "http://本地代理"})
    op = urllib.request.build_opener(proxy)
    with op.open(req, timeout=40) as r:
        return json.loads(r.read().decode())

def api(url, method="GET", token=None, payload=None):
    body = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Accept": "application/vnd.github+json",
                                          "User-Agent": "novel-app-setup",
                                          "Authorization": "Bearer " + token})
    proxy = urllib.request.ProxyHandler({
        "http": "http://本地代理", "https": "http://本地代理"})
    op = urllib.request.build_opener(proxy)
    try:
        with op.open(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

print("=== 等你在手机上输入授权码（最多 15 分钟）===", flush=True)
deadline = time.time() + 880
token = None
while time.time() < deadline:
    try:
        r = post("https://github.com/login/oauth/access_token",
                 {"client_id": CLIENT_ID, "device_code": DEVICE_CODE,
                  "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
    except Exception as e:
        print("  网络重试:", e, flush=True); time.sleep(INTERVAL); continue
    if r.get("access_token"):
        token = r["access_token"]; break
    err = r.get("error")
    if err == "authorization_pending":
        pass
    elif err == "slow_down":
        INTERVAL += 5
    elif err == "expired_token":
        print("❌ 授权码过期了，得重新申请", flush=True); sys.exit(1)
    elif err == "access_denied":
        print("❌ 你点了拒绝", flush=True); sys.exit(1)
    else:
        print("  状态:", r, flush=True)
    time.sleep(INTERVAL)

if not token:
    print("❌ 超时没等到授权", flush=True); sys.exit(1)

print("✅ 拿到令牌了！长度", len(token), flush=True)
# 存起来（权限 600）
env = '/home/ubuntu/.hermes/.env'
lines = [l for l in open(env, encoding='utf-8').read().splitlines()
         if not l.startswith('GITHUB_TOKEN=')] if os.path.exists(env) else []
lines.append('GITHUB_TOKEN=' + token)
open(env, 'w', encoding='utf-8').write("\n".join(lines) + "\n")
os.chmod(env, 0o600)
print("   已存到", env, flush=True)

# 看是谁
st, me = api("https://api.github.com/user", token=token)
login = me.get('login', '?')
print("   登录账号:", login, flush=True)

# 建仓库
st, repo = api("https://api.github.com/user/repos", "POST", token,
               {"name": REPO, "description": "小说写作台 · 自研后端 + 定制前端 + 安卓壳",
                "private": False, "auto_init": False})
if st == 201:
    print("✅ 仓库已建:", repo['html_url'], flush=True)
elif st == 422:
    print("   仓库已存在，直接用", flush=True)
    st2, repo = api("https://api.github.com/repos/%s/%s" % (login, REPO), token=token)
    print("   地址:", repo.get('html_url'), flush=True)
else:
    print("❌ 建仓库失败:", st, repo, flush=True); sys.exit(1)

url = repo['html_url']
clone = repo['clone_url'].replace('https://', 'https://%s:%s@' % (login, token))

# 配置并推送
cmds = [
    ["git", "config", "user.email", "hermes@local"],
    ["git", "config", "user.name", "hermes"],
    ["git", "remote", "remove", "origin"],
    ["git", "remote", "add", "origin", clone],
    ["git", "branch", "-M", "main"],
    ["git", "push", "-u", "origin", "main", "--force"],
]
for c in cmds[2:2] + cmds:
    p = subprocess.run(c, cwd='/home/ubuntu/novel-app',
                       capture_output=True, text=True)
    tag = " ".join(c[:3])
    if p.returncode != 0 and 'remove' not in c:
        print("  ⚠️ %s → %s" % (tag, (p.stderr or p.stdout).strip()[:200]), flush=True)
    else:
        print("  ✓ %s" % tag, flush=True)

print("\n★ 仓库地址:", url, flush=True)
open('/tmp/gh_repo_url.txt', 'w').write(url + "\n")
