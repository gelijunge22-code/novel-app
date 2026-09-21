/* two_probe.js — 亲测两件事：① 对话页抽屉里模型那行的字出框 ② 大设置里的自定义背景能不能用 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
const SCAN = `(() => { const o=[];
  for (const el of document.querySelectorAll('*')) {
    const st=getComputedStyle(el); if(st.display==='none'||st.visibility==='hidden')continue;
    if(el.childElementCount)continue; const t=(el.textContent||'').trim(); if(!t)continue;
    const r=el.getBoundingClientRect(); if(r.width<6||r.height<6)continue;
    const hx=el.scrollWidth-el.clientWidth, hy=el.scrollHeight-el.clientHeight;
    if(hx>2||hy>2) o.push({文字:t.slice(0,26), 选择器:el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className?'.'+String(el.className).split(' ')[0]:''),
      横向超出:hx, 纵向超出:hy, 字号:st.fontSize, 可见宽:el.clientWidth, 需要宽:el.scrollWidth});
  } return o.slice(0,16); })()`;

(async () => {
  const p = await open({ port: 9403, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);

    console.log('=== ① 对话页：展开抽屉，量模型那行 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const b=[...document.querySelectorAll('nav button,button')].find(x=>x.textContent.trim()==='对话');
      if(b){b.click(); await w(2800);}
      const up=document.querySelector('[data-act="chat-fold"],[class*=fold],[class*=drawer],#chat-more');
      const cands=[...document.querySelectorAll('button')].filter(x=>/⌃|⌄|展开|更多/.test(x.textContent)||x.dataset.act);
      return '已进对话；可能能展开的按钮: '+cands.map(x=>(x.dataset.act||x.id||x.className)+'「'+x.textContent.trim().slice(0,8)+'」').slice(0,10).join(' / ');})()`, { timeout: 25000 }));
    await sleep(1500);
    console.log('  展开前出框:', JSON.stringify(await p.js(SCAN)));

    console.log('\n  点展开（试试那几个可能的按钮）:');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const t=[...document.querySelectorAll('#screen-chat button,#screen-chat [data-act]')];
      const btn=t.find(x=>/展开|⌃|模型|设置/.test(x.textContent)||/fold|drawer|settings|model/i.test(x.dataset.act||''));
      if(!btn) return '没找到展开按钮';
      btn.click(); await w(1600);
      return '点了: '+(btn.dataset.act||btn.id||btn.className)+'「'+btn.textContent.trim().slice(0,10)+'」';})()`, { timeout: 20000 }));
    await sleep(1500);
    console.log('  展开后出框:', JSON.stringify(await p.js(SCAN), null, 1));
    await p.shot('/home/ubuntu/novel-app/docs/监督人-对话-抽屉展开.png');

    console.log('\n=== ② 大设置：找自定义背景那一段 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const m=document.getElementById('btn-shelf-menu'); if(!m) return '找不到设置入口';
      m.click(); await w(2400);
      const t=[...document.querySelectorAll('button,div,a')].filter(x=>/背景|外观/.test(x.textContent)&&x.getBoundingClientRect().width>20);
      return '设置里跟"背景/外观"有关的元素: '+t.map(x=>(x.tagName+'/'+(x.id||x.className||'').split(' ')[0]+'「'+x.textContent.trim().slice(0,16)+'」')).slice(0,10).join(' | ');})()`, { timeout: 25000 }));
    await sleep(1500);
    console.log(await p.js(`(()=>{const o=[];const walk=(el,d)=>{if(d>8)return;
      const t=(el.textContent||'').trim();
      if(/自定义背景|背景图|上传|换背景/.test(t)&&el.children.length<3) o.push({标签:el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className?'.'+String(el.className).split(' ')[0]:''), 文字:t.slice(0,40)});
      for(const c of el.children) walk(c,d+1);}; walk(document.body,0);
      return '  '+(o.length?JSON.stringify(o.slice(0,10),null,1):'（设置里根本没有"自定义背景"这几个字）');})()`));
    await p.shot('/home/ubuntu/novel-app/docs/监督人-大设置-背景区.png');
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
