/* ============================================================
   verify_sweep_guard.js —— 走查判据的**反证**。
   问题：e2e-sweep.js 每次跑都报"0 问题"，但这可能是判据根本不会报
        （历史上真发生过：只量横向溢出、量不到"7 个主题挤 3 行"）。
   做法：在真页面上**故意把界面弄坏**，用同一段 MEASURE、同一个 judgePanel，
        看它是否逐条报出来；再把界面还原，确认不再报。
   判据只有一份（tools/sweep_guard.js），正式走查与这里共用。
   用法：node tools/verify_sweep_guard.js   产出：docs/走查反证.json
   退出码：0 = 每条判据都"能报能收"，否则 1。
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MEASURE, judgePanel } = require('./sweep_guard.js');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = 'http://127.0.0.1:8899/';
const OUT = path.join(ROOT, 'docs/走查反证.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readPassword = () => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; } catch (e) { return ''; } };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9341', '--window-size=390,844', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) { await sleep(400); try { targets = await (await fetch('http://127.0.0.1:9341/json/list')).json(); if (targets && targets.length) break; } catch (e) {} }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };
  const measure = async () => { const raw = await js(MEASURE); try { return JSON.parse(raw); } catch (e) { return { __err: String(raw).slice(0, 120) }; } };

  await send('Page.navigate', { url: BASE + '?guard=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }

  const results = [];
  const check = (name, expectKind, problems, expectFire) => {
    const hit = problems.some((p) => p.kind.indexOf(expectKind) >= 0);
    const ok = hit === expectFire;
    results.push({ 用例: name, 期望: (expectFire ? '报出 ' : '不报 ') + expectKind, 实际: hit ? '报出' : '不报', 结论: ok ? 'PASS' : 'FAIL',
                   detail: (problems.find((p) => p.kind.indexOf(expectKind) >= 0) || {}).detail || '' });
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + '：期望' + (expectFire ? '报' : '不报') + '「' + expectKind + '」→ ' + (hit ? '报了' : '没报'));
    return ok;
  };

  /* ── 0. 原样：设置页应该是干净的 ── */
  await js("App.show('settings'); 1"); await sleep(1500);
  const clean = await measure();
  let good = true;
  good &= check('设置页原样', '选项组换行失衡', judgePanel('主界面:settings', clean), false);
  const themeGroup = (clean.groups || []).find((g) => g.key === 'theme') || {};
  console.log('    主题组实测：' + JSON.stringify(themeGroup));

  /* ── 1. 选项组换行失衡：三条子判据各破坏一次，必须各报一次 ──
     上一版这里只注了 `flex:0 0 auto`，结果实测仍是 4+3 两行 —— **没复现出用户的症状**，
     判据自然不报（反证反而证明了"这条判据可能压根抓不到那类坏界面"）。
     现在按用户看到的三种坏样子分别造：① 挤成 3 行 ② 最后一张孤零零一行 ③ 一行宽一行窄。 */
  const style = (css) => js(`(() => { const s = document.getElementById('guard-break') || document.createElement('style');
    s.id = 'guard-break'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); return 1; })()`);
  const unstyle = () => js("(() => { const s = document.getElementById('guard-break'); if (s) s.remove(); return 1; })()");
  const themeGroupOf = (m) => (m.groups || []).find((g) => g.key === 'theme') || {};

  /* ① 窄容器 → 挤成 3 行（用户原话："7 个选项挤成三行"） */
  await style('.settings-row .seg.grid{max-width:150px}');
  const m3 = await measure();
  good &= check('主题组被挤成 3 行', '选项组换行失衡', judgePanel('主界面:settings', m3), true);
  console.log('    挤 3 行实测：' + JSON.stringify(themeGroupOf(m3)));
  await unstyle();

  /* ② 强制换行 → 第 7 个"夜间"孤零零一行靠右 */
  await style('.settings-row .seg.grid::after{content:"";flex:0 0 100%;height:0}.settings-row .seg.grid button:nth-child(n+7){flex:0 0 calc(25% - 5px)}');
  const m1 = await measure();
  good &= check('最后一个胶囊独占一行', '选项组换行失衡', judgePanel('主界面:settings', m1), true);
  console.log('    孤零零一行实测：' + JSON.stringify(themeGroupOf(m1)));
  await unstyle();

  /* ③ 一行宽一行窄（没对齐）→ 行宽差 ≥30px */
  await style('.settings-row .seg.grid button:nth-child(n+5):nth-child(-n+7){flex-basis:calc(33.3% - 6px);min-width:110px}');
  const m2 = await measure();
  good &= check('两行宽度差 ≥30px', '选项组换行失衡', judgePanel('主界面:settings', m2), true);
  console.log('    行宽不等实测：' + JSON.stringify(themeGroupOf(m2)));
  await unstyle();
  await sleep(400);
  good &= check('还原后又干净了', '选项组换行失衡', judgePanel('主界面:settings', await measure()), false);

  /* ── 2. 塞一个超宽元素 → 必须报"横向溢出" ── */
  await js("App.show('tools'); 1"); await sleep(1200);
  await js(`(() => { const d = document.createElement('div'); d.id = 'guard-wide';
    d.style.cssText = 'width:520px;height:8px;background:#f00'; document.body.appendChild(d); return 1; })()`);
  await sleep(400);
  good &= check('塞 520px 宽元素', '横向溢出', judgePanel('x', await measure()), true);
  await js("document.getElementById('guard-wide').remove(); 1"); await sleep(300);
  good &= check('移走后不报溢出', '横向溢出', judgePanel('x', await measure()), false);

  /* ── 3. 面板正文全空 → 必须报"面板进去了但是空的" ── */
  await js(`(() => { const c = document.querySelector('#tools-body .tool-card[data-id="about"]'); if (c) c.click(); return 1; })()`);
  await sleep(2200);
  const panelOk = await measure();
  good &= check('about 面板正常', '面板进去了但是空的', judgePanel('about', panelOk), false);
  const saved = await js("(document.getElementById('tool-body')||{}).innerHTML || ''");
  await js("document.getElementById('tool-body').innerHTML = '<p>…</p>'; 1"); await sleep(300);
  good &= check('把面板正文清成 1 个字', '面板进去了但是空的', judgePanel('about', await measure()), true);
  await js("document.getElementById('tool-body').innerHTML = " + JSON.stringify(saved) + "; 1"); await sleep(400);
  good &= check('正文还原', '面板进去了但是空的', judgePanel('about', await measure()), false);

  /* ── 4. 拿掉 / 藏起返回入口 → 必须报 ──
     用**真的移除**而不是 display:none —— 上一版就是用 display:none，判据不报，
     因为老 MEASURE 只查存在性（这一条就是反证逼出来的真修复，已进 sweep_guard.js）。 */
  await js(`(() => { const b = document.querySelector('#screen-tool [data-act="tool-back"]');
    if (b) { b.dataset.guardSaved = b.outerHTML; b.remove(); } return 1; })()`);
  await sleep(400);
  good &= check('真的移除返回入口', '面板没有返回入口', judgePanel('about', await measure()), true);
  await js(`(() => { const t = document.querySelector('#screen-tool .topbar'); const b = document.createElement('div');
    b.innerHTML = '<button class="icon-btn" data-icon="back" data-act="tool-back" aria-label="返回"></button>';
    const nb = b.firstElementChild; t.insertBefore(nb, t.firstChild); if (window.App && App.icons) App.paintIcons && App.paintIcons(); return 1; })()`);
  await sleep(500);
  good &= check('恢复返回入口', '面板没有返回入口', judgePanel('about', await measure()), false);
  /* 只把它藏起来（display:none）—— 用户点不到，也必须报 */
  await js(`(() => { const b = document.querySelector('#screen-tool [data-act="tool-back"]'); if (b) b.style.display = 'none'; return 1; })()`);
  await sleep(300);
  good &= check('返回入口被藏起来（display:none）', '面板没有返回入口', judgePanel('about', await measure()), true);
  await js(`(() => { const b = document.querySelector('#screen-tool [data-act="tool-back"]'); if (b) b.style.display = ''; return 1; })()`);
  await sleep(400);
  good &= check('取消隐藏', '面板没有返回入口', judgePanel('about', await measure()), false);

  /* ── 5. 字与底同色 → 必须报 ── */
  await js(`(() => { const s = document.createElement('span'); s.id = 'guard-inv'; s.textContent = '看不见的字';
    s.style.cssText = 'color:#123456;background-color:#123456;display:block'; document.getElementById('tool-body').appendChild(s); return 1; })()`);
  await sleep(400);
  good &= check('字与底同色', '字与底同色', judgePanel('about', await measure()), true);
  await js("document.getElementById('guard-inv').remove(); 1"); await sleep(300);
  good &= check('移走后不报', '字与底同色', judgePanel('about', await measure()), false);

  /* ── 6. 文字被硬切（没有省略号）→ 必须报 ── */
  await js(`(() => { const d = document.createElement('div'); d.id = 'guard-cut';
    d.style.cssText = 'width:60px;overflow:hidden;white-space:nowrap;font-size:13px';
    d.textContent = '这一行字很长很长很长很长很长很长很长很长一定会被硬切掉'; document.getElementById('tool-body').appendChild(d); return 1; })()`);
  await sleep(400);
  good &= check('窄容器硬切长句', '文字被硬切', judgePanel('about', await measure()), true);
  await js(`(() => { const d = document.getElementById('guard-cut'); d.style.textOverflow = 'ellipsis'; return 1; })()`);
  await sleep(300);
  good &= check('加上省略号后不报', '文字被硬切', judgePanel('about', await measure()), false);
  await js("document.getElementById('guard-cut').remove(); 1"); await sleep(300);

  /* ── 7. 还在选书页就被当成面板 → 必须报"没进面板" ── */
  await js("App.show('tools'); 1"); await sleep(1000);
  await js(`(() => { const c = document.querySelector('#tools-body .tool-card[data-id="world"]'); if (c) c.click(); return 1; })()`);
  await sleep(2600);   /* world 要先选书，此刻还停在选书页 */
  const pickerM = await measure();
  const pickerProblems = judgePanel('world', pickerM);
  const pickerHit = pickerProblems.some((p) => p.kind === '没进面板');
  results.push({ 用例: '还停在选书页', 期望: pickerM.picker ? '报出 没进面板' : '（这本不是要选书的工具，跳过）',
                 实际: pickerHit ? '报出' : '不报', 结论: pickerM.picker ? (pickerHit ? 'PASS' : 'FAIL') : 'SKIP', detail: pickerM.screen || '' });
  console.log('  ' + (pickerM.picker ? (pickerHit ? '✓' : '✗') : '·') + ' 选书页哨兵：picker=' + pickerM.picker + ' 报出=' + pickerHit);
  if (pickerM.picker) good = good && pickerHit;

  const failed = results.filter((r) => r.结论 === 'FAIL').length;
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(),
    说明: '走查判据反证：故意弄坏界面，看同一套判据是否报得出来（判据单一出处 tools/sweep_guard.js）',
    通过: results.filter((r) => r.结论 === 'PASS').length, 失败: failed, 跳过的: results.filter((r) => r.结论 === 'SKIP').length, 用例: results }, null, 1));
  /* 这一行以前写成"18/19 通过，失败 0"，读着像自相矛盾 —— 其实是有一条 SKIP（那本工具本来就不用选书）。
     分成"通过 / 跳过 / 失败"三个数，别再让人猜。 */
  const skipped = results.filter((r) => r.结论 === 'SKIP').length;
  console.log('\n=== 反证：通过 ' + results.filter((r) => r.结论 === 'PASS').length
    + ' / 跳过 ' + skipped + ' / 失败 ' + failed + '（共 ' + results.length + ' 条） ===');
  console.log('报告：docs/走查反证.json');
  process.exit(good ? 0 : 1);
})();
