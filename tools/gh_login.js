// 用真浏览器登录 GitHub 并建仓库（密码认证已被 GitHub 废弃，只能走网页）
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const PORT = 9333;
const USER = 'gelijunge22@gmail.com';
const PASS = '1!2@3#1q2w3e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--window-size=1280,900',
    '--user-data-dir=/tmp/gh-login-profile',
    'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 没起来'); chrome.kill(); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'ERR:' + JSON.stringify(r.result.exceptionDetails).slice(0, 200);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const go = async (url, wait) => { await send('Page.navigate', { url }); await sleep(wait || 4000); };

  console.log('1) 打开登录页');
  await go('https://github.com/login', 5000);
  console.log('   标题:', await js('document.title'));

  console.log('2) 填账号密码');
  await js(`(() => {
    const u = document.querySelector('#login_field'); const p = document.querySelector('#password');
    if (!u || !p) return 'no-form';
    u.value = ${JSON.stringify(USER)}; p.value = ${JSON.stringify(PASS)};
    u.dispatchEvent(new Event('input', {bubbles:true})); p.dispatchEvent(new Event('input', {bubbles:true}));
    return 'filled';
  })()`);
  await sleep(600);
  await js(`(() => { const f = document.querySelector('form'); if (f) { f.submit(); return 'submitted'; } const b=document.querySelector('input[type=submit]'); if(b){b.click();return 'clicked';} return 'no-btn'; })()`);
  await sleep(8000);
  console.log('3) 登录后标题:', await js('document.title'));
  console.log('   URL:', await js('location.href'));
  const body = await js('document.body.innerText.slice(0,600)');
  console.log('   页面内容片段:', String(body).replace(/\s+/g, ' ').slice(0, 400));

  // 把状态落盘，后续步骤（建仓库 / 建 token）另跑
  fs.writeFileSync('/tmp/gh-login-state.json', JSON.stringify({
    url: await js('location.href'), title: await js('document.title'),
    snippet: String(body).slice(0, 800),
  }, null, 1));
  console.log('状态已存 /tmp/gh-login-state.json（浏览器保持打开 10 分钟）');
  await sleep(600000);
  chrome.kill();
})();
