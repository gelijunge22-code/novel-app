/* dz_probe3.js — 放大看「安卓安装包」那一行：span.muted 是不是真的跑出自己的框 / 压到按钮 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
const readPassword = () => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json','utf8')).app_password||''; } catch(e){ return ''; } };
(async()=>{
  const p=await open({port:9413,width:390,height:844,settle:1200});
  try{
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);
    await p.js(`(async()=>{const w=m=>new Promise(r=>setTimeout(r,m));App.show('settings');await w(1800);return 1})()`,{timeout:20000});
    const info = await p.js(`(() => {
      const rows=[].slice.call(document.querySelectorAll('#screen-settings .settings-row'));
      const row=rows.find(r=>(r.querySelector('.k')||{}).textContent.indexOf('安卓安装包')>=0);
      if(!row) return null;
      row.scrollIntoView({block:'center'});
      const b=row.getBoundingClientRect();
      const slot=row.querySelector('#apk-slot'), btn=row.querySelector('#do-apk');
      const sb=slot.getBoundingClientRect(), bb=btn.getBoundingClientRect();
      const sp=slot.querySelector('span.muted'); const tb=(()=>{const rg=document.createRange();rg.selectNodeContents(sp);return rg.getBoundingClientRect()})();
      return {row:{l:b.left,r:b.right,w:b.width}, slot:{l:sb.left,r:sb.right,w:sb.width,scrollW:slot.scrollWidth,clientW:slot.clientWidth},
        btn:{l:bb.left,r:bb.right,w:bb.width}, 文字:{l:tb.left,r:tb.right,w:tb.width,right:tb.right},
        文字右超过slot右: Math.round(tb.right-sb.right), 文字右超过行右: Math.round(tb.right-b.right),
        点: {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2),h:Math.round(b.height)}}; })()`,{timeout:20000});
    console.log(JSON.stringify(info,null,1));
    if (info) {
      await p.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:4,mobile:true});
      await sleep(250);
      const b2 = await p.js(`(() => { const rows=[].slice.call(document.querySelectorAll('#screen-settings .settings-row'));
        const row=rows.find(r=>(r.querySelector('.k')||{}).textContent.indexOf('安卓安装包')>=0); const r2=row.getBoundingClientRect();
        return {x:r2.left-2,y:r2.top-2,width:r2.width+4,height:r2.height+4}; })()`,{timeout:20000});
      const sh=await p.send('Page.captureScreenshot',{format:'png',clip:{x:b2.x,y:b2.y,width:b2.width,height:b2.height,scale:4}});
      if (sh.result&&sh.result.data) fs.writeFileSync('/home/ubuntu/novel-app/docs/监督人-大设置-安装包行-放大.png',Buffer.from(sh.result.data,'base64'));
      console.log('截图 → docs/监督人-大设置-安装包行-放大.png');
    }
  }catch(e){console.log('!!',e.message);}finally{await p.close();}
})();
