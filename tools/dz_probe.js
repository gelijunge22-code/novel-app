/* dz_probe.js — 只量「大设置」：证明那 16 条是假红（热区伪元素 ::after 外溢），不是真出框 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
const readPassword = () => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json','utf8')).app_password||''; } catch(e){ return ''; } };
const SCAN = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('#screen-settings *')) {
    const cs = getComputedStyle(el);
    if (cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0') continue;
    if (el.childElementCount) continue;
    const txt=(el.textContent||'').trim(); if(!txt) continue;
    const r=el.getBoundingClientRect(); if(r.width<6||r.height<6) continue;
    const rg=document.createRange(); rg.selectNodeContents(el);
    const tb=rg.getBoundingClientRect();
    // 伪元素 ::after（热区）外溢量
    const aAfter=getComputedStyle(el,'::after');
    out.push({
      文字: txt.slice(0,12),
      选择器: el.tagName.toLowerCase()+(el.className?'.'+String(el.className).split(' ')[0]:''),
      字号: cs.fontSize,
      clientWidth: el.clientWidth, clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight,
      文字真实宽: Math.round(tb.width), 文字真实高: Math.round(tb.height),
      文字比框宽: Math.round(tb.width - el.clientWidth),
      文字比框高: Math.round(tb.height - el.clientHeight),
      热区: aAfter.content==='""'?aAfter.inset:'' });
  }
  return out;
})()`;
(async()=>{
  const p=await open({port:9411,width:390,height:844,settle:1200});
  try{
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);
    await p.js(`(async()=>{const w=m=>new Promise(r=>setTimeout(r,m));App.show('settings');await w(1600);return 1})()`,{timeout:20000});
    const rows=await p.js(SCAN,{timeout:40000});
    const real=rows.filter(x=>x.文字比框宽>2||x.文字比框高>2);
    const fake=rows.filter(x=>(x.scrollWidth-x.clientWidth)>2&&x.文字比框宽<=2);
    console.log('量到元素数:',rows.length);
    console.log('\n=== 真·文字放不进自己的框（Range 量的）:',real.length,'处 ===');
    console.log(JSON.stringify(real.slice(0,20),null,1));
    console.log('\n=== 假红（只有 scrollWidth 超，文字本身放得下）:',fake.length,'处 ===');
    console.log(JSON.stringify(fake.slice(0,20),null,1));
    await p.shot('/home/ubuntu/novel-app/docs/监督人-大设置-现状.png');
  }catch(e){console.log('!!',e.message);}finally{await p.close();}
})();
