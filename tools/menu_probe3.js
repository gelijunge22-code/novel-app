/* menu_probe3.js — 定位「点完全书搜索面板高度=0」的机理：三种路径对比 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function pw() { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json','utf8')).app_password||''; } catch(e){ return ''; } }
const SLUG = 'example-book';
const H = `(()=>{const s=document.querySelector('.sheet-panel'); if(!s) return '无面板';
  const r=s.getBoundingClientRect();
  return '高='+Math.round(r.height)+' hidden='+document.getElementById('sheet').classList.contains('hidden')
    +' open='+document.getElementById('sheet').classList.contains('sheet-open')
    +' 有搜索框='+!!document.querySelector('#bs-q');})()`;
(async () => {
  const p = await open({ port: 9398, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3000);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(pw())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4000);

    // 装一个探针：数 popstate 到底被谁消费了
    await p.js(`window.__pop=[];window.addEventListener('popstate',()=>{window.__pop.push({t:Date.now(),open:!!document.querySelector('#bs-q'),overlayOpen:!(document.getElementById('sheet').classList.contains('hidden'))});});'ok'`);

    console.log('=== A. 打开菜单 → 点「全书搜索」（现在的代码）===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      Shelf.menu('${SLUG}'); await w(1200);
      [...document.querySelectorAll('[data-a]')].find(x=>x.dataset.a==='search').click();
      await w(1500); return ${H};})()`, {timeout:25000}));
    console.log('   popstate 记录数 = ' + await p.js(`String(window.__pop.length)`));
    await p.js(`(()=>{if(window.App&&App.closeSheet) App.closeSheet(); document.getElementById('sheet').classList.add('hidden'); return '清零';})()`);
    await sleep(600);

    console.log('\n=== B. 直接开搜索（没有任何"先关再开"）===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      Shelf.search('${SLUG}'); await w(1500); return ${H};})()`, {timeout:25000}));
    console.log('   popstate 记录数 = ' + await p.js(`String(window.__pop.length)`));

    console.log('\n=== C. 只回到搜索面板关掉 / 再走一次 A 看是否稳定 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      Shelf.menu('${SLUG}'); await w(1200);
      [...document.querySelectorAll('[data-a]')].find(x=>x.dataset.a==='search').click();
      await w(3000); return ${H};})()`, {timeout:25000}));
    console.log('   popstate 记录数 = ' + await p.js(`String(window.__pop.length)`));
    console.log('   最后 3 条 popstate = ' + await p.js(`JSON.stringify(window.__pop.slice(-3))`));
  } finally { await p.close(); }
})();
