// 用 Google 账号登录 GitHub（账号密码就是 Google 的）
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const PORT = 9334;
const EMAIL = 'gelijunge22@gmail.com';
const PASS = '1!2@3#1q2w3e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--proxy-server=http://本地代理',
    '--window-size=1280,900',
    '--lang=zh-CN',
    '--user-data-dir=/tmp/gh-g-profile',
    'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 没起来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const js = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'ERR';
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const state = async (tag) => {
    const s = { tag, url: await js('location.href'), title: await js('document.title'),
                txt: String(await js('document.body ? document.body.innerText.slice(0,500) : ""')).replace(/\s+/g, ' ') };
    console.log('[' + tag + ']', s.title, '|', s.url);
    console.log('    ', s.txt.slice(0, 260));
    fs.writeFileSync('/tmp/gh-g-state.json', JSON.stringify(s, null, 1));
    return s;
  };

  console.log('1) 打开 GitHub 登录页');
  await send('Page.navigate', { url: 'https://github.com/login' });
  await sleep(5000);
  await state('github-login');

  console.log('2) 点「Continue with Google」');
  const clicked = await js(`(() => {
    const els = [...document.querySelectorAll('a,button,div[role=button]')];
    const t = els.find(e => /google/i.test(e.innerText || '') );
    if (t) { t.click(); return 'clicked:' + (t.innerText||'').trim().slice(0,40); }
    return 'not-found';
  })()`);
  console.log('   ', clicked);
  await sleep(7000);
  await state('after-google-click');

  console.log('3) 填 Google 邮箱');
  const e1 = await js(`(() => {
    const i = document.querySelector('input[type=email]') || document.querySelector('#identifierId');
    if (!i) return 'no-email-input';
    i.value = ${JSON.stringify(EMAIL)};
    i.dispatchEvent(new Event('input', {bubbles:true}));
    return 'filled';
  })()`);
  console.log('   ', e1);
  await sleep(800);
  await js(`(() => { const b=document.querySelector('#identifierNext button, #identifierNext'); if(b){b.click();return 'next';} return 'no'; })()`);
  await sleep(7000);
  await state('after-email');

  console.log('4) 填 Google 密码');
  const e2 = await js(`(() => {
    const i = document.querySelector('input[type=password]');
    if (!i) return 'no-pass-input';
    i.value = ${JSON.stringify(PASS)};
    i.dispatchEvent(new Event('input', {bubbles:true}));
    return 'filled';
  })()`);
  console.log('   ', e2);
  await sleep(800);
  await js(`(() => { const b=document.querySelector('#passwordNext button, #passwordNext'); if(b){b.click();return 'next';} return 'no'; })()`);
  await sleep(9000);
  await state('after-password');

  console.log('5) 等跳回 GitHub…');
  await sleep(8000);
  await state('final');

  console.log('浏览器保持打开 20 分钟；状态见 /tmp/gh-g-state.json');
  await sleep(1200000);
  chrome.kill();
})();
