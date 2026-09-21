// 多节点轮试 Google 登录，找出没被 Google 拦的节点
const { spawn } = require('child_process');
const CHROME = '/usr/bin/google-chrome';
const PORT = 9340;
const EMAIL = 'gelijunge22@gmail.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CTRL = 'http://127.0.0.1:9090';
const GROUP = '本地代理';

const CANDIDATES = [
  '香港原生IP-1|勿跑大流量', '香港原生IP-2|勿跑大流量',
  '台湾1|5x倍率|勿跑大流量', '台湾2|5x倍率|勿跑大流量',
  '美国洛杉矶-1|联通优化', '美国洛杉矶-2', '美国洛杉矶-4|电信联通优化',
  '新加坡1|高速下载|移动优化', '韩国|移动优化', '日本 cdn 1|电信高速',
];

async function api(path, method) {
  const r = await fetch(CTRL + path, { method: method || 'GET' });
  return r.ok ? r.json().catch(() => ({})) : null;
}
async function pickNode(name) {
  const r = await fetch(CTRL + '/proxies/' + encodeURIComponent(GROUP), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return r.ok;
}

(async () => {
  const chrome = spawn(CHROME, [
    '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--proxy-server=http://本地代理',
    '--window-size=1366,900', '--lang=zh-CN',
    '--disable-blink-features=AutomationControlled',
    '--user-data-dir=/tmp/gh-node-profile',
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 80; i++) { await sleep(500); try { t = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (t && t.length) break; } catch (e) {} }
  if (!t) { console.log('浏览器没起来'); process.exit(1); }
  const page = t.find((x) => x.type === 'page') || t[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const w = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
  const send = (m, p) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator,"webdriver",{get:()=>undefined});' });
  const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return (r.result && r.result.result) ? r.result.result.value : null; };
  const waitFor = async (e, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await js(e); if (v) return v; await sleep(600); } return null; };

  const results = [];
  for (const node of CANDIDATES) {
    process.stdout.write('\n【' + node + '】');
    const ok = await pickNode(node);
    if (!ok) { console.log(' 切换失败，跳过'); continue; }
    await sleep(2500);
    const ip = await js('1'); // 触发一次
    let exitIp = '';
    try { const r = await fetch('https://api.ipify.org', { proxy: undefined }); } catch (e) {}
    // 用页面拿出口 IP
    await send('Page.navigate', { url: 'https://api.ipify.org?format=json' });
    await sleep(4000);
    exitIp = String(await js('document.body ? document.body.innerText : ""')).slice(0, 40);
    console.log(' 出口IP: ' + exitIp.trim());

    // 走 GitHub → Google
    await send('Page.navigate', { url: 'https://github.com/login' });
    await waitFor('document.querySelector("a[href*=google]")?1:0', 30000);
    await js('(()=>{const a=[...document.querySelectorAll("a,button")].find(e=>/google/i.test(e.innerText||""));if(a)a.click();return 1})()');
    await waitFor('location.hostname.indexOf("google")>=0?1:0', 30000);
    const hasEmail = await waitFor('document.querySelector("input[type=email]")?1:0', 25000);
    if (!hasEmail) {
      const txt = String(await js('document.body?document.body.innerText.slice(0,120):""')).replace(/\s+/g, ' ');
      console.log('   ⚠️ 没出邮箱框: ' + txt.slice(0, 80));
      results.push({ node, verdict: 'no-email', exitIp: exitIp.trim() });
      continue;
    }
    await js('(()=>{const i=document.querySelector("input[type=email]");i.focus();i.value=' + JSON.stringify(EMAIL) + ';i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()');
    await sleep(800);
    await js('(()=>{const b=document.querySelector("#identifierNext button,#identifierNext");if(b)b.click();return 1})()');
    await sleep(7000);
    const u = String(await js('location.href'));
    const txt = String(await js('document.body?document.body.innerText.slice(0,200):""')).replace(/\s+/g, ' ');
    if (u.indexOf('rejected') >= 0 || /not be secure|不支持 JavaScript|doesn.t support JavaScript/i.test(txt)) {
      console.log('   ❌ 被拦');
      results.push({ node, verdict: 'blocked', exitIp: exitIp.trim() });
    } else if (await waitFor('document.querySelector("input[type=password]")?1:0', 12000)) {
      console.log('   ✅ 过了！出现密码框');
      results.push({ node, verdict: 'PASS', exitIp: exitIp.trim() });
      break;
    } else {
      console.log('   ? 其他: ' + txt.slice(0, 100));
      results.push({ node, verdict: 'unknown', exitIp: exitIp.trim() });
    }
  }
  console.log('\n===== 结果 =====');
  for (const r of results) console.log('  ' + r.verdict.padEnd(8) + ' ' + r.node + '  (' + r.exitIp + ')');
  chrome.kill();
})();
