/* overflow_probe.js — 亲自量：预设页 / 书架页 有没有文字溢出、被裁、字号过大 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
/* 在页面里：找出所有"文字装不下"的元素 */
const SCAN = `(() => {
  const out = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const txt = (el.childElementCount === 0 ? (el.textContent || '') : '').trim();
    if (!txt) continue;
    const hx = el.scrollWidth  - el.clientWidth;
    const hy = el.scrollHeight - el.clientHeight;
    if (hx > 2 || hy > 2) {
      out.push({
        文字: txt.slice(0, 28),
        标签: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
        横向超出: hx, 纵向超出: hy,
        字号: st.fontSize, 宽: Math.round(r.width), 高: Math.round(r.height),
        可见宽度: el.clientWidth, 需要宽度: el.scrollWidth
      });
    }
  }
  return out.slice(0, 22);
})()`;
/* 字号分布 */
const FONTS = `(() => {
  const m = {};
  for (const el of document.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || !el.textContent || !el.textContent.trim()) continue;
    const c = (el.childElementCount === 0);
    if (!c) continue;
    const k = st.fontSize;
    m[k] = (m[k] || 0) + 1;
  }
  return m;
})()`;

(async () => {
  const p = await open({ port: 9399, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);

    console.log('=== 书架页 ===');
    console.log('  字号分布:', JSON.stringify(await p.js(FONTS)));
    const sh = await p.js(SCAN);
    console.log('  装不下的元素:', sh.length ? JSON.stringify(sh, null, 1) : '（无）');
    await p.shot('/home/ubuntu/novel-app/docs/监督人-书架-现状.png');

    console.log('\n=== 切到「预设」页 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const nav=[...document.querySelectorAll('nav button, .tabbar button, [data-tab]')];
      const t=nav.find(x=>/预设/.test(x.textContent)) || document.querySelector('[data-go="preset"]');
      if(!t) return '找不到预设入口；底部按钮: '+[...document.querySelectorAll('button')].map(x=>x.textContent.trim()).slice(-8).join('/');
      t.click(); await w(2600); return '已进预设页';})()`, { timeout: 20000 }));
    await sleep(1500);
    console.log('  字号分布:', JSON.stringify(await p.js(FONTS)));
    const pr = await p.js(SCAN);
    console.log('  装不下的元素:', pr.length ? JSON.stringify(pr, null, 1) : '（无）');
    console.log('  页面文字前 200 字:', await p.js(`document.body.innerText.slice(0,200).replace(/\\n/g,' | ')`));
    await p.shot('/home/ubuntu/novel-app/docs/监督人-预设-现状.png');
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
