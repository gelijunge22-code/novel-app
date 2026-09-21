import json, re
p = '/home/ubuntu/.codex/sessions/2026/09/19/rollout-2026-09-19T13-45-19-01a0b832-9d5e-7362-8328-53a3ac726e69.jsonl'
msgs = []
for line in open(p, encoding='utf-8', errors='ignore'):
    if '回答监督人' not in line and '监督人的五个问题' not in line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    pl = d.get('payload') or {}
    txt = json.dumps(pl, ensure_ascii=False)
    msgs.append(txt)
print("命中条数:", len(msgs))
for m in msgs[-2:]:
    # 把 \n 还原出来看
    s = m.replace('\\n', '\n')
    i = s.find('回答监督人')
    if i < 0:
        i = 0
    print("=" * 60)
    print(s[max(0, i - 200): i + 4500])
