import json, re, os
p = '/home/ubuntu/.codex/sessions/2026/09/19/rollout-2026-09-19T13-45-19-01a0b832-9d5e-7362-8328-53a3ac726e69.jsonl'
# 我发过的关键短语（每条 queue 消息里的独有词）
keys = {
    'KICKOFF(第一条)': '你是这个工程的执行 AI',
    '催GOAL.md(第1次)': '你没写 docs/进度.md',
    '深度审查(lint300)': 'AI 味质检太薄',
    '5遍打磨': '第一遍做完 ≠ 做完',
    '真App架构': '目标形态',
    '后端下沉(IndexedDB)': 'local.js',
    '不阉割(路线A/B)': '路线 A',
    '催GOAL.md(第3次)': '第三次催 GOAL.md',
}
found = {k: None for k in keys}
lines = 0
for i, line in enumerate(open(p, encoding='utf-8', errors='ignore')):
    lines = i
    for k, s in keys.items():
        if found[k] is None and s in line:
            found[k] = i
print("会话总行数:", lines)
print()
print("%-24s %s" % ("我的指令", "出现在会话第几行"))
for k in keys:
    print("%-24s %s" % (k, found[k] if found[k] is not None else "❌ 没找到"))
print()
# 看最后 2000 行里有没有 user 消息
tail_users = []
start = max(0, lines-3000)
for i, line in enumerate(open(p, encoding='utf-8', errors='ignore')):
    if i < start: continue
    if '"role": "user"' in line or '"type": "user_message"' in line:
        try: d = json.loads(line)
        except: continue
        pl = d.get('payload') or {}
        txt = json.dumps(pl, ensure_ascii=False)
        tail_users.append((i, re.sub(r'\s+',' ',txt)[:140]))
print("最后 3000 行里的 user 消息数:", len(tail_users))
for i, t in tail_users[-6:]:
    print("  [%d] %s" % (i, t))
