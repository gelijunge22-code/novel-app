/* dz_probe2.js — 只量「大设置」里那两处被报"真出框"的地方：
   ① 切页动画那 4 等分按钮（"无动画"文字 39px / 按钮 31px？）
   ② #apk-slot 里的 span.muted（clientWidth 0 —— 到底是真出框还是 inline 元素的老毛病）
   量完把那一行放大截图，肉眼核。
*/
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
const readPassword = () => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json','utf8')).app_password||''; } catch(e){ return ''; } };

const SCAN = `(() => {
  const out = { row: null, buttons: [], apk: null };
  const txt = (el) => (el.textContent||'').trim();
  const tbox = (el) => { const rg=document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect(); };
  /* ① 切页动画那一行 */
  const rows = Array.prototype.slice.call(document.querySelectorAll('#screen-settings .settings-row'));
  const row = rows.find(r => (r.querySelector('.k')||{}).textContent === '切页动画');
  if (row) {
    const rr = row.getBoundingClientRect(), gr = row.querySelector('.seg.grid').getBoundingClientRect();
    const kr = row.querySelector('.k').getBoundingClientRect();
    out.row = { rowW: Math.round(rr.width), label: txt(row.querySelector('.k')),
      labelW: Math.round(kr.width), labelRight: Math.round(kr.right),
      gridLeft: Math.round(gr.left), gridW: Math.round(gr.width),
      gapLabelGrid: Math.round(gr.left - kr.right) };
    row.querySelectorAll('.seg.grid button').forEach((b) => {
      const cs = getComputedStyle(b); const tb = tbox(b); const br = b.getBoundingClientRect();
      out.buttons.push({ 文字: txt(b), 按钮宽: Math.round(br.width), clientWidth: b.clientWidth,
        scrollWidth: b.scrollWidth, 文字真实宽: Math.round(tb.width),
        padding: cs.paddingLeft + ' ' + cs.paddingRight, 字号: cs.fontSize,
        whiteSpace: cs.whiteSpace, overflow: cs.overflow, 文字比框宽: Math.round(tb.width - b.clientWidth),
        文字有没有出按钮框: Math.round(Math.max(0, tb.right - br.right)) });
    });
  }
  /* ② #apk-slot 那个 span.muted */
  const slot = document.querySelector('#apk-slot');
  if (slot) {
    const sp = slot.querySelector('span.muted');
    const dump = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), cls: String(el.className),
        display: cs.display, clientW: el.clientWidth, clientH: el.clientHeight,
        rectW: Math.round(r.width), rectH: Math.round(r.height),
        scrollW: el.scrollWidth, overflow: cs.overflow, ws: cs.whiteSpace }; };
    out.apk = { slot: dump(slot), span: sp ? dump(sp) : null,
      spanText: sp ? txt(sp) : '', spanParent: sp ? dump(sp.parentElement) : null,
      spanTextW: sp ? Math.round(tbox(sp).width) : 0 };
  }
  return out;
})()`;

(async()=>{
  const p=await open({port:9412,width:390,height:844,settle:1200});
  try{
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);
    await p.js(`(async()=>{const w=m=>new Promise(r=>setTimeout(r,m));App.show('settings');await w(1600);return 1})()`,{timeout:20000});
    const r = await p.js(SCAN,{timeout:40000});
    console.log(JSON.stringify(r,null,1));
    /* 把「切页动画」那一行放大截一张（clip 到那一行 + 上下各留 8px） */
    const box = await p.js(`(() => { const rows=[].slice.call(document.querySelectorAll('#screen-settings .settings-row'));
      const row=rows.find(r=>(r.querySelector('.k')||{}).textContent==='切页动画');
      if(!row) return null; row.scrollIntoView({block:'center'}); const b=row.getBoundingClientRect();
      return {x:b.left-4,y:b.top-8,w:b.width+8,h:b.height+16}; })()`,{timeout:20000});
    if (box) {
      await sleep(300);
      const b2 = await p.js(`(() => { const rows=[].slice.call(document.querySelectorAll('#screen-settings .settings-row'));
        const row=rows.find(r=>(r.querySelector('.k')||{}).textContent==='切页动画'); const b=row.getBoundingClientRect();
        return {x:b.left-4,y:b.top-8,w:b.width+8,h:b.height+16}; })()`,{timeout:20000});
      await p.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:4,mobile:true});
      await sleep(200);
      const shot = await p.send('Page.captureScreenshot',{format:'png',clip:{x:b2.x,y:b2.y,width:b2.w,height:b2.h,scale:4}});
      if (shot.result && shot.result.data) fs.writeFileSync('/home/ubuntu/novel-app/docs/监督人-大设置-切页动画行-放大.png', Buffer.from(shot.result.data,'base64'));
      console.log('放大截图 → docs/监督人-大设置-切页动画行-放大.png', JSON.stringify(b2));
    }
  }catch(e){console.log('!!',e.message);}finally{await p.close();}
})();
