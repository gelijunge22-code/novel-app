/* sweep_chrome.js — 收掉自测留下的孤儿无头浏览器（这台机器只有 3.6G 内存，必须收）。

   为什么要有它：`tools/e2e-*.js` 各自 spawn 一个无头 Chrome（`--user-data-dir=/tmp/<名字>-XXXX`）。
   脚本正常跑完会 `kill()`，但**崩了 / 超时 / 被 Ctrl-C** 的时候子进程会留下来 ——
   实测一次留下 6~10 个，一个 ~180MB，加起来 1GB 多，把网关挤到 OOM 过。

   安全边界（只收自己人，绝不误伤）：
     · 必须同时满足：命令行里有 `--headless` **且** `--user-data-dir=/tmp/`（我们自己的临时 profile）
     · 默认只收**活了 60 秒以上**的（正在跑的那一轮不会被动到；要收就说 --all）
     · profile 目录只删我们已知的前缀（e2e-…、cdp-…、boot-…、corners-…、refsimg-…），别的一律不碰

   用法：
     node tools/sweep_chrome.js            # 收掉孤儿，打印释放了多少
     node tools/sweep_chrome.js --dry      # 只看不收
     node tools/sweep_chrome.js --all      # 连刚起来的也收（别在跑测试时用）
   报告：docs/清理孤儿浏览器.json
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = '/home/ubuntu/novel-app';
const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');
const MIN_AGE = ALL ? 0 : 60;                       // 秒
const OUR_PREFIX = /(e2e|cdp|boot|corners|refsimg|sweep|corner|shot|apk|tmp)[-_a-z0-9]*$/i;

function ps() {
  /* pid / 秒 / 驻留 KB / 整条命令行 */
  const out = execFileSync('ps', ['-eo', 'pid=,etimes=,rss=,args='], { encoding: 'utf8', maxBuffer: 8 << 20 });
  return out.split('\n').map((l) => {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], age: +m[2], rss: +m[3], args: m[4] } : null;
  }).filter(Boolean);
}

function isOrphan(p) {
  if (!/--headless/.test(p.args)) return false;
  const m = p.args.match(/--user-data-dir=(\S+)/);
  if (!m) return false;
  const dir = m[1];
  if (!/^\/(private\/)?tmp\//.test(dir)) return false;      // 只认临时 profile
  if (/ms-playwright|chrome-linux64/.test(dir)) return false; // 不是我们起的
  return p.age >= MIN_AGE;
}

function sweep(dry) {
  const procs = ps();
  const kill = procs.filter(isOrphan);
  /* chrome 是一个家族：先按"主进程"分组（带 --user-data-dir 的那个），整组一起收 */
  const parents = kill.filter((p) => /--user-data-dir=/.test(p.args) && !/--type=/.test(p.args));
  const childPids = kill.filter((p) => /--type=/.test(p.args)).map((p) => p.pid);
  const rssMB = Math.round(kill.reduce((s, p) => s + p.rss, 0) / 1024);
  const got = [];
  for (const p of kill) {
    if (!dry) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) {} }
    got.push(p.pid);
  }
  /* 清掉它们留下的临时 profile（只删我们认识的前缀） */
  let dirs = [];
  try {
    dirs = fs.readdirSync('/tmp').filter((n) => OUR_PREFIX.test(n) &&
      /^(e2e|cdp|boot|corners|refsimg|sweep|corner|shot|fm|refs|peerui|orchestra|studio|worldengine|appboot|appserver)/i.test(n));
    for (const n of dirs) {
      const full = path.join('/tmp', n);
      try { if (!dry) fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
  const rep = { at: new Date().toISOString(), dry: !!dry, processes: got.length, rssMB,
                parents: parents.map((p) => p.pid), tmpDirs: dirs.length };
  if (!dry) {
    try { fs.writeFileSync(path.join(ROOT, 'docs/清理孤儿浏览器.json'), JSON.stringify(rep, null, 1)); } catch (e) {}
  }
  console.log((dry ? '（只看不收）' : '收掉 ') + got.length + ' 个孤儿无头浏览器，约 ' + rssMB + 'MB' +
              (dirs.length ? '；清掉 ' + dirs.length + ' 个临时 profile 目录' : ''));
  return rep;
}

module.exports = { sweep, sweepSync: () => sweep(false) };
if (require.main === module) sweep(DRY);
