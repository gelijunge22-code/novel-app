/* top_gap2.js — 量：顶栏底边 → 下面第一个有内容元素之间，空了多少 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
const M = `(() => {
  const H = window.innerHeight;
  const scr = document.querySelector('.screen:not(.hidden)') || document.body;
  const bar = scr.querySelector('.topbar') || scr.querySelector('header');
  const barB = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
  /* 顶栏之后的所有元素里，找第一个"有墨"的 */
  const cands = [];
  const walk = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    if (r.height < 6 || r.width < 6) return;
    if (r.top + 2 < barB) { for (const c of el.children) walk(c); return; }   // 还在顶栏里，往下找
    const txt = el.childElementCount === 0 ? (el.textContent || '').trim() : '';
    const bg = (st.backgroundImage || '').indexOf('none') < 0;
    const hasBox = st.borderTopWidth !== '0px' || (parseFloat(st.backgroundColor.split('(')[1] || '0') > 0.05);
    if (txt || bg || el.tagName === 'IMG' || hasBox) {
      cands.push({ 标签: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
        顶边: Math.round(r.top), 高: Math.round(r.height), 文字: txt.slice(0, 20) });
      return;
    }
    for (const c of el.children) walk(c);
  };
  for (const c of scr.children) walk(c);
  const first = cands[0];
  return JSON.stringify({
    屏: scr.id || '(无)',
    屏高: H,
    顶栏底边: barB,
    顶栏下第一个内容: first ? first.标签 + ' 「' + first.文字 + '」 顶边=' + first.顶边 : '(没有)',
    顶栏到内容之间空白: first ? (first.顶边 - barB) : null,
    占屏比: first ? Math.round((first.顶边 - barB) / H * 100) + '%' : null
  });
})()`;
(async () => {
  const p = await open({ port: 9407, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4500);
    console.log('  [书架] ' + await p.js(M));
    for (const n of ['预设','设定','对话','工具']) {
      await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
        const b=[...document.querySelectorAll('nav button,button')].find(x=>x.textContent.trim()===${JSON.stringify(n)});
        if(b){b.click(); await w(2300);} return 1;})()`, { timeout: 15000 });
      console.log('  [' + n + '] ' + await p.js(M));
    }
    await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const b=document.getElementById('btn-shelf-menu'); if(b){b.click(); await w(2500);} return 1;})()`, { timeout: 15000 });
    console.log('  [大设置] ' + await p.js(M));
    await p.screenshot && 0;
    await p.shot('/home/ubuntu/novel-app/docs/监督人-顶部空白2.png');
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
