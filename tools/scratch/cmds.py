import json, re, collections
p = '/home/ubuntu/novel-app/logs/codex-goal.log'
cmds = []
seen = set()
for line in open(p, encoding='utf-8', errors='ignore'):
    if '"command":' not in line:
        continue
    try:
        m = re.search(r'\{.*\}', line)
        d = json.loads(m.group(0))
    except Exception:
        continue
    it = d.get('item') or {}
    c = it.get('command')
    if not c:
        continue
    if c in seen:
        continue
    seen.add(c)
    cmds.append(c)
print("共执行过 %d 条不同命令。最后 25 条：\n" % len(cmds))
for c in cmds[-25:]:
    c = c.replace('/bin/bash -lc ', '').strip()
    c = re.sub(r'\s+', ' ', c)
    print("  •", c[:185])
