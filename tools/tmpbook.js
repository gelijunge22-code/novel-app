/* 临时书：给"需要书架上有两本书"的自测用（建完就删，绝不动用户的稿子）。
   用法：node tools/tmpbook.js new            → 打印 slug
         node tools/tmpbook.js del <slug>    → 删掉（进回收站） */
const { readPassword } = require('./preflight');
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
(async () => {
  const cmd = process.argv[2] || 'new';
  const r = await fetch(BASE + 'nb/api/app/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: readPassword() }) });
  const tk = (await r.json()).token || '';
  const H = { 'content-type': 'application/json', 'x-token': tk };
  if (cmd === 'new') {
    const j = await (await fetch(BASE + 'nb/api/projects', { method: 'POST', headers: H,
      body: JSON.stringify({ title: '自测·切书用-' + Date.now().toString().slice(-6), summary: 'e2e 用完就删' }) })).json();
    console.log(j.slug || '');
  } else {
    const j = await (await fetch(BASE + 'nb/api/book/delete', { method: 'POST', headers: H,
      body: JSON.stringify({ slug: process.argv[3] || '' }) })).json();
    console.log(JSON.stringify(j).slice(0, 120));
  }
})();
