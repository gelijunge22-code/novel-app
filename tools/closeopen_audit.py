#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""closeopen_audit.py — 「面板关完立刻开」这类连写的机器判据

为什么要有它：用户报「点开目录/搜索跟没点一样，闪一下就没了」。查到最后是
    App.closeSheet(); App.sheet(...);        ← 同一拍"先关再开"
旧面板的收尾（history.back() 引出的 popstate 要下一拍才到）把**刚开的新面板**一起关掉，
面板高度变成 0（等于隐形）。同一段代码里 8 个菜单项全是这个写法。

现在规矩：
  · 要换面板就直接 App.sheet(...)（它自己会"就地换内容"）；
  · 要接着弹窗/切屏就 App.closeSheet(() => …)（等收下去再干）；
  · **同一行里 App.closeSheet() 后面不许再跟"开会话面板"的调用**。

判据（两条，都能红）：
  甲  同一行的后继里出现 App.sheet / App.modal / App.confirm / *Sheet( / renameChapter 之类
      → 立刻红（不管基线里有没有）。
  乙  (文件, 后继记号) 这份配对表必须和 docs/面板连写基线.json 一模一样：
      冒出新的 → 红；基线里那些已经不存在了 → 也红（基线过期，等于判据失效）。

跑法：
  server/venv/bin/python tools/closeopen_audit.py            # 检查
  server/venv/bin/python tools/closeopen_audit.py --update   # 改了代码之后重记基线
产出：docs/面板连写实测.json
"""
import io, json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, 'docs', '面板连写基线.json')
OUT = os.path.join(ROOT, 'docs', '面板连写实测.json')

CALL = re.compile(r'App\.close(?:Sheet|Modal)\(\);([ \t]*)(\S.*)$')
# 后继里只要出现这些，就是"马上要开一层新面板" —— 一律不许
SUSPECT = re.compile(r'(App\.(?:sheet|modal|confirm)\b|profileSheet|modelsSetupSheet|'
                     r'modelSheet|sessionsSheet|renameChapter|Shelf\.(?:search|rename|newBook|menu)\b|'
                     r'[A-Za-z_$][\w$]*Sheet\s*\()')
TOKEN = re.compile(r'^(?:await\s+)?([A-Za-z_$][\w$.]*|if|return)\b')

def scan():
    """逐行扫；跳过注释（行注释 + 块注释）。
    为什么非要剥注释：这个仓库的注释里**到处在讲这个坑本身**
    （"别写 App.closeSheet(); App.sheet(...)"），不剥的话判据会把自己注释里的示例当成真代码报红。
    （第一版用状态机连字符串一起剥，栽在 `.replace(/'/g,'')` 这种正则上 —— 引号配平一乱，
      后面整块注释都被当成代码。现在只认注释标记，不碰引号。）"""
    rows = []
    for f in sorted(glob.glob(os.path.join(ROOT, 'frontend', 'js', '*.js'))):
        name = 'frontend/js/' + os.path.basename(f)
        in_block = False
        for i, raw in enumerate(io.open(f, encoding='utf-8').read().split('\n'), 1):
            line = raw
            if in_block:
                if '*/' not in line:
                    continue
                in_block = False
                line = line.split('*/', 1)[1]
            j, cut = 0, None                       # 行注释（'http://x' 里的不算）
            while True:
                j = line.find('//', j)
                if j < 0:
                    break
                if j > 0 and line[j - 1] == ':':
                    j += 2
                    continue
                cut = j
                break
            code = line if cut is None else line[:cut]
            if '/*' in code:
                tail = code.split('/*', 1)[1]
                if '*/' not in tail:
                    in_block = True
                code = code.split('/*', 1)[0]
            m = CALL.search(code)
            if not m:
                continue
            rest = m.group(2)
            t = TOKEN.match(rest)
            rows.append({'file': name, 'line': i, 'follow': t.group(1) if t else rest[:24],
                         'src': raw.strip()[:150], 'suspect': bool(SUSPECT.search(rest))})
    return rows

def main():
    rows = scan()
    fails, notes = [], []
    bad = [r for r in rows if r['suspect']]
    for r in bad:
        fails.append('甲 %s:%d 同一拍"关完立刻开"：%s' % (r['file'], r['line'], r['src']))
    pairs = sorted({(r['file'], r['follow']) for r in rows})
    pairs = [list(p) for p in pairs]
    baseline = None
    if os.path.exists(BASE):
        baseline = json.load(io.open(BASE, encoding='utf-8')).get('pairs')
    if '--update' in sys.argv or baseline is None:
        json.dump({'note': '这些是"关完之后同一行还干别的"的既有写法：切屏/弹 toast/'
                           '提交 promise/纯重绘。判据要求这份表**不许自己变大**。',
                   'pairs': pairs}, io.open(BASE, 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        notes.append('已记基线（%d 对）' % len(pairs))
    else:
        new = [p for p in pairs if p not in baseline]
        gone = [p for p in baseline if p not in pairs]
        if new:
            fails.append('乙 新出现"关完同一行还干别的"的写法（先确认它是不是要开面板）：' + json.dumps(new, ensure_ascii=False))
        if gone:
            fails.append('乙 基线里的这几种写法已经没有了 → 基线过期，跑 --update 重记：' + json.dumps(gone, ensure_ascii=False))
    print('扫了 %d 处 App.closeSheet()/closeModal() 后面还跟着东西的写法，其中"立刻开面板"嫌疑 %d 处'
          % (len(rows), len(bad)))
    for r in rows:
        print(('  %s %s:%d  → %s' % ('✗' if r['suspect'] else '·', r['file'], r['line'], r['src'])))
    for n in notes:
        print('  ' + n)
    doc = {'at': __import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
           'checked': len(rows), 'suspect': len(bad), 'fails': fails}
    json.dump(doc, io.open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if fails:
        print('\n有红 ❌ %d 条' % len(fails))
        for f in fails:
            print('   ' + f)
        sys.exit(1)
    print('\n全过 ✅ → docs/面板连写实测.json')

main()
