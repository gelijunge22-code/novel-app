#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后端 287 个接口里，哪些在前端"没出现过"？ —— 粗匹配，用来找"后端有、用户点不到"的候选。

⚠️ 这是**粗匹配**（按路径最后两段在前端源码里找字符串），会有误判：
   · 前端拼地址（前缀 + 片段）的，可能被漏或误报；
   · Java 那边调的（如 /health）本来就该"前端没有"；
所以输出是**候选名单**，要逐条核。用法：python3 tools/iface_account.py
"""
import io, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> int:
    paths = []
    for f in sorted((ROOT / 'server/routers').glob('*.py')):
        src = f.read_text(encoding='utf-8')
        for m in re.finditer(r'@router\.(get|post|put|delete|patch)\("([^"]+)"', src):
            paths.append((m.group(1).upper(), m.group(2)))
    paths = sorted(set(paths), key=lambda x: x[1])
    fe = ' '.join(p.read_text(encoding='utf-8') for p in (ROOT / 'frontend/js').glob('*.js'))
    fe += ' ' + (ROOT / 'frontend/index.html').read_text(encoding='utf-8')
    missing = []
    for meth, p in paths:
        parts = [x for x in p.strip('/').split('/') if x and not x.startswith('{')]
        frag = '/'.join(parts[-2:]) if len(parts) >= 2 else p.strip('/')
        if frag and frag in fe:
            continue
        missing.append((meth, p))
    print(f'接口总数 {len(paths)}，前端没直接出现过的 {len(missing)}（粗匹配，需逐条核）')
    for meth, p in missing:
        print('  ', meth, p)
    out = ROOT / 'docs/接口未露面候选.json'
    out.write_text(json.dumps(
        {'total': len(paths), 'missing': len(missing),
         'items': [{'method': m, 'path': p} for m, p in missing],
         'note': '粗匹配：按"路径最后两段"在前端源码里找字符串，会有误判，需逐条核'},
        ensure_ascii=False, indent=2), encoding='utf-8')
    print('报告：' + str(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
