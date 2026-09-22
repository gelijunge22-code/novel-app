/* ============================================================
   authoring.js — 长在工具面板上的那几个：

     ① 故事线   —— **第 36 轮按用户拍板整个换了内容**：
                    这个名字一个字都不改，但点开是**大纲**（这本书要往哪走、什么调子、
                    防忘 / 防防跑偏 / 防 OOC；用户改的以用户为准，AI 不会覆盖）。
                    大纲那一块本身在 js/outline.js —— **一份实现、两个入口**
                    （「故事线」工具 + 「剧情」工具的「剧情线」页签），不许两套并存。
                    原来那份"一章一句话"的章节速览**没有丢**，收在同一页的**折叠区**里
                    （它就是防忘那一半：一眼看清写到哪了，点一行去写那一章）。
     ⑤ 章节顺序 —— 手机上给长篇插一章 / 调顺序，**细纲/出场角色/关键事件跟着走**

   另外三个长在别的界面上，就写在那个界面自己的文件里，不搬到这里来当"第二套实现"：
     · 常用指令（一键把话说完）→ chat.js，因为它长在对话框上
     · 小批注（给自己留的待办）→ reader.js，因为它长在正文选中上
     · 点一下看设定         → reader.js，因为它长在正文的文字上
   ============================================================ */
