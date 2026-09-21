/* ============================================================
   e2e-chatmodels.js — 「AI 对话的专门设置」实机判据（模型与渠道）

   用户原话：「**AI 对话也得有专门的设置**，可以**设置一些模型商**之类的，
              **就是可以自己增加，然后自己拉取**这种」，以及「能选**默认模型 / 备用模型**」。

   证四件事（每条都能报红）：
     甲 对话页能打开「模型与渠道」，四个口径都在：默认 / 备用 / 这本书 / 这条会话；
     乙 **自己加渠道**：填名字+地址+密钥 → 保存成功、出现在渠道清单里；
     丙 **自己拉取**：点「拉取模型」→ 界面必须报出**真实数字**（这台假渠道里就是 2 个），
        并且这 2 个模型真的进了库（`/config/models/library` 能查到）；
     丁 备用模型能设、能取消（写进 `models.fallback`），**收尾还原**，绝不改坏用户设置。

   跑法：
     node tools/e2e-chatmodels.js                          # 正常
     CHATMODELS_FORCE=stub node tools/e2e-chatmodels.js    # 反证：让"拉取"假装成功但一个也没存 → 丙 必须红
   产出：docs/对话模型设置实测.json（反证写 -反证-<FORCE>.json）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.CHATMODELS_FORCE || '';
const OUT = path.join(ROOT, 'docs', FORCE ? ('对话模型设置实测-反证-' + FORCE + '.json')
  : '对话模型设置实测.json');
const NAME = '判据假渠道';

(async () => {
  /* 假渠道：一个只会回 OpenAI 式 /models 的本机服务 */
  const srv = http.createServer((req, res) => {
    if (/\/models(\?|$)/.test(req.url)) {
      const body = JSON.stringify({ data: [{ id: 'fake-model-a' }, { id: 'fake-model-b' }] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const s = await open({ port: 9386 });
  const fails = [];
  const steps = [];
  const bad = (m) => { fails.push(m); console.log('  ✗ ' + m); };
  const good = (m) => console.log('  ✓ ' + m);

  await s.nav('file://' + ROOT + '/apk/assets/www/index.html');
  await sleep(1500);
  await s.js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
    ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(1600);
  const sp = await s.js(`(async () => { for (let i = 0; i < 90; i++) {
      const e = document.getElementById('splash');
      if (!e || e.classList.contains('gone') || getComputedStyle(e).display === 'none') return true;
      await new Promise((r) => setTimeout(r, 100)); } return false; })()`, 45000);
  if (!sp) { console.error('启动页没退场 —— 停'); process.exit(1); }

  if (FORCE === 'stub') {
    /* 反证：让"拉取模型"假装成功（其实一个也没存）→ 丙 必须报红 */
    await s.js(`(() => { const old = API.modelsPull;
      API.modelsPull = async function () { return { ok: true, found: 0, saved: 0, url: 'http://stub' }; };
      window.__pullOld = old; return 1; })()`);
  }

  /* ── 甲：面板打得开、四个口径都在 ── */
  const a = await s.js(`(async () => {
    App.show('chat'); await new Promise((r) => setTimeout(r, 1500));
    Chat.modelsSetup(); await new Promise((r) => setTimeout(r, 1600));
    const body = document.querySelector('#ms-setup-body') || document;
    const labels = [...body.querySelectorAll('.settings-row .k b')].map((n) => n.textContent.trim());
    const has = (t) => labels.some((x) => x.indexOf(t) >= 0);
    return { labels: labels, ok: has('默认模型') && has('备用模型') && has('这本书') && has('这条会话'),
             rows: body.querySelectorAll('.settings-row').length,
             hasAdd: !!body.querySelector('[data-act="add-prov"]') }; })()`);
  const okA = !!(a && a.ok && a.hasAdd);
  steps.push({ step: '甲 打开「模型与渠道」', expect: '默认/备用/这本书/这条会话 四行 + 加渠道入口', res: a, ok: okA });
  if (okA) good('甲 面板在，四行齐：' + a.labels.join(' / ')); else bad('甲 面板不全：' + JSON.stringify(a));

  /* ── 乙 + 丙：加渠道 → 拉取模型 → 数字必须是真的 ── */
  const b = await s.js(`(async () => {
    const add = document.querySelector('[data-act="add-prov"]');
    if (!add) return { err: '没有「加一个渠道」' };
    add.click(); await new Promise((r) => setTimeout(r, 700));
    const set = (sel, v) => { const n = document.querySelector(sel); if (!n) return false;
      n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); return true; };
    if (!set('#ap-name', ${JSON.stringify(NAME)})) return { err: '没有名字输入框' };
    set('#ap-base', 'http://127.0.0.1:${port}/v1');
    set('#ap-key', 'sk-probe');
    const btn = document.querySelector('[data-act="save-pull"]');
    if (!btn) return { err: '没有「保存并拉取模型」' };
    btn.click();
    let txt = '';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const o = document.querySelector('#ap-out');
      txt = o ? (o.textContent || '').trim() : '';
      if (/存了|失败|错误/.test(txt)) break;
    }
    return { out: txt }; })()`, 45000);
  /* 只认数字，不认文案 —— 第 31 轮实测：界面把"拉到了 N 个"改成"找到 N 个"（文案整改）之后，
     这条正则对不上，**功能明明是好的却报红**（判据自己的病）。现在把两个数抠出来比。 */
  const nums = String((b && b.out) || '').match(/(\d+)\s*个/g) || [];
  const nFound = nums[0] ? parseInt(nums[0], 10) : -1;
  const nSaved = nums[1] ? parseInt(nums[1], 10) : -1;
  const pulled = !!b && !b.err && nFound === 2 && nSaved === 2;
  steps.push({ step: '乙/丙 加渠道 + 拉取模型', expect: '保存成功、拉到 2 个并真的存 2 个',
               res: { out: (b && b.out) || '', found: nFound, saved: nSaved, err: (b && b.err) || '' }, ok: pulled });
  if (pulled) good('乙/丙 ' + b.out);
  else bad('乙/丙 拉取结果不对（' + JSON.stringify(b) + '）—— 光"点了没报错"不算数，数字必须是真的');

  /* 库里真有这两个模型吗（换一条独立路径核对，不只看界面文案） */
  /* 独立路径核对（不只看界面文案）：**走 API.nb**，它能补绝对地址 ——
     原来这里用裸 `fetch('/api/...')`，在 file:// 页面下永远失败 → 这条判据一直"跳过"（等于没有）。 */
  const lib = await s.js(`(async () => {
    try {
      const q = await API.nb('api/config/models/library');
      const ids = (q.models || []).map((m) => m.id);
      return { a: ids.indexOf('fake-model-a') >= 0, b: ids.indexOf('fake-model-b') >= 0,
               n: ids.length };
    } catch (e) { return { via: 'API.nb 失败：' + e.message, a: false, b: false }; }
  })()`);
  const okLib = !!(lib && lib.a && lib.b);
  steps.push({ step: '丙b 库里真查到这两个模型', expect: 'library 里能查到', res: lib, ok: okLib });
  if (okLib) good('丙b library 里确实有 fake-model-a / fake-model-b');
  else if (lib && lib.via) bad('丙b ' + lib.via + '（这条路走不通就是空判据 —— 不许"跳过"混过去）');
  else bad('丙b 库里没有这两个模型：' + JSON.stringify(lib));

  /* ── 丁：备用模型能设、能取消 ── */
  const d = await s.js(`(async () => {
    const out0 = await API.nb('api/config/models/providers');
    const before = out0.fallback || '';
    /* 刚加完渠道，抽屉还停在「加一个渠道」那一屏 —— 先回到设置那一屏再找那一行 */
    Chat.modelsSetup(); await new Promise((r) => setTimeout(r, 1500));
    const rows = [...document.querySelectorAll('#ms-setup-body .settings-row')];
    const fbRow = rows.find((r) => /备用模型/.test(r.textContent));
    const btn = fbRow && fbRow.querySelector('[data-role="fb"]');
    if (!btn) return { err: '没有备用模型那一行' };
    await API.nb('api/config/models/fallback', { method: 'POST', body: { modelKey: '渠道-shim/[渠道]某模型' } });
    const mid = await API.nb('api/config/models/providers');
    const setOK = (mid.fallback || '') === '渠道-shim/[渠道]某模型';
    /* 还原成"没设"（用户本来就没设备用模型） */
    await API.nb('api/config/models/fallback', { method: 'POST', body: { modelKey: before } });
    const after = await API.nb('api/config/models/providers');
    return { before: before, setOK: setOK, restored: (after.fallback || '') === before }; })()`);
  const okD = !!(d && d.setOK && d.restored);
  steps.push({ step: '丁 备用模型可设可撤（且还原）', expect: '设得上、撤得掉、不留痕迹', res: d, ok: okD });
  if (okD) good('丁 备用模型设得上也撤得掉（原值 "' + (d.before || '（空）') + '" 已还原）');
  else bad('丁 备用模型没弄对：' + JSON.stringify(d));

  /* 收尾：删掉判据自己加的渠道（用户数据一条不碰） */
  const clean = await s.js(`(async () => {
    const d = await API.modelsProviders();
    const hit = (d.providers || []).filter((p) => p.name === ${JSON.stringify(NAME)});
    let n = 0;
    for (const p of hit) { try { await API.providerDelete(p.id); n++; } catch (e) {} }
    return n; })()`).catch(() => 0);
  console.log('  · 收尾：删掉判据自己加的渠道 ' + (clean || 0) + ' 个');

  await s.shot(path.join(ROOT, 'docs/前端截图', 'r27-chatmodels-' + (FORCE || '改后') + '.png'));
  const rep = { at: new Date().toISOString(), force: FORCE || '（正常）', steps, fails };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  console.log('\n' + (fails.length ? ('有红 ❌ ' + fails.join('；')) : '全过 ✅') + ' → ' + path.relative(ROOT, OUT));
  srv.close();
  s.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
