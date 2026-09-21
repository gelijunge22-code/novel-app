/* ============================================================
   shots-lore.js — 「设定」页改前 / 改后截图（第 36 轮）

   用法：LORE_SHOT=before node tools/shots-lore.js     → docs/lore/前-*.png
         LORE_SHOT=after  node tools/shots-lore.js     → docs/lore/后-*.png

   规矩（跟 tools/shots-30.js 一致，别再踩那两次假绿）：
     ① 等启动页真退场再动；② 拍之前过 gate（名字写哪屏、屏幕上就得是哪屏，且内容够）；
     ③ 拍完当场量像素（tools/imgstat.py），空白就重拍，仍空白判红。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { open, sleep } = require('./cdp');

const ROOT = '/home/ubuntu/novel-app';
const DIR = path.join(ROOT, 'docs/lore');
const TAG = (process.env.LORE_SHOT || 'before') === 'after' ? '后' : '前';
const pw = (() => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; } catch (e) { return ''; } })();
const PY = path.join(ROOT, 'server/venv/bin/python');

function imgstat(f) {
  try { return JSON.parse(execFileSync(PY, [path.join(ROOT, 'tools/imgstat.py'), f], { encoding: 'utf8' })); }
  catch (e) { return { ink: -1, blank: false }; }
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const s = await open({ port: 9376, width: 390, height: 844 });
  const bad = [], shots = [];
  const seen = new Map();

  const shot = async (name, gateJs) => {
    const file = path.join(DIR, TAG + '-' + name + '.png');
    const gate = gateJs ? await s.js(gateJs) : { ok: true, seen: '' };
    let st = null, tries = 0;
    for (; tries < 3; tries++) {
      await s.js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))', 8000);
      await s.shot(file);
      st = imgstat(file);
      if (!st.blank) break;
      await sleep(500);
    }
    const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    if (seen.has(md5)) bad.push('「' + name + '」和「' + seen.get(md5) + '」一模一样（拍错屏？）');
    else seen.set(md5, name);
    if (gate && !gate.ok) bad.push('「' + name + '」拍的时候屏幕上不是它：' + ((gate && gate.seen) || '(没探到)'));
    if (st.blank) bad.push('「' + name + '」重拍 ' + tries + ' 次仍是空白页');
    shots.push({ name: TAG + '-' + name, file: path.relative(ROOT, file), ink: st.ink, gate: (gate && gate.seen) || '', ok: !!(gate && gate.ok) && !st.blank });
    console.log('  ' + (gate && gate.ok && !st.blank ? '✓' : '✗') + ' ' + (TAG + '-' + name).padEnd(16)
      + ' 墨迹=' + String(((st.ink || 0) * 100).toFixed(1) + '%').padEnd(7) + ((gate && gate.seen) || ''));
  };

  await s.nav('http://127.0.0.1:8899/?shotslore=' + Date.now());
  await sleep(2500);
  await s.js(`(() => { const l = document.getElementById('login');
    if (l && !l.classList.contains('hidden')) {
      const i = document.getElementById('login-pass'); i.value = ${JSON.stringify(pw)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-go').click();
    } return 1; })()`);
  await sleep(3000);
  const sp = await s.js(`(async () => { for (let i = 0; i < 90; i++) {
      const e = document.getElementById('splash');
      if (!e || e.classList.contains('gone') || getComputedStyle(e).display === 'none') return true;
      await new Promise((r) => setTimeout(r, 120)); } return false; })()`, 45000);
  if (!sp) { console.error('启动页没退场 —— 停'); s.close(); process.exit(1); }
  const bk = await s.js(`(async () => {
    const badre = /^(zz-|zzperf|界面实测|走查|e2e|性能自测|tmp-|test-)/i;
    const cards = [...document.querySelectorAll('#shelf-list .book-card')];
    const c = cards.find((x) => !badre.test(x.dataset.slug || '')) || cards[0];
    if (!c) return null; c.click();
    for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 150));
      if (window.Reader && Reader.isOpen()) break; }
    return (c.dataset.slug || 'book'); })()`, 45000);
  if (!bk) { console.error('书架上没有书 —— 停'); s.close(); process.exit(1); }
  console.log('  用书：' + bk);

  /* ① 列表 */
  await s.js("(() => { if (Reader.quickClose) Reader.quickClose(true); App.show('lore'); return 1; })()");
  await sleep(2200);
  await shot('列表', `(() => {
    const b = document.getElementById('lore-body');
    const g = document.querySelectorAll('#lore-body .lore-group').length;
    const it = document.querySelectorAll('#lore-body .lore-item').length;
    return { ok: g > 0 && it > 1, seen: '分组=' + g + ' 条目=' + it }; })()`);

  /* ② 搜索 */
  await s.js("(() => { const b = document.getElementById('lore-searchbar'); if (b && b.classList.contains('hidden')) Lore.toggleSearch(); return 1; })()");
  await sleep(500);
  await s.js("(() => { Lore.search('魂'); return 1; })()");
  await sleep(1600);
  await shot('搜索', `(() => {
    const h = document.querySelectorAll('#lore-body .hit').length;
    return { ok: h > 0, seen: '命中=' + h }; })()`);
  await s.js("(() => { if (Lore.toggleSearch) Lore.toggleSearch(); return 1; })()");
  await sleep(700);

  /* ③ 编辑器（点第一条真条目） */
  await s.js("(() => { const it = document.querySelector('#lore-body .lore-item'); if (it) it.click(); return 1; })()");
  await sleep(1800);
  await shot('编辑器', `(() => {
    const ed = document.getElementById('lore-editor');
    const ta = document.getElementById('ed-area');
    return { ok: !!ed && !!ta && (ta.value || '').length > 10, seen: ed ? ('编辑器在（' + ta.value.length + ' 字）') : '编辑器没开' }; })()`);
  await s.js("(() => { const b = document.querySelector('#lore-editor [data-close-ed]'); if (b) b.click(); return 1; })()");
  await sleep(800);

  /* ④ 新建条目面板（改后才有；改前这一张允许空 → 记进报告不判红） */
  const hasNew = await s.js("(() => { try { return !!document.querySelector('[data-act=lore-new]'); } catch (e) { return false; } })()");
  if (hasNew) {
    await s.js("(() => { const b = document.querySelector('[data-act=lore-new]'); if (b) b.click(); return 1; })()");
    await sleep(1200);
    await shot('新建', `(() => { const p = document.getElementById('sheet-panel');
      const chips = document.querySelectorAll('#sheet-panel .lore-chip').length;
      const inp = document.querySelectorAll('#sheet-panel input, #sheet-panel .input').length;
      return { ok: !!p && chips > 0 && inp > 0, seen: '分类块=' + chips + ' 输入框=' + inp }; })()`);
    await s.js("(() => { App.closeSheet(); return 1; })()");
    await sleep(600);
  } else {
    shots.push({ name: TAG + '-新建', file: '', ok: true, skipped: '改前没有这个入口' });
    console.log('  · 新建面板：改前没有这个入口（跳过）');
  }

  const errs = s.errors();
  if (errs.length) bad.push('页面里有 JS 报错 ' + errs.length + ' 条：' + errs.slice(0, 3).join(' | '));
  const out = path.join(ROOT, 'docs/设定截图-' + TAG + '.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), book: bk, tag: TAG, shots, bad, errors: errs }, null, 1));
  console.log('\n' + (bad.length ? ('有问题 ❌ ' + bad.join('；')) : ('全过 ✅ ' + shots.length + ' 张')));
  console.log('→ ' + path.relative(ROOT, out));
  s.close();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
