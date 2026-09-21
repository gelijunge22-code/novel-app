/* bg_real_probe.js — 传一张真图上去，看页面到底有没有把它当背景用 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
const SLUG = 'example-book';
(async () => {
  const p = await open({ port: 9404, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);

    console.log('=== 1. 在页面里造一张刺眼的图并上传（走真实接口）===');
    console.log(await p.js(`(async()=>{
      const c=document.createElement('canvas'); c.width=600; c.height=1000;
      const g=c.getContext('2d'); g.fillStyle='#1E5A9E'; g.fillRect(0,0,600,1000);
      g.fillStyle='#FFD24D'; for(let y=0;y<1000;y+=100) g.fillRect(0,y,600,14);
      const blob=await new Promise(r=>c.toBlob(r,'image/png'));
      const fd=new FormData(); fd.append('file', blob, 'probe.png');
      const r=await fetch('/api/appearance/bg?scope=global&slug=${SLUG}', {method:'POST', body:fd, headers: API.token()?{'x-token':API.token()}:{}});
      const t=await r.text();
      return 'HTTP '+r.status+'  '+t.slice(0,160);})()`, { timeout: 30000 }));

    console.log('\n=== 2. 重新打开页面，看背景有没有应用 ===');
    await p.nav('http://127.0.0.1:8899/'); await sleep(4500);
    console.log(await p.js(`(()=>{
      const out=[];
      for (const el of document.querySelectorAll('*')) {
        const st=getComputedStyle(el);
        const bi=st.backgroundImage||'';
        if (bi && bi!=='none' && /appearance|bg\/file|data:image/.test(bi))
          out.push({标签:el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className?'.'+String(el.className).split(' ')[0]:''),
                    背景:bi.slice(0,90), 尺寸:st.backgroundSize, 透明:st.opacity, 可见:st.display});
      }
      const bd=getComputedStyle(document.body).backgroundImage;
      const html=getComputedStyle(document.documentElement).backgroundImage;
      return JSON.stringify({ body背景:bd.slice(0,80), html背景:html.slice(0,80), 找到并应用背景的元素数:out.length, 明细:out.slice(0,5) },null,1);})()`));

    console.log('\n=== 3. 状态确认 ===');
    console.log(await p.js(`fetch('/api/appearance/bg?slug=${SLUG}',{credentials:'include'}).then(r=>r.json()).then(d=>JSON.stringify({global:d.global,effective:d.effective}))`, { timeout: 20000 }));

    console.log('\n=== 4. 收尾：删掉我传的图（还原用户状态）===');
    console.log(await p.js(`fetch('/api/appearance/bg?scope=global&slug=${SLUG}',{method:'DELETE',credentials:'include',headers:API.token()?{'x-token':API.token()}:{}}).then(r=>r.text())`, { timeout: 20000 }));
    console.log(await p.js(`fetch('/api/appearance/bg?slug=${SLUG}',{credentials:'include'}).then(r=>r.json()).then(d=>'撤完 has='+d.effective.has)`, { timeout: 20000 }));
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
