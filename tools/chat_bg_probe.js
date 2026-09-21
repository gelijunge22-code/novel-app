/* chat_bg_probe.js — 量：对话页顶上有多挤 + 底部按钮出框 + 自定义背景能不能换 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
(async () => {
  const p = await open({ port: 9402, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);

    console.log('=== 1. 进对话页 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const b=[...document.querySelectorAll('nav button,button')].find(x=>x.textContent.trim()==='对话');
      if(!b) return '找不到对话'; b.click(); await w(2800); return 'ok';})()`, { timeout: 20000 }));
    await sleep(1800);

    console.log('\n=== 2. 算占比：顶部固定区 / 消息区 ===');
    console.log(await p.js(`(()=>{
      const H=window.innerHeight;
      const body=document.querySelector('#chat-body');
      const br=body?body.getBoundingClientRect():null;
      /* 往上找第一个直接子块 */
      const out=[];
      const walk=(el,d)=>{ if(d>4)return; const st=getComputedStyle(el); const r=el.getBoundingClientRect();
        if(r.height>16) out.push({标签:el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className?'.'+String(el.className).split(' ')[0]:''),
          高:Math.round(r.height), 顶:Math.round(r.top), 占屏:Math.round(r.height/H*100)+'%', 位置:st.position});
        for(const c of el.children) walk(c,d+1); };
      walk(document.querySelector('#screen-chat')||document.body,0);
      return JSON.stringify({屏高:H, 消息区高:br?Math.round(br.height):'?', 消息区占屏:br?Math.round(br.height/H*100)+'%':'?', 前几块:out.slice(0,12)},null,1);})()`));

    console.log('\n=== 3. 底部那排按钮的文字出框 ===');
    console.log(await p.js(`(()=>{const o=[];
      for(const el of document.querySelectorAll('#screen-chat *')){
        const st=getComputedStyle(el); if(st.display==='none')continue;
        if(el.childElementCount)continue; const t=(el.textContent||'').trim(); if(!t)continue;
        const hx=el.scrollWidth-el.clientWidth, hy=el.scrollHeight-el.clientHeight;
        if(hx>2||hy>2) o.push({文字:t.slice(0,20), 选择器:el.tagName.toLowerCase()+(el.className?'.'+String(el.className).split(' ')[0]:''),
          横向超出:hx, 纵向超出:hy, 字号:st.fontSize, 可见宽:el.clientWidth, 需要宽:el.scrollWidth});
      }
      return o.length? JSON.stringify(o.slice(0,12),null,1):'（没有出框）';})()`));

    console.log('\n=== 4. 自定义背景：接口在不在 ===');
    console.log(await p.js(`(async()=>{const out={};
      for (const u of ['/api/appearance','/api/config/appearance','/api/appearance/get','/api/theme/bg']){
        try{ const r=await fetch(u,{credentials:'include'}); out[u]=r.status; }catch(e){ out[u]='ERR '+(e&&e.name); }
      }
      return JSON.stringify(out);})()`, { timeout: 20000 }));
    console.log('  appearance.js 里的接口名:');
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
