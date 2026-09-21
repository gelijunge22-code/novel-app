import json, re
p = '/home/ubuntu/.codex/sessions/2026/09/19/rollout-2026-09-19T13-45-19-01a0b832-9d5e-7362-8328-53a3ac726e69.jsonl'
cmds, msgs, patches = [], [], []
for line in open(p, encoding='utf-8', errors='ignore'):
    try:
        d = json.loads(line)
    except Exception:
        continue
    pl = d.get('payload') or {}
    t = pl.get('type') or d.get('type')
    # 命令
    if t in ('function_call', 'local_shell_call'):
        a = pl.get('arguments') or pl.get('action') or {}
        if isinstance(a, str):
            try: a = json.loads(a)
            except Exception: a = {'raw': a}
        c = a.get('command') or a.get('cmd') or a.get('raw')
        if c: cmds.append((' '.join(c) if isinstance(c, list) else str(c)))
    elif t == 'exec_command_begin':
        c = pl.get('command')
        if c: cmds.append(' '.join(c) if isinstance(c, list) else str(c))
    # 助手消息
    if t == 'agent_message' or (t == 'message' and pl.get('role') == 'assistant'):
        txt = pl.get('message') or ''
        if isinstance(txt, list): txt = ' '.join(str(x) for x in txt)
        if txt: msgs.append(txt)
    # 文件改动
    if t in ('patch_apply_begin', 'apply_patch'):
        ch = pl.get('changes') or {}
        for k in (ch.keys() if isinstance(ch, dict) else []):
            patches.append(k)

print("命令总数:", len(cmds))
print("\n=== 最后 18 条命令 ===")
for c in cmds[-18:]:
    print("  •", re.sub(r'\s+', ' ', c)[:180])
print("\n=== 最后改动的文件（最近 20 个）===")
for f in patches[-20:]:
    print("  -", f)
print("\n=== 最后 3 条助手发言 ===")
for m in msgs[-3:]:
    print("---")
    print(re.sub(r'\s+', ' ', m)[:1200])
