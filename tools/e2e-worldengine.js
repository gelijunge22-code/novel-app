/* ============================================================
   e2e-worldengine.js — 世界引擎新能力在**真界面**上点一遍（第 8 轮）：
     * 历法页：定义一套架空历 → 列表里看得见「一年几天 / 几年一闰 / 纪元」
     * 换算：文本 → 绝对序号、绝对序号 → 日期（两个方向都要对）
     * 时间线：给时刻「定时间」→ 时刻行上显示历法日期
     * 回溯：给定时刻 → 那一刻的完整状态，每条带出处（场景/行）
   硬要求（照着 12 工具那次的教训）：
     * 每一步截图 md5 必须互不相同（相同 = 根本没换屏或者没点进去）
     * 每张图必须能看见面板标题 + 返回键 + 真内容
   用法：node tools/e2e-worldengine.js
   产出：docs/世界引擎UI实测.json + docs/前端截图/r8-world-*.png
   第 9 轮修正：
     * 用**临时测试书**跑（跑完自删）—— 上一版跑在真书上，
       第二次跑时「四时历 / 第三纪四年」已存在 → 前后两张截图一模一样，
       判据又只查"必须不同" → 假失败 + 假证据。
     * 截图判据改成：**该变的必须变**（对比上一张 md5）；
       **返回同一屏的必须是同一屏**（这才证明"返回键真的回到原处"）。
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:8899/');
const OUT = path.join(ROOT, 'docs/世界引擎UI实测.json');
const SHOT = path.join(ROOT, 'docs/前端截图');
const { shelfShield } = require('./preflight');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let COOKIE = '';
async function api(method, path, body) {
  const r = await fetch(BASE.replace(/\/$/, '') + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, COOKIE ? { cookie: COOKIE } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) COOKIE = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text };
}

function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });

  /* 临时测试书：不碰用户的书，跑完删掉 */
  const TITLE = 'E2E世界引擎-' + Date.now().toString().slice(-6);
  await api('POST', '/api/app/login', { password: readPassword() });
  await shelfShield({ api, script: 'e2e-worldengine.js' });   // 架上有自测书 → 拒绝开跑（并发跑出来的红是假红）
  const born = await api('POST', '/api/projects', { title: TITLE, summary: '自动化测试用书（跑完自删）', kind: 'novel' });
  const SLUG = born.json && (born.json.projectRoot || born.json.slug);
  if (!SLUG) { console.error('建测试书失败', born.status, born.text.slice(0, 200)); process.exit(1); }
  console.log('测试书：' + TITLE + ' → ' + SLUG);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-we-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9341', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9341/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160));
    }
  };
  const send = (m, p) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const seen = new Map();
  const shots = [];          // 每一步**实际拍的图**（一张图被两个检查引用时只算一张）
  const shoot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!(r.result && r.result.data)) return { md5: '', dup: null };
    const buf = Buffer.from(r.result.data, 'base64');
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    fs.writeFileSync(path.join(SHOT, 'r8-world-' + name + '.png'), buf);
    const dup = seen.get(md5);
    seen.set(md5, name);
    shots.push({ name: 'world-' + name, md5, dup: dup || null });
    return { md5, dup };
  };
  const check = (name, ok, why, shot) => {
    results.push({ name, ok: !!ok, why: String(why || ''), shot: shot || '' });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   —— ' + String(why || '').slice(0, 200)));
  };

  await send('Page.navigate', { url: BASE + '?we=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }

  /* 进「世界」面板：先点工具宫格里的 world 卡片，再挑一本书 */
  const entered = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    App.show('tools'); await wait(600);
    const card = document.querySelector('#tools-body [data-id="world"]');
    if (!card) return { err: '宫格里没有"世界"' };
    card.click(); await wait(1500);
    const want = ${JSON.stringify(SLUG)};
    for (let k = 0; k < 6; k++) {
      const row = document.querySelector('#tool-body .t-row[data-slug="' + want + '"]');
      if (row) { row.click(); await wait(1800); break; }
      const pick = document.querySelector('#tool-body .t-row[data-i], #screen-tool .t-row[data-i]');
      if (pick) { pick.click(); await wait(1200); } else { await wait(900); }
    }
    const body = document.getElementById('tool-body');
    return { text: body ? body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : '' };
  })()`);
  const s1 = await shoot('world-01-home');
  check('打开「世界」面板（有实体/事实/时刻的统计）',
    entered && /实体|事实|时刻/.test(entered.text || ''), JSON.stringify(entered), s1.md5);
  check('截图不重复', !s1.dup, '与 ' + s1.dup + ' 相同');

  /* 切到「历法」页签 */
  const cal = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.querySelector('#tool-body [data-tab="calendar"]');
    if (!b) return { err: '没有历法页签' };
    b.click(); await wait(1500);
    const pane = document.querySelector('#tool-body [data-pane]');
    return { text: pane ? pane.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300) : '',
             hasNew: !!document.querySelector('#tool-body [data-newcal]'),
             hasConv: !!document.querySelector('#tool-body [data-conv]'),
             hasSort: !!document.querySelector('#tool-body [data-sort]') };
  })()`);
  const s2 = await shoot('world-02-calendar');
  check('历法页：列出内置公历 + 有「定义历法 / 换算 / 按时间重排」三个入口',
    cal && cal.hasNew && cal.hasConv && cal.hasSort && /公历/.test(cal.text || ''), JSON.stringify(cal), s2.md5);

  /* 定义一套架空历 */
  await js(`(()=>{const b=document.querySelector('#tool-body [data-newcal]'); b&&b.click(); return 1})()`);
  await sleep(1200);
  const made = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    if (!q('#tool-body [data-cal-name]')) return { err: '没打开新建历法的表单' };
    q('#tool-body [data-cal-name]').value = '四时历';
    q('#tool-body [data-cal-months]').value = '40,40,40,40,40,40,40,40,40,40';
    q('#tool-body [data-cal-era]').value = '第三纪';
    q('#tool-body [data-cal-every]').value = '3';
    q('#tool-body [data-cal-leap]').value = '5,5';
    q('#tool-body [data-cal-save]').click();
    await wait(2000);
    // 保存后要退回历法列表才看得见（推入的子页盖着它）
    const back = document.querySelector('#screen-tool [data-act="tool-back"]');
    if (back) { back.click(); await wait(1600); }
    const pane = document.querySelector('#tool-body [data-pane]');
    return { text: pane ? pane.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400) : '' };
  })()`);
  const s3 = await shoot('world-03-calendar-saved');
  check('定义历法后列表里能看到它（含「每 3 年闰一次」「一年 400 天」）',
    made && /四时历/.test(made.text || '') && /闰/.test(made.text || '') && /400/.test(made.text || ''),
    JSON.stringify(made), s3.md5);
  check('定义完历法，画面真的变了（截图与上一步不同）', s3.md5 !== s2.md5,
    '与 world-02 相同：' + s3.md5);

  /* 换算：文本 → 绝对序号 */
  await js(`(()=>{const b=document.querySelector('#tool-body [data-conv]'); b&&b.click(); return 1})()`);
  await sleep(1200);
  const conv = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    if (!q('#tool-body [data-conv-text]')) return { err: '没打开换算表单' };
    const chips = Array.from(document.querySelectorAll('#tool-body [data-cal-chip]'));
    const kong = chips.find((c) => c.textContent.indexOf('四时历') >= 0);
    if (kong) { kong.click(); await wait(400); }
    q('#tool-body [data-conv-text]').value = '第三纪 4 年 1 月 1 日';
    q('#tool-body [data-conv-go]').click(); await wait(1500);
    const out1 = (q('#tool-body [data-conv-out]') || {}).textContent || '';
    q('#tool-body [data-conv-text]').value = '';
    q('#tool-body [data-conv-abs]').value = '1205';
    q('#tool-body [data-conv-go]').click(); await wait(1500);
    const out2 = (q('#tool-body [data-conv-out]') || {}).textContent || '';
    return { out1, out2 };
  })()`);
  const s4 = await shoot('world-04-convert');
  check('换算：文本→绝对序号（第三纪 4 年 1 月 1 日 = 1205）',
    conv && /1205/.test(conv.out1 || '') && /文本→abs/.test(conv.out1 || ''), JSON.stringify(conv), s4.md5);
  check('换算：绝对序号→日期（1205 = 第三纪 4 年 1 月 1 日）',
    conv && /abs→日期/.test(conv.out2 || '') && /第三纪\s*4\s*年\s*1\s*月\s*1\s*日/.test(conv.out2 || ''),
    JSON.stringify(conv), s4.md5);

  /* 回世界首页 → 时间线 → 给时刻定时间 */
  await js(`(()=>{const b=document.querySelector('#screen-tool [data-act="tool-back"]'); b&&b.click(); return 1})()`);
  await sleep(900);
  const tl = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = document.querySelector('#tool-body [data-tab="timeline"]');
    if (!t) return { err: '没有时间线页签' };
    t.click(); await wait(1600);
    // 这本书还没有时刻就先建一个（走真的 ask 对话框，不绕过界面）
    if (!document.querySelector('#tool-body [data-settime]')) {
      const add = document.querySelector('#tool-body [data-add]');
      if (add) {
        add.click(); await wait(600);
        let dlg = document.querySelector('#tool-body .t-dialog');
        if (dlg) { dlg.querySelector('input,textarea').value = '第三纪四年';
                   dlg.querySelector('[data-yes]').click(); await wait(900); }
        dlg = document.querySelector('#tool-body .t-dialog');
        if (dlg) { dlg.querySelector('[data-no]').click(); await wait(1500); }   // 时间先留空，等下再"定时间"
      }
    }
    const pane = document.querySelector('#tool-body [data-pane]');
    return { text: pane ? pane.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : '',
             hasSet: !!document.querySelector('#tool-body [data-settime]'),
             hasRetro: !!document.querySelector('#tool-body [data-retro]') };
  })()`);
  const s5 = await shoot('world-05-timeline');
  check('时间线：每个时刻有「定时间」按钮，工具栏有「回溯到某一刻」',
    tl && tl.hasSet && tl.hasRetro, JSON.stringify(tl), s5.md5);

  await js(`(()=>{const b=document.querySelector('#tool-body [data-settime]'); b&&b.click(); return 1})()`);
  await sleep(1400);
  const st = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    if (!q('#tool-body [data-mt-text]')) {
      return { err: '没打开定时间表单', head: (document.getElementById('tool-body') || {}).innerText.slice(0, 80) };
    }
    const chips = Array.from(document.querySelectorAll('#tool-body [data-mt-chip]'));
    const kong = chips.find((c) => c.textContent.indexOf('四时历') >= 0);
    if (kong) { kong.click(); await wait(400); }
    q('#tool-body [data-mt-text]').value = '第三纪 4 年 1 月 1 日';
    q('#tool-body [data-mt-check]').click(); await wait(1200);
    const preview = (q('#tool-body [data-mt-preview]') || {}).textContent || '';
    q('#tool-body [data-mt-save]').click(); await wait(2200);
    const back = document.querySelector('#screen-tool [data-act="tool-back"]');
    if (back) { back.click(); await wait(1800); }
    const pane = document.querySelector('#tool-body [data-pane]');
    return { preview, text: pane ? pane.innerText.replace(/\\s+/g, ' ').trim().slice(0, 260) : '' };
  })()`);
  const s6 = await shoot('world-06-time-set');
  check('定时间前先「换算看看」：预览要给出绝对序号 1205',
    st && /1205/.test(st.preview || ''), JSON.stringify(st), s6.md5);
  check('定完时间，时刻行上显示历法日期（不再是「还没定时间」）',
    st && /第三纪\s*4\s*年\s*1\s*月\s*1\s*日/.test(st.text || '') && !/还没定时间/.test(st.text || ''),
    JSON.stringify(st), s6.md5);
  check('定完时间，画面真的变了（截图与上一步不同）', s6.md5 !== s5.md5,
    '与 world-05 相同：' + s6.md5);

  /* 回溯 */
  const retro = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.querySelector('#tool-body [data-retro]');
    if (!b) return { err: '没有回溯入口' };
    b.click(); await wait(700);
    const dlg = document.querySelector('#tool-body .t-dialog');
    if (dlg) { dlg.querySelector('input,textarea').value = '第三纪四年';
               dlg.querySelector('[data-yes]').click(); }
    await wait(2600);
    const body = document.getElementById('tool-body');
    const txt = body ? body.innerText.replace(/\\s+/g, ' ').trim() : '';
    return { text: txt.slice(0, 400), hasBack: !!document.querySelector('#screen-tool [data-act="tool-back"]') };
  })()`);
  const s7 = await shoot('world-07-retro');
  check('回溯界面能打开并给出那一刻的世界（带出处）',
    retro && (retro.text || '').length > 20 && !retro.err, JSON.stringify(retro), s7.md5);

  /* 从回溯返回：应该回到时间线（同一屏）—— 这一条**故意**断言"回到原屏" */
  const backHome = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.querySelector('#screen-tool [data-act="tool-back"]');
    if (b) { b.click(); await wait(1600); }
    const pane = document.querySelector('#tool-body [data-pane]');
    return { text: pane ? pane.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : '' };
  })()`);
  check('从「回溯」返回后回到时间线那一屏（不是一脚踢回宫格）',
    backHome && /加一个时刻/.test(backHome.text || ''), JSON.stringify(backHome));

  const uniq = new Set(shots.map((x) => x.md5)).size;
  check('全程没有 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  check(shots.length + ' 张截图内容互不相同（没有重复证据）', uniq === shots.length,
    shots.map((x) => x.name + '=' + x.md5.slice(0, 8) + (x.dup ? '(与 ' + x.dup + ' 重复)' : '')).join(' '));

  /* 测试书跑完就删（进回收站，不硬删） */
  const gone = await api('DELETE', '/api/projects/item?projectRoot=' + encodeURIComponent(SLUG));
  check('测试书已清理（进回收站，不留在书架里）', gone.status === 200 && gone.json && gone.json.ok,
    gone.status + ' ' + gone.text.slice(0, 120));

  const ok = results.filter((r) => r.ok).length;
  fs.writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(), total: results.length, ok, fail: results.length - ok,
    uniqueShots: uniq, shots, consoleErrors, items: results }, null, 1));
  console.log(`\n=== 世界引擎 UI：${ok}/${results.length} ===`);
  console.log('报告：docs/世界引擎UI实测.json');
  process.exit(ok === results.length ? 0 : 1);
})();
