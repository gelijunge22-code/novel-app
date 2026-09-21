/* ============================================================
   e2e-orchestra.js — 多 Agent 在**真界面**上跑一遍（第 9 轮）：
     * 对话页有没有「干活方式」三个胶囊（讨论 / 计划 / 执行）
     * 点一下真的切换、且记住
     * 用「讨论」真发一句话：屏幕上要依次出现**角色徽章**（主创 → 挑刺 → 主创 → 挑刺），
       证明编排不是后台偷偷拼文本，用户看得见谁在干活
     * 390 宽不横向溢出；每一步截图 md5 必须不同（相同 = 没换屏）
   用法：node tools/e2e-orchestra.js
   产出：docs/多Agent界面实测.json + docs/前端截图/r9-orch-*.png
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
const OUT = path.join(ROOT, 'docs/多Agent界面实测.json');
const SHOT = path.join(ROOT, 'docs/前端截图');
const { shelfShield } = require('./preflight');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let COOKIE = '';
const MODEL = '渠道/[渠道]某模型';

async function api(method, p, body) {
  const r = await fetch(BASE.replace(/\/$/, '') + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, COOKIE ? { cookie: COOKIE } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) COOKIE = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t };
}
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const TITLE = 'E2E编排-' + Date.now().toString().slice(-6);
  await api('POST', '/api/app/login', { password: readPassword() });
  await shelfShield({ api, script: 'e2e-orchestra.js' });   // 架上有自测书 → 拒绝开跑（并发跑出来的红是假红）
  /* 先扫掉上次跑崩留下的测试书 —— 脚本末尾本来就会自删，但**中途被杀**（超时/断线/
     模型通道中断）就删不掉，用户书架上就会挂着一本「E2E编排-xxxxxx」的垃圾。
     第 11 轮就真留下了一本（E2E编排-660768），是走查时按书名排在最前面才发现的。 */
  try {
    const ps = await api('GET', '/api/projects');
    const stale = ((ps.json && ps.json.projects) || []).filter((x) => /^E2E编排-\d+$/.test(x.title || ''));
    for (const x of stale) {
      await api('DELETE', '/api/projects/item?projectRoot=' + encodeURIComponent(x.projectRoot));
      console.log('  （清掉上次残留的测试书：' + x.title + '）');
    }
  } catch (e) { /* 清残留失败不拦着本次跑 */ }
  const born = await api('POST', '/api/projects', { title: TITLE, summary: '自动化测试用书（跑完自删）', kind: 'novel' });
  const SLUG = born.json && (born.json.projectRoot || born.json.slug);
  if (!SLUG) { console.error('建测试书失败', born.status, born.text.slice(0, 200)); process.exit(1); }
  await api('POST', '/api/import/text', { slug: SLUG, name: '第001章-测试', text: '雪停了。林诺数了数木牌，一百零八块。\n' });
  await api('POST', '/api/import/text', { slug: SLUG, name: '第002章-测试', text: '第二天早上，木牌少了一块。\n' });
  const ses = await api('POST', '/api/agent/sessions', { profileKey: 'leader.default', currentProjectRoot: SLUG, title: '编排界面实测' });
  const SID = ses.json && ses.json.sessionId;
  if (!SID) { console.error('建会话失败', ses.status, ses.text.slice(0, 200)); process.exit(1); }
  console.log('测试书：' + TITLE + ' → ' + SLUG + '，会话 #' + SID);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-orch-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9343', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9343/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
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
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const seen = new Map();
  const shots = [];
  const shoot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!(r.result && r.result.data)) return { md5: '', dup: null };
    const buf = Buffer.from(r.result.data, 'base64');
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    fs.writeFileSync(path.join(SHOT, 'r9-orch-' + name + '.png'), buf);
    const dup = seen.get(md5);
    seen.set(md5, name);
    shots.push({ name: 'orch-' + name, md5, dup: dup || null });
    return { md5, dup };
  };
  const check = (name, ok, why, shot) => {
    results.push({ name, ok: !!ok, why: String(why || ''), shot: shot || '' });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   —— ' + String(why || '').slice(0, 220)));
  };

  await send('Page.navigate', { url: BASE + '?orch=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }

  await js("App.show('chat'); 1", 1500);
  await js("window.Chat.open(" + SID + "); 1", 2500);

  /* ① 模式胶囊在不在、是不是三个 */
  const bar = await js(`(() => {
    const box = document.getElementById('chat-modes');
    if (!box) return { n: 0 };
    const bs = [...box.querySelectorAll('.mode-btn')];
    const r = box.getBoundingClientRect();
    return { n: bs.length, labels: bs.map(b => b.textContent.trim()),
             on: (bs.find(b => b.classList.contains('on')) || {}).textContent,
             right: Math.round(r.right), vw: window.innerWidth,
             rowRight: Math.round((document.querySelector('.mode-row') || box).getBoundingClientRect().right) };
  })()`);
  check('① 对话页有「干活方式」三个胶囊（讨论 / 计划 / 执行）',
    bar && bar.n === 3 && bar.labels.join('') === '讨论计划执行', JSON.stringify(bar));
  const s1 = await shoot('01-对话-模式胶囊');

  /* ② 点「计划」→ 高亮切过去、并且记住 */
  await js(`(() => { const b = [...document.querySelectorAll('#chat-modes .mode-btn')].find(x => x.textContent.trim() === '计划'); b && b.click(); return 1; })()`, 600);
  const after = await js(`(() => ({
    on: (document.querySelector('#chat-modes .mode-btn.on') || {}).textContent,
    saved: (JSON.parse(localStorage.getItem('nbapp.chat.v1') || '{}').mode) || ''
  }))()`);
  check('② 点「计划」之后高亮跟着走，并且被记住（下次进来还是它）',
    after && after.on === '计划' && after.saved === 'plan', JSON.stringify(after));
  const s2 = await shoot('02-切到计划');
  check('②b 切模式这一屏和上一屏不是同一张图', s1.md5 && s2.md5 && s1.md5 !== s2.md5,
    '上屏 ' + s1.md5 + ' / 这屏 ' + s2.md5);

  /* ③ 390 宽不横向溢出（模式行是新增的，最容易撑破） */
  const ovf = await js(`(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth,
      row: Math.round((document.querySelector('.mode-row') || document.body).getBoundingClientRect().right) }))()`);
  check('③ 模式行在 390 宽下不横向溢出',
    ovf && ovf.doc <= ovf.vw + 1 && ovf.row <= ovf.vw + 1, JSON.stringify(ovf));

  /* ④ 真发一句话（讨论模式）：屏幕上要出现角色徽章，且换人 */
  await js(`(() => { const b = [...document.querySelectorAll('#chat-modes .mode-btn')].find(x => x.textContent.trim() === '讨论'); b && b.click(); const ta = document.getElementById('chat-input'); ta.value = '我想让第003章接上木牌那条线，先聊聊怎么写。'; ta.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`, 400);
  /* 注意 `void`：send 返回的是"直到回复结束才 resolve"的 promise，
     直接 await 它（CDP 的 awaitPromise）会把脚本挂死在一步上 —— 实跑挂了 12 分钟才发现。 */
  await js("void window.Chat.send('我想让第003章接上木牌那条线，先聊聊怎么写。'); 1", 3000);
  /* 等到**后端把这次编排跑完**再断言 —— 以前只等"徽章数 ≥4"，会在第 2 棒时就往下走，
     于是 ⑥ 拿到的 run 只有 2 步、④ 的角色序列也只看到半截（假红）。
     （真踩过：修好 SSE 订阅后徽章立刻出来了，脚本却因为"还没跑完"判失败。） */
  let badges = [], runRowText = '', runSt = null; const stSamples = [];
  for (let i = 0; i < 90; i++) {                 // 讨论模式四棒，串行调模型，给足时间（最长 7.5 分钟）
    await sleep(5000);
    const raw = await js(`JSON.stringify({
      badges: [...document.querySelectorAll('#chat-body .role-badge')].map(b => ({
        role: b.dataset.role, name: (b.querySelector('.rn')||{}).textContent,
        title: (b.querySelector('.rt')||{}).textContent || '' })),
      runRow: (document.getElementById('chat-run')||{}).className || '',
      runText: (document.getElementById('chat-run')||{}).innerText || '',
      st: (document.getElementById('chat-status')||document.getElementById('chat-st')||{}).textContent || ''
    })`);
    let o = null; try { o = JSON.parse(raw); } catch (e) {}
    if (o) {
      if ((o.badges || []).length >= badges.length) badges = o.badges || [];
      if (o.runText && !runRowText) runRowText = o.runText;
      if (/run-row/.test(o.runRow || '') && /·/.test(o.runText || '')) runRowText = o.runText;
      if (o.st) stSamples.push(o.st);
    }
    const r = await api('GET', `/api/agent/sessions/${SID}/runs?limit=1`);
    runSt = (r.json && r.json.runs && r.json.runs[0]) || null;
    if (runSt && runSt.status && runSt.status !== 'running') break;
  }
  /* 一棒可能调好几轮模型（每轮一个 message_start），所以按"角色换没换"归并，
     期望正好是 主创 → 挑刺 → 主创 → 挑刺 */
  const roles = (badges || []).map((b) => b.role);
  const seqRoles = roles.filter((r, i) => i === 0 || r !== roles[i - 1]);
  check('④ 讨论模式真跑完，屏幕上按 主创→挑刺→主创→挑刺 换棒（不是一条没署名的回复）',
    seqRoles.join(',') === 'leader,critic,leader,critic' && roles.length >= 4,
    JSON.stringify({ seqRoles, badges: (badges || []).length, runSt: runSt && runSt.status }));
  check('④b 徽章上写着这一步在干什么（不是光有个名字）',
    (badges || []).some((b) => (b.title || '').length > 0), JSON.stringify(badges).slice(0, 200));
  /* 新增：编排进度行（事件来自后端 orchestra_*，以前前端压根没订阅 → 一条也收不到） */
  /* 进度行长这样：「讨论  1·主创  2·挑刺  3·主创  4·挑刺」，正在跑的那一棒高亮。
     断言方式：四棒的胶囊都在（数字·角色名 ×4）；另外状态行里应当出现过「第 N/4 棒」。
     （第一版断言写成 /棒/，但进度行里根本没有"棒"字 —— 是断言写错了，不是功能没做。） */
  const pills = (runRowText || '').match(/\d+·[\u4e00-\u9fa5]+/g) || [];
  check('④c 界面上有「第 N 棒 · 角色」的实时进度（编排进度行真的出现过）',
    pills.length >= 4 || /第\s*\d+\/\d+\s*棒/.test(stSamples.join('|')),
    JSON.stringify({ pills, runs: runRowText, st: stSamples.slice(0, 3) }).slice(0, 200));
  const s3 = await shoot('03-讨论跑完-角色链');

  /* ⑤ 界面上不能有报错 */
  const errs = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)/.test(e));
  check('⑤ 全程 0 个前端报错', errs.length === 0, JSON.stringify(errs).slice(0, 240));

  /* ⑥ 这次会话的编排记录能被后端还原（界面刷新也不丢） */
  const rec = await api('GET', `/api/agent/sessions/${SID}/runs?limit=1`);
  const run0 = (rec.json && rec.json.runs && rec.json.runs[0]) || null;
  check('⑥ 后端记着这次编排（刷新后界面还能显示谁干了什么）',
    !!run0 && run0.mode === 'discuss' && run0.steps.length === 4, JSON.stringify(run0 && {
      mode: run0.mode, steps: run0.steps.map((s) => s.role) }));

  await api('DELETE', '/api/projects/item?projectRoot=' + encodeURIComponent(SLUG));
  const ok = results.filter((r) => r.ok).length;
  const dupShots = shots.filter((s) => s.dup);
  fs.writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString().slice(0, 19).replace('T', ' '), base: BASE,
    scratch: { title: TITLE, slug: SLUG, sessionId: SID },
    total: results.length, passed: ok, failed: results.length - ok,
    duplicateShots: dupShots.map((s) => s.name + '=' + s.dup),
    shots, consoleErrors, items: results,
  }, null, 1), 'utf8');
  console.log(`\n=== 多 Agent 界面实测：${ok}/${results.length} ===`);
  console.log('报告：docs/多Agent界面实测.json' + (dupShots.length ? '  ⚠ 有重复截图：' + JSON.stringify(dupShots) : ''));
  ws.close();
  process.exit(ok === results.length && dupShots.length === 0 ? 0 : 1);
})();
