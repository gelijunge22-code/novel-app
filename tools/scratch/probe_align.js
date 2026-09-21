const fs = require('fs'); const { open, sleep } = require('/home/ubuntu/novel-app/tools/cdp');
let password = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json','utf8')).app_password;
(async () => {
  const s = await open({ port: 9393, width: 390, height: 844, settle: 900 });
  await s.nav('http://127.0.0.1:8899/?d=' + Date.now());
  await sleep(1500);
  await s.js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(password) + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(4000);
  await s.js("(async()=>{App.show('settings');await new Promise(r=>setTimeout(r,1200));return 1})()");
  await s.js("(()=>{const st=document.createElement('style');st.textContent='.settings-group .settings-row{margin-left:5px !important}';document.head.appendChild(st);return 1})()");
  const r = await s.js(`(()=>{
    const R=document.querySelector('#screen-settings');
    const groups=[...R.querySelectorAll('.settings-group')];
    return groups.slice(0,3).map(g=>{
      const pcs=getComputedStyle(g);
      const kids=[...g.children];
      return {cls:g.className, disp:pcs.display, dir:pcs.flexDirection, ai:pcs.alignItems, jc:pcs.justifyContent, ta:pcs.textAlign,
        padL:pcs.paddingLeft, bl:pcs.borderLeftWidth, n:kids.length,
        kids:kids.slice(0,4).map(k=>{const cs=getComputedStyle(k);const kr=k.getBoundingClientRect();const gr=g.getBoundingClientRect();
          return {cls:k.className, disp:cs.display, ml:cs.marginLeft, off:Math.round((kr.left-(gr.left+parseFloat(pcs.borderLeftWidth)+parseFloat(pcs.paddingLeft)))*10)/10};})};
    });
  })()`);
  console.log(JSON.stringify(r,null,1).slice(0,2500));
  s.close(); process.exit(0);
})();
