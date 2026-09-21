#!/usr/bin/env python3
"""Goal Mode 驱动器 v2：支持「收件箱」——监督人写文件，驱动器注入到 Codex 会话。

用法:
  1) 驱动:  python3 goal_driver.py
  2) 投递:  echo '要跟它说的话' >> logs/inbox.txt
     (驱动器发现新内容后，用 turn/start 注入到同一个线程)

关键修复: 之前用 `codex queue` 投递是**无效的**——驱动用的是私有 app-server，
queue 连的是另一个实例，消息全部丢失。现在改成驱动器自己读文件、自己注入。
"""
import json, os, subprocess, sys, threading, time, datetime

ROOT = '/home/ubuntu/novel-app'
LOG = os.path.join(ROOT, 'logs', 'codex-goal.log')
STATE = os.path.join(ROOT, 'logs', 'goal-state.json')
INBOX = os.path.join(ROOT, 'logs', 'inbox.txt')
OFFSET = os.path.join(ROOT, 'logs', 'inbox.offset')
KICKOFF = os.path.join(ROOT, 'docs', 'KICKOFF.md')

OBJECTIVE = ("把 /home/ubuntu/novel-app 做成一个属于我们自己的完整小说 App："
             "后端完全自研、前端沿用并扩展、最后前后端一起装进安卓 App（断网全功能可用）。"
             "逐条完成 GOAL.md 与 docs/08、docs/11 全部任务，每轮在 docs/进度.md 留实测证据，"
             "全部完成后写 DONE.md。")

os.makedirs(os.path.dirname(LOG), exist_ok=True)
logf = open(LOG, 'a', buffering=1, encoding='utf-8')

def log(*a):
    line = '[%s] %s' % (datetime.datetime.now().strftime('%H:%M:%S'), ' '.join(str(x) for x in a))
    print(line, flush=True); logf.write(line + '\n')

def save_state(d):
    try: json.dump(d, open(STATE, 'w'), ensure_ascii=False, indent=1)
    except Exception: pass

