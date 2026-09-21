// Google 登录 GitHub（改进：轮询等待页面就绪，不靠死等）
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const PORT = 9336;
const EMAIL = 'gelijunge22@gmail.com';
const PASS = '1!2@3#1q2w3e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--proxy-server=http://本地代理',
    '--window-size=1280,900',
    '--user-data-dir=/tmp/gh-g2-profile',
    'about:blank',
  ], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 40; i++) { await sleep(500); try { t = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (t.length) break; } catch (e) {} }
  const page = t.find((x) => x.type === 'page') || t[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const w = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
  const send = (me, p) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  const js = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return null;
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await js(expr); if (v) return v; await sleep(800); }
    return null;
  };
  const info = async (tag) => {
    const s = { tag, url: await js('location.href'), title: await js('document.title'),
      txt: String(await js('document.body ? document.body.innerText.slice(0,400) : ""') || '').replace(/\s+/g, ' ') };
    console.log('[' + tag + '] ' + s.title + ' | ' + s.url);
    if (s.txt) console.log('     ' + s.txt.slice(0, 240));
    fs.writeFileSync('/tmp/gh-g-state.json', JSON.stringify(s, null, 1));
    return s;
  };

  console.log('1) 打开 GitHub 登录页');
  await send('Page.navigate', { url: 'https://github.com/login' });
  await waitFor('document.querySelector("a[href*=google], a[href*=Google]") ? 1 : 0', 30000);
  await info('github-login');

  console.log('2) 点 Continue with Google');
  await js(`(() => { const a=[...document.querySelectorAll('a,button')].find(e=>/google/i.test(e.innerText||'')); if(a){a.click();return 1;} return 0; })()`);
  await waitFor('location.hostname.indexOf("google")>=0 ? 1 : 0', 30000);
  await info('google-page');

  console.log('3) 填邮箱');
  await waitFor('document.querySelector("input[type=email],#identifierId") ? 1 : 0', 30000);
  await js(`(() => { const i=document.querySelector('input[type=email]')||document.querySelector('#identifierId'); if(!i) return 0; i.focus(); i.value=${JSON.stringify(EMAIL)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(1200);
  await js(`(() => { const b=document.querySelector('#identifierNext button,#identifierNext'); if(b){b.click();return 1;} return 0; })()`);
  await sleep(7000);
  await info('after-email');

  console.log('4) 填密码');
  const ok = await waitFor('document.querySelector("input[type=password]") ? 1 : 0', 30000);
  console.log('   密码框出现:', ok);
  await js(`(() => { const i=document.querySelector('input[type=password]'); if(!i) return 0; i.focus(); i.value=${JSON.stringify(PASS)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(1200);
  await js(`(() => { const b=document.querySelector('#passwordNext button,#passwordNext'); if(b){b.click();return 1;} return 0; })()`);
  await sleep(12000);
  await info('after-password');

  console.log('5) 等跳回 GitHub（可能要确认授权）');
  for (let i = 0; i < 8; i++) {
    await sleep(5000);
    const u = await js('location.href');
    console.log('   [' + i + '] ' + String(u).slice(0, 100));
    if (String(u).indexOf('github.com') >= 0 && String(u).indexOf('/login') < 0) break;
    // 可能出授权页，试着点继续
    await js(`(() => { const b=[...document.querySelectorAll('button,input[type=submit],a')].find(e=>/continue|允许|继续|allow/i.test(e.innerText||'')); if(b) b.click(); return 1; })()`);
  }
  await info('final');
  console.log('状态写 /tmp/gh-g-state.json，浏览器留 20 分钟');
  await sleep(1200000);
  chrome.kill();
})();