(function () {
  const U = () => window.Tools && window.Tools.ui;
  const qs = (o) => Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const get = (p, q) => window.API.nb(p + (q ? '?' + qs(q) : ''));
  const post = (p, b) => window.API.nb(p, { method: 'POST', body: b || {} });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (n) => '<span class="tr-ico">' + window.iconHtml(n) + '</span>';
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const hap = () => { try { App.haptic(6); } catch (e) {} };
  const toast = (m) => { try { App.toast(m); } catch (e) {} };

  /* ── 两个面板共用的一份"章节清单"（同一份实现，不许各写一套） ── */
  async function chapters(slug) {
    return await get('/api/storyline', { slug });
  }

  function head(d) {
    const bits = [d.count + ' 章', '共 ' + num(d.words) + ' 字'];
    if (d.emptyCount) bits.push('<b>' + d.emptyCount + ' 章还是空的</b>');
    return '<div class="t-hint">' + bits.join(' · ') + '</div>';
  }

  /* ══════════════════ ① 故事线 = 大纲（第 36 轮换的内容） ══════════════════
     页面从上到下就两块：
       · 大纲（js/outline.js，主区）—— 加/改/删，每行写着"谁定的"
       · 章节速览（折叠，默认收起）—— 一章一句话，防忘用；点一行去写那一章
     为什么把速览收进折叠区而不是删掉：此处说明是"把故事线的用处改成大纲"，
     不是"把章节速览这个能力从产品里拿掉"（只增不减）。收起来 = 一打开看到的还是大纲。 */
  /* 一行一章（章节速览的一行）：章号 + 章名 + 一句话 + 「自动 / 我写的」 */
  function rowHtml(it, i) {
    return '<div class="al-row" data-path="' + esc(it.path) + '">' +
      '<div class="al-no">' + (it.no || i + 1) + '</div>' +
      '<div class="al-main">' +
        '<div class="al-title">' + esc(it.title) + '</div>' +
        '<div class="al-sum' + (it.mine ? ' mine' : '') + '" data-edit="' + esc(it.path) + '">' +
          (it.summary ? esc(it.summary) : '<i>这章还没正文</i>') +
          (it.mine ? '<b class="al-tag">我写的</b>' : '<b class="al-tag auto">自动</b>') +
        '</div>' +
      '</div>' +
      '<div class="al-side"><span>' + (it.empty ? '空' : num(it.words) + ' 字') + '</span>' +
        '<span class="al-go">' + window.iconHtml('chevron') + '</span></div>' +
      '</div>';
  }

  function capsHtml(items) {
    return items.length
      ? '<div class="al-list">' + items.map(rowHtml).join('') + '</div>'
      : '<div class="t-empty">这本书还没有章节。</div>';
  }

  /* 章节速览：读 /api/storyline（后端一个字没改），改一句话写回同一路接口 */
  async function capsHome(host, slug) {
    U().loading(host, '读章节…');
    let d;
    try { d = await chapters(slug); }
    catch (e) { U().empty(host, '读不到章节：' + e.message); return; }
    const items = (d && d.items) || [];
    if (!items.length) { U().empty(host, '这本书还没有章节', 'book'); return; }
    host.innerHTML = head(d) + capsHtml(items);
    host.querySelectorAll('.al-row').forEach((row) => {
      row.onclick = async (e) => {
        const edit = e.target.closest('[data-edit]');
        if (edit) {
          e.stopPropagation();
          hap();
          const cur = items.find((x) => x.path === edit.dataset.edit) || {};
          const v = await U().ask('这一章发生了什么（一句话）', cur.summary || '', {
            placeholder: '例：主角在雪夜捡到一枚断刃，被巡夜人发现', host });
          if (v === null || v === undefined) return;
          try {
            await post('/api/storyline', { slug, path: cur.path, summary: String(v).trim() });
            toast('存好了');
            capsHome(host, slug);            // 重画，让"自动/我写的"标记跟着变
          } catch (err) { toast('存不下：' + err.message); }
          return;
        }
        hap();
        try { await window.Shelf.openBook(slug, { slug, path: row.dataset.path }); }
        catch (err) { toast('打不开：' + err.message); }
      };
    });
  }

  async function storyHome(host, slug) {
    if (!window.Outline) { U().empty(host, '大纲模块没加载（页面缺 js/outline.js）'); return; }
    host.innerHTML =
      '<div class="ol-mount" data-ol></div>' +
      '<details class="acc" data-caps-acc>' +
        '<summary><span class="acc-t">章节速览 · 一章一句话</span>' +
          '<span class="acc-n">写到哪了，一眼看完；点一行去写那一章</span>' +
          '<span class="acc-x">' + window.iconHtml('chevron') + '</span></summary>' +
        '<div class="acc-body" data-caps></div>' +
      '</details>';
    const box = host.querySelector('[data-caps]');
    /* 折叠区**点开才读**（省一次请求，也不会跟大纲抢第一次渲染的时间） */
    const acc = host.querySelector('[data-caps-acc]');
    let done = false;
    acc.addEventListener('toggle', () => {
      if (!acc.open || done) return;
      done = true;
      /* 读失败要说话 —— 以前这类 async 调用没人接住，界面就永远停在"读章节…"
         （第 36 轮自己踩的：rowHtml 没了 → ReferenceError → 一直转圈、一声不吭） */
      capsHome(box, slug).catch((e) => { toast('速览读不到：' + ((e && e.message) || e)); });
    });
    return window.Outline.mount(host.querySelector('[data-ol]'), slug);
  }

  /* ══════════════════ ⑤ 章节顺序 ══════════════════ */
  async function orderHome(host, slug) {
    U().loading(host, '读章节…');
    let d;
    try { d = await chapters(slug); }
    catch (e) { U().empty(host, '读不到章节：' + e.message); return; }
    const items = (d && d.items) || [];
    if (!items.length) { U().empty(host, '这本书还没有章节', 'book'); return; }
    host.innerHTML = head(d) +
      '<div class="t-hint">上移 / 下移 会重排章节编号；插一章会插在这一章后面。' +
      '这一章的细纲、出场角色、关键事件会跟着走，一个字不丢。</div>' +
      '<div class="al-list">' + items.map((it, i) =>
        '<div class="al-row ord" data-path="' + esc(it.path) + '">' +
          '<div class="al-no">' + (it.no || i + 1) + '</div>' +
          '<div class="al-main"><div class="al-title">' + esc(it.title) + '</div>' +
            '<div class="al-meta">' + (it.empty ? '还没写' : num(it.words) + ' 字') + '</div></div>' +
          '<div class="al-btns">' +
            '<button class="al-btn" data-mv="up" aria-label="上移">' + window.iconHtml('chevron') + '</button>' +
            '<button class="al-btn dn" data-mv="down" aria-label="下移">' + window.iconHtml('chevron') + '</button>' +
            '<button class="al-btn ins" data-ins="1" aria-label="在这一章后面插一章">' +
              window.iconHtml('plus') + '</button>' +
          '</div></div>').join('') + '</div>';
    host.querySelectorAll('.al-row').forEach((row) => {
      row.onclick = async (e) => {
        const mv = e.target.closest('[data-mv]');
        const ins = e.target.closest('[data-ins]');
        const path = row.dataset.path;
        const it = items.find((x) => x.path === path) || {};
        if (mv) {
          hap();
          e.stopPropagation();
          try {
            const r = await post('/api/chapter/move', { slug, path, dir: mv.dataset.mv });
            if (r && r.moved === false) toast('已经到头了');
            else toast('挪好了');
            orderHome(host, slug);
          } catch (err) { toast('挪不动：' + err.message); }
          return;
        }
        if (ins) {
          hap();
          e.stopPropagation();
          const name = await U().ask('插在「' + it.title + '」后面的这一章叫什么', '',
            { placeholder: '例：第007章-雪夜之后', host });
          if (!name) return;
          try {
            const r = await post('/api/chapter/insert', { slug, after: path, title: String(name).trim() });
            toast(r && r.inserted ? '插好了' : '插好了');
            orderHome(host, slug);
          } catch (err) { toast('插不进去：' + err.message); }
          return;
        }
        /* 这一屏只干"挪位置"这件事：点空白处不乱跳（想写正文请走「故事线」或书架） */
      };
    });
  }

  if (window.Tools && window.Tools.add) {
    window.Tools.add([
      { id: 'story', name: '故事线', sub: '大纲 · 这本书往哪走', icon: 'list', sec: '写作',
        run: (host) => U().pushBook('故事线', storyHome) },
      { id: 'order', name: '章节顺序', sub: '插一章·调顺序', icon: 'refresh', sec: '书稿',
        run: (host) => U().pushBook('章节顺序', orderHome) },
    ]);
  }
})();
