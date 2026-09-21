// Google 登录 GitHub —— 有头模式（Xvfb 虚拟屏）+ 反自动化检测
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const PORT = 9337;
const EMAIL = 'gelijunge22@gmail.com';
const PASS = '1!2@3#1q2w3e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const chrome = spawn(CHROME, [
    '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--proxy-server=http://本地代理',
    '--window-size=1366,900',
    '--window-position=0,0',
    '--lang=zh-CN',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--user-agent=' + UA,
    '--user-data-dir=/tmp/gh-g3-profile',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
  let t = null;
  for (let i = 0; i < 40; i++) { await sleep(500); try { t = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (t.length) break; } catch (e) {} }
  const page = t.find((x) => x.type === 'page') || t[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const w = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
  const send = (me, p) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  // 抹掉 navigator.webdriver
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'Object.defineProperty(navigator,"webdriver",{get:()=>undefined});window.chrome={runtime:{}};',
  });
  const js = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return null;
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await js(expr); if (v) return v; await sleep(700); }
    return null;
  };
  const info = async (tag) => {
    const s = { tag, url: await js('location.href'), title: await js('document.title'),
      txt: String(await js('document.body ? document.body.innerText.slice(0,500) : ""') || '').replace(/\s+/g, ' ') };
    console.log('[' + tag + '] ' + s.title);
    console.log('     URL: ' + String(s.url).slice(0, 90));
    if (s.txt) console.log('     文本: ' + s.txt.slice(0, 260));
    fs.writeFileSync('/tmp/gh-g-state.json', JSON.stringify(s, null, 1));
    return s;
  };
  // 像人一样输入
  const humanType = async (selExpr, text) => {
    await js(`(() => { const i=${selExpr}; if(!i) return 0; i.focus(); i.click(); return 1; })()`);
    await sleep(400);
    for (const ch of text) {
      await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      await sleep(30 + Math.random() * 70);
    }
    return 1;
  };

  console.log('1) 打开 GitHub 登录页');
  await send('Page.navigate', { url: 'https://github.com/login' });
  await waitFor('document.querySelector("a[href*=google], a[href*=Google]") ? 1 : 0', 40000);
  await info('github-login');

  console.log('2) 点 Continue with Google');
  await js(`(() => { const a=[...document.querySelectorAll('a,button')].find(e=>/google/i.test(e.innerText||'')); if(a){a.click();return 1;} return 0; })()`);
  await waitFor('location.hostname.indexOf("google")>=0 ? 1 : 0', 40000);
  await sleep(2500);
  await info('google-page');

  console.log('3) 填邮箱（真人节奏）');
  await waitFor('document.querySelector("input[type=email],#identifierId") ? 1 : 0', 40000);
  await humanType('document.querySelector("input[type=email]")||document.querySelector("#identifierId")', EMAIL);
  await sleep(900);
  await js(`(() => { const b=document.querySelector('#identifierNext button,#identifierNext'); if(b){b.click();return 1;} return 0; })()`);
  await sleep(6000);
  await info('after-email');

  console.log('4) 填密码（真人节奏）');
  const ok = await waitFor('document.querySelector("input[type=password]") ? 1 : 0', 40000);
  console.log('   密码框: ' + (ok ? '出现' : '没出现'));
  if (ok) {
    await humanType('document.querySelector("input[type=password]")', PASS);
    await sleep(900);
    await js(`(() => { const b=document.querySelector('#passwordNext button,#passwordNext'); if(b){b.click();return 1;} return 0; })()`);
    await sleep(10000);
  }
  await info('after-password');

  console.log('5) 等跳回 GitHub');
  for (let i = 0; i < 10; i++) {
    await sleep(4500);
    const u = String(await js('location.href'));
    console.log('   [' + i + '] ' + u.slice(0, 100));
    if (u.indexOf('github.com') >= 0 && u.indexOf('/login') < 0) break;
    await js(`(() => { const b=[...document.querySelectorAll('button,input[type=submit],a')].find(e=>/continue|允许|继续|allow/i.test(e.innerText||'')); if(b) b.click(); return 1; })()`);
  }
  await info('final');
  console.log('浏览器留 25 分钟；状态 /tmp/gh-g-state.json');
  await sleep(1500000);
  chrome.kill();
})();
