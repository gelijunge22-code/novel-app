/* verify_worldfacts.js — 走真实路径验：世界面板 → 整理 → 从设定里认事实 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
(async () => {
  const p = await open({ port: 9408, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4500);

    console.log('=== 1. 打开书 → 工具 → 世界 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const c=document.querySelector('#shelf-list .book-card'); if(c){c.click(); await w(3400);}
      const tb=[...document.querySelectorAll('nav button,button')].find(x=>x.textContent.trim()==='工具');
      if(tb){tb.click(); await w(2200);}
      const wl=[...document.querySelectorAll('button')].find(x=>/^世界/.test(x.textContent.trim()));
      if(wl){wl.click(); await w(2600); return '进了世界：'+document.body.innerText.slice(0,80).replace(/\\n/g,' | ');}
      return '找不到世界入口；屏上按钮: '+[...document.querySelectorAll('button')].map(x=>x.textContent.trim()).slice(0,30).join('/');})()`, { timeout: 30000 }));

    console.log('\n=== 2. 切到「整理」页签，找「从设定里认事实」按钮 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const t=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='整理');
      if(t){t.click(); await w(1800);}
      const b=document.querySelector('[data-fx]');
      return b ? '✅ 找到按钮：'+b.textContent.trim() : '❌ 没找到；当前按钮: '+[...document.querySelectorAll('button')].map(x=>x.textContent.trim()).filter(Boolean).slice(0,26).join('/');})()`, { timeout: 25000 }));

    console.log('\n=== 3. 点它，看候选出不出来 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const b=document.querySelector('[data-fx]'); if(!b) return '没按钮';
      b.click(); await w(9000);
      const boxes=document.querySelectorAll('input[data-f]');
      const save=document.querySelector('[data-save]');
      const h2=document.querySelector('.st-h');
      return JSON.stringify({
        标题: h2? h2.textContent.trim().slice(0,50):'(无)',
        勾选框数: boxes.length,
        有收下按钮: !!save,
        前几条: [...boxes].slice(0,4).map(x=>x.parentElement.textContent.trim().slice(0,52))
      },null,1);})()`, { timeout: 40000 }));
    await p.shot('/home/ubuntu/novel-app/docs/监督人-认事实.png');
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
