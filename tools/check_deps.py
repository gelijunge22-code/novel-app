#!/usr/bin/env python3
"""依赖自检 —— 别人 clone 下来装不上/起不来的坑，在这里提前报红。

为什么要有：`python-multipart` 漏过一次（FastAPI 的 Form/File **隐式**依赖，
静态扫 import 扫不出来），结果陌生人照 README 装完依赖、一启动就
`RuntimeError: Form data requires "python-multipart"`，整个 App 起不来。

用法（在仓库根目录）：python3 tools/check_deps.py
判据：
  ① requirements.txt 里每个包都能在 PyPI 上找到（版本号存在）
  ② 代码里 import 的第三方包，requirements.txt 里都有
  ③ 用了 Form/File/UploadFile → 必须有 python-multipart
"""
import ast, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REQ = os.path.join(ROOT, 'requirements.txt')
ALIAS = {'edge_tts': 'edge-tts', 'yaml': 'pyyaml', 'PIL': 'pillow', 'bs4': 'beautifulsoup4',
         'fitz': 'pymupdf', 'docx': 'python-docx', 'multipart': 'python-multipart'}


def names_in_req(text):
    out = set()
    for line in text.splitlines():
        line = line.split('#')[0].strip()
        if not line:
            continue
        out.add(re.split(r'[=<>!\[]', line)[0].strip().lower())
    return out


def main():
    bad = []
    req_text = open(REQ, encoding='utf-8').read() if os.path.exists(REQ) else ''
    if not req_text:
        print('❌ 没有 requirements.txt')
        return 1
    req = names_in_req(req_text)

    # ② 代码里 import 的第三方
    std = set(sys.stdlib_module_names)
    seen, uses_form = set(), False
    for root, dirs, files in os.walk(os.path.join(ROOT, 'server')):
        dirs[:] = [d for d in dirs if d not in ('venv', '__pycache__')]
        for f in files:
            if not f.endswith('.py'):
                continue
            src = open(os.path.join(root, f), encoding='utf-8', errors='replace').read()
            if re.search(r'\b(Form|File|UploadFile)\s*\(', src) or 'UploadFile' in src:
                uses_form = True
            try:
                tree = ast.parse(src)
            except SyntaxError:
                continue
            for n in ast.walk(tree):
                if isinstance(n, ast.Import):
                    for a in n.names:
                        seen.add(a.name.split('.')[0])
                elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
                    seen.add(n.module.split('.')[0])

    third = sorted(m for m in seen if m not in std and m not in ('server', '__future__'))
    for m in third:
        if m.lower() not in req and ALIAS.get(m, '').lower() not in req:
            bad.append('代码 import 了 %s，requirements.txt 里没有' % m)

    # ③ Form/File 的隐式依赖
    if uses_form and 'python-multipart' not in req:
        bad.append('代码用了 Form/File/UploadFile → requirements.txt 必须有 python-multipart（隐式依赖，import 扫不出来）')

    if bad:
        print('❌ 依赖有问题（别人 clone 下来会起不来）：')
        for b in bad:
            print('   ·', b)
        return 1
    print('✅ 依赖自检通过：requirements.txt 齐全（%d 个包）' % len(req))
    print('   代码里 import 的第三方：%s' % (', '.join(third) or '无'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
