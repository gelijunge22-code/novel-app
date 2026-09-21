const fs = require('fs'); const { open, sleep } = require('/home/ubuntu/novel-app/tools/cdp');
let password = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json','utf8')).app_password;
(async () => {
  const s = await open({ port: 9395, width: 390, height: 844, settle: 900 });
  await s.nav('http://127.0.0.1:8899/?d=' + Date.now());
  await sleep(1500);
  await s.js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(password) + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(4000);
  await s.js("(async()=>{App.show('shelf');await new Promise(r=>setTimeout(r,700));document.querySelector('#shelf-list .book-card').click();await new Promise(r=>setTimeout(r,3000));return 1})()");
  await s.js("(async()=>{document.querySelector('#reader-foot .rd-fb[aria-label=\"设置\"]').click();await new Promise(r=>setTimeout(r,900));return 1})()");
  const r = await s.js(`(()=>{
    const P=document.getElementById('rd-quick');
    const out=[];
    const walk=(el,d)=>{ if(d>4) return; const cs=getComputedStyle(el);
      const b=el.getBoundingClientRect();
      out.push({d:d, tag:el.tagName, cls:(el.className||'').toString().slice(0,40),
        fs:cs.fontSize, fw:cs.fontWeight, zoom:cs.zoom, tr:cs.transform, w:Math.round(b.width)});
      [...el.children].slice(0,6).forEach(c=>walk(c,d+1)); };
    walk(P,0);
    const h3=[...document.querySelectorAll('#rd-quick-body h3')][0];
    return {chain:out.slice(0,18), h3: h3? {fs:getComputedStyle(h3).fontSize, fw:getComputedStyle(h3).fontWeight, cls:h3.className,
      inner:h3.parentElement.className, bodyZoom:getComputedStyle(document.getElementById('rd-quick-body')).zoom,
      panelZoom:getComputedStyle(P).zoom, panelTr:getComputedStyle(P).transform}: null};
  })()`);
  console.log(JSON.stringify(r,null,1));
  s.close(); process.exit(0);
})();
