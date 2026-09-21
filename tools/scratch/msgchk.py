import json, re, os
p = '/home/ubuntu/.codex/sessions/2026/09/19/rollout-2026-09-19T13-45-19-01a0b832-9d5e-7362-8328-53a3ac726e69.jsonl'
print("会话文件大小: %.1f MB" % (os.path.getsize(p)/1024/1024))
hits = []
for i, line in enumerate(open(p, encoding='utf-8', errors='ignore')):
    if '监督人' not in line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    pl = d.get('payload') or {}
    t = pl.get('type') or d.get('type')
    txt = ''
    if t in ('message', 'user_message'):
        m = pl.get('message') or pl.get('content') or ''
        txt = m if isinstance(m, str) else json.dumps(m, ensure_ascii=False)
    elif t == 'agent_message':
        txt = str(pl.get('message') or '')
    else:
        txt = line
    hits.append((i, t, txt[:160]))
print("\n命中 '监督人' 的行数:", len(hits))
for i, t, txt in hits[:6]:
    print("  [行%d] %s | %s" % (i, t, re.sub(r'\s+',' ',txt)))
print("  ...")
for i, t, txt in hits[-4:]:
    print("  [行%d] %s | %s" % (i, t, re.sub(r'\s+',' ',txt)))