log('=== 驱动器 v2 启动（含收件箱）===')
proc = subprocess.Popen(['codex', 'app-server'], cwd=ROOT, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
log('app-server pid =', proc.pid)

_id = [0]; _lock = threading.Lock(); _pending = {}
turn_active = [False]
# 2026-09-21 修：记录"最后一轮什么时候结束的"。
#   原来驱动器只在目标变 blocked 时才推它 —— 但如果一轮正常跑完、目标还是 active，
#   就没人再发起新一轮 → 实测空转了 46 分钟（16:02:46 turn/completed 之后一直没人叫它）。
#   以前这个洞被"每 2.5 分钟重启一次"掩盖了（重启会顺手推一把），重启修好后就暴露了。
last_turn_end = [time.time()]
tid_box = [None]

def send(method, params=None):
    with _lock:
        _id[0] += 1; i = _id[0]
    try:
        proc.stdin.write(json.dumps({'id': i, 'method': method, 'params': params or {}}) + '\n')
        proc.stdin.flush()
    except Exception as e:
        log('!! 发送失败', method, e)
    return i

def wait_for(i, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if i in _pending: return _pending.pop(i)
        time.sleep(0.15)
    return None

def _budget():
    """0 或空 = 不设上限（传 null）。用户明确要求：不设 token 预算，想做多久做多久。"""
    v = os.environ.get('GOAL_TOKEN_BUDGET', '').strip()
    try:
        n = int(v)
    except Exception:
        return None
    return n if n > 0 else None


def call(method, params=None, timeout=180):
    i = send(method, params)
    r = wait_for(i, timeout)
    if r is None: log('!! 超时', method)
    elif r.get('error'): log('!! 错误', method, json.dumps(r['error'], ensure_ascii=False)[:300])
    return r

def reader():
    for line in proc.stdout:
        line = line.strip()
        if not line: continue
        try: m = json.loads(line)
        except Exception:
            log('raw:', line[:300]); continue
        if 'id' in m and 'method' not in m:
            _pending[m['id']] = m; continue
        meth = m.get('method')
        if not meth: continue
        if meth in ('item/agentMessage/delta', 'item/reasoning/textDelta',
                    'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta'):
            continue
        p = m.get('params') or {}
        if meth == 'turn/completed':
            turn_active[0] = False
            last_turn_end[0] = time.time()   # ← 空闲看门狗用（见主循环）
            log('<-- turn/completed')
        elif meth == 'turn/started':
            turn_active[0] = True
        elif meth == 'thread/goal/updated':
            save_state({'threadId': tid_box[0], 'goal': p.get('goal') or p})
            log('<-- goal/updated status=', (p.get('goal') or {}).get('status'))
        elif meth in ('item/started', 'item/completed'):
            it = p.get('item') or {}
            t = it.get('type')
            if t == 'commandExecution':
                log('<-- cmd:', (it.get('command') or '')[:220])
            elif t == 'agentMessage' and meth == 'item/completed':
                log('<-- 它说:', (it.get('text') or '')[:400])
        else:
            log('<--', meth)
threading.Thread(target=reader, daemon=True).start()
time.sleep(1.5)

call('initialize', {'clientInfo': {'name': 'goal-driver', 'title': 'Goal Driver', 'version': '2.0.0'}})

# —— 恢复已有线程（不丢上下文），没有才新建 ——
tid = None
if os.path.exists(STATE):
    try: tid = json.load(open(STATE)).get('threadId')
    except Exception: pass
if tid:
    # 关键：resume 必须一并带上 model / modelProvider。
    # 不带的话线程会沿用创建时的旧通道——换模型后它还在被限流，白换。
    _m = os.environ.get('CODEX_MODEL', '某模型')
    _p = os.environ.get('CODEX_PROVIDER', 'comm')
    r = call('thread/resume', {'threadId': tid, 'cwd': ROOT, 'approvalPolicy': 'never',
                               'sandbox': 'danger-full-access',
                               'model': _m, 'modelProvider': _p})
    log('恢复时指定模型: %s @ %s' % (_m, _p))
    if not (r and r.get('result')):
        log('恢复失败，改新建'); tid = None
    else:
        log('已恢复线程', tid)
        # 目标可能是 blocked（例如模型欠费/接口挂了导致），必须重新激活，
        # 否则恢复回来也是个死目标，永远不动。
        g = call('thread/goal/get', {'threadId': tid}, timeout=30)
        st = None
        if g and g.get('result'):
            gg = g['result'].get('goal') or g['result']
            st = gg.get('status')
        # 总是重新对齐目标：确保预算是最新的（None=无上限）且状态为 active
        log('对齐目标（当前状态 %s，预算 %s）' % (st, _budget()))
        call('thread/goal/set', {'threadId': tid, 'objective': OBJECTIVE,
                                 'status': 'active', 'tokenBudget': _budget()})
        if st and st not in ('active', 'paused'):
            log('目标原为 %s，已重新激活并推一把' % st)
            call('turn/start', {'threadId': tid, 'input': [{'type': 'text',
                 'text': '【系统】你的目标之前因为模型通道问题被中断了。现已切到新模型通道。请接着上次没做完的地方继续，不要重头再来，先在 docs/进度.md 补一句说明。'}]})
if not tid:
    r = call('thread/start', {'cwd': ROOT, 'model': os.environ.get('CODEX_MODEL', '某模型'),
                              'modelProvider': os.environ.get('CODEX_PROVIDER', 'go'),
                              'approvalPolicy': 'never', 'sandbox': 'danger-full-access',
                              'baseInstructions': ''})
    if r and r.get('result'):
        tid = (r['result'].get('thread') or {}).get('id')
    if not tid:
        log('!! 拿不到线程 id'); sys.exit(1)
    call('thread/goal/set', {'threadId': tid, 'objective': OBJECTIVE,
                             'tokenBudget': int(os.environ.get('GOAL_TOKEN_BUDGET', '200000000'))})
    kick = open(KICKOFF, 'rb').read().decode('utf-8', 'ignore')
    call('turn/start', {'threadId': tid, 'input': [{'type': 'text', 'text': kick}]})
    log('新建线程并发出首轮')
tid_box[0] = tid
save_state({'threadId': tid, 'objective': OBJECTIVE,
            'startedAt': datetime.datetime.now().isoformat()})

# —— 收件箱：监督人写 logs/inbox.txt，驱动器注入 ——
def inbox_loop():
    pos = 0
    if os.path.exists(OFFSET):
        try: pos = int(open(OFFSET).read().strip() or 0)
        except Exception: pos = 0
    log('收件箱监视中（已有偏移 %d）' % pos)
    while True:
        time.sleep(8)
        if not os.path.exists(INBOX): continue
        try:
            size = os.path.getsize(INBOX)
            if size <= pos: continue
            with open(INBOX, 'r', encoding='utf-8') as f:
                f.seek(pos); chunk = f.read()
        except Exception as e:
            log('!! 读收件箱失败', e); continue
        if not chunk.strip():
            pos = size
            try: open(OFFSET, 'w').write(str(pos))
            except Exception: pass
            continue
        # Goal Mode 的"轮"可能几小时都不结束，不能干等；最多等 60 秒就注入
        waited = 0
        while turn_active[0] and waited < 60:
            time.sleep(10); waited += 10
        log('==> 注入监督人指令（%d 字）' % len(chunk))
        # ⚠ 偏移量必须在【注入成功之后】才推进。
        #   2026-09-20 踩过：原来先推进偏移再注入，驱动器中途重启 →
        #   消息被标成"已读"却没送进去 → 永久丢失（监督人的指令就这么丢过一条）。
        try:
            call('turn/start', {'threadId': tid_box[0],
                                'input': [{'type': 'text', 'text': '[监督人插话]\n' + chunk}]})
            pos = size
            open(OFFSET, 'w').write(str(pos))
        except Exception as e:
            log('!! 注入失败，偏移量不推进，下轮重试：', e)
threading.Thread(target=inbox_loop, daemon=True).start()

BLOCKED_TRIES = 0
IDLE_KICKS = 0
while True:
    time.sleep(30)
    if proc.poll() is not None:
        log('!! app-server 退出，码 =', proc.returncode); break
    r = call('thread/goal/get', {'threadId': tid_box[0]}, timeout=30)
    if r and r.get('result'):
        g = r['result']; st = (g.get('goal') or {}).get('status') or g.get('status')
        # ⚠ 2026-09-21 修（重要）：原来这里是「非 active/paused 就 break」，
        #   于是目标一变 blocked，驱动器就退出 → systemd(Restart=always) 10 秒后又拉起来
        #   → 又 blocked → 又退出……**实测每 2.5 分钟一轮，restart counter 打到了 150**。
        #   后果：Codex 正在跑的活（测试 / 提交 / 打包）**每 2.5 分钟被腰斩一次**，
        #   稍长的步骤永远做不完（用户看到的"3 小时什么都没提交"就是这个）。
        #   现在改成：只有**真正结束**的状态才退出；blocked 之类一律**原地重新激活**，绝不退出。
        if st in ('complete', 'completed', 'done', 'cancelled', 'canceled', 'failed', 'stopped'):
            log('目标状态 =', st, ' -> 真正收工'); break
        if st and st not in ('active', 'paused'):
            BLOCKED_TRIES += 1
            log('目标状态 = %s（第 %d 次）-> 原地重新激活，不退出' % (st, BLOCKED_TRIES))
            try:
                call('thread/goal/set', {'threadId': tid_box[0], 'objective': OBJECTIVE,
                                         'status': 'active', 'tokenBudget': _budget()})
                call('turn/start', {'threadId': tid_box[0], 'input': [{'type': 'text',
                     'text': '【系统】目标刚才变成 %s，已被**原地重新激活**（驱动器没有重启，你的线程和上下文都在）。'
                             '请接着上次没做完的地方继续，不要重头再来。' % st}]})
            except Exception as e:
                log('!! 原地重新激活失败（不退出，下一轮再试）：', e)
        else:
            BLOCKED_TRIES = 0
            # ⚠ 2026-09-21 修（关键）：目标 active、**没有正在跑的轮次**、且**空闲超过 3 分钟**
            #   → 说明"一轮跑完了，但没人再发起新一轮"，必须**主动推一把**。
            #   （实测：16:02:46 turn/completed 之后，驱动器只是干轮询，空转了 46 分钟什么都没干。）
            if not turn_active[0]:
                idle = time.time() - last_turn_end[0]
                if idle > 180:
                    IDLE_KICKS += 1
                    log('空闲 %d 秒 + 没有正在跑的轮次 -> 主动推一把（第 %d 次）' % (int(idle), IDLE_KICKS))
                    try:
                        call('turn/start', {'threadId': tid_box[0], 'input': [{'type': 'text',
                             'text': '【系统·空闲唤醒】上一轮已经结束、你还在等着。请**接着上次没做完的地方继续**'
                                     '（先看一眼 docs/进度.md 顶部和你的待办），不要重头再来。'}]})
                        last_turn_end[0] = time.time()
                    except Exception as e:
                        log('!! 空闲唤醒失败（下一轮再试）：', e)
log('=== 驱动器结束 ===')
