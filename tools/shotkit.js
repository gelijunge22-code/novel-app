/* ============================================================
   shotkit.js — 截图工具的公共件（第 9 轮加，治"攒垃圾截图"这个病）

   要治的三件事（都是巡检时真被抓到的）：
   1. **重复图当证据**：同一 md5 的图被当成两张不同的证据摆着（27 张一模一样）。
   2. **拍错屏**：想拍"版本三状态"，结果三张拍的都是设置页顶部，版本那一行根本没进画面。
   3. **文件名不带轮次**：一个目录里躺着好几轮的图，分不清谁是谁。

   用法：
     const kit = require('./shotkit')({ send, dir, round: 'r9' });
     const a = await kit.shoot('01-首页');                       // 默认：这张必须跟前面任何一张都不同
     const b = await kit.shoot('02-返回', { expect: 'same', as: a.id });
     ... 最后
     kit.report();      // { shots, dupes } —— dupes 非空就是失败

   `expect:'same'` 是给"返回键回到同一屏"这种**本来就该一样**的步骤用的：
   它不产生新文件（只记一条"和谁相同"），所以不会再攒废图。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function makeKit({ send, dir, round = 'r', prefix = '', openDoc = true }) {
  fs.mkdirSync(dir, { recursive: true });
  const byMd5 = new Map();     // md5 → 名字（不存 base64，省内存）
  const shots = [];
  const dupes = [];
  // 先把目录里**已有的图**登记一遍：跨脚本、跨轮次的重复也要能认出来
  // （上一轮就是两个不同脚本各拍了一张一模一样的"阅读器菜单"）。
  if (openDoc) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.png')) continue;
      try {
        const h = crypto.createHash('md5').update(fs.readFileSync(path.join(dir, f))).digest('hex');
        if (!byMd5.has(h)) byMd5.set(h, f.replace(/\.png$/, ''));
      } catch (e) { /* 读不了就跳过 */ }
    }
  }

  const capture = async () => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!(r.result && r.result.data)) return null;
    const buf = Buffer.from(r.result.data, 'base64');
    return { buf, md5: crypto.createHash('md5').update(buf).digest('hex') };
  };

  async function shoot(name, opts = {}) {
    const expect = opts.expect || 'different';
    const cap = await capture();
    if (!cap) {
      dupes.push({ name, why: '截图失败（拿不到画面）' });
      return { id: name, md5: '', file: '' };
    }
    const base = (prefix || round + '-') + name;
    const file = path.join(dir, base + '.png');
    // 磁盘上这个名字的上一版，内容跟这次一样 → 是"同一个脚本又跑了一遍"，不是新证据
    const self = (byMd5.get(cap.md5) || '') === base;
    const first = self ? '' : byMd5.get(cap.md5);
    if (expect === 'same') {
      // 本来就该跟某一屏一样（返回键回到原处 / 同一屏换个角度拍）：只记"和谁一样"，不再写文件
      shots.push({ name, md5: cap.md5, sameAs: first || opts.as || '', file: '' });
      if (!first) dupes.push({ name, why: '标了 same，但这一屏之前（含磁盘上的旧图）没出现过' });
      return { id: name, md5: cap.md5, file: '' };
    }
    if (self) {
      // 同一个脚本、同一个步骤又跑了一遍（内容当然一样）：覆盖自己那张，不算重复
      fs.writeFileSync(file, cap.buf);
      byMd5.set(cap.md5, base);
      shots.push({ name, md5: cap.md5, file: path.basename(file), rerun: true });
      return { id: name, md5: cap.md5, file: file };
    }
    if (first) {
      // 该变没变：判失败，并且**不写第二份文件**（不攒垃圾）
      dupes.push({ name, why: '跟「' + first + '」逐字节一样（这一步本该换屏）' });
      shots.push({ name, md5: cap.md5, dupOf: first, file: '' });
      return { id: name, md5: cap.md5, file: '' };
    }
    fs.writeFileSync(file, cap.buf);
    byMd5.set(cap.md5, base);
    shots.push({ name, md5: cap.md5, file: path.basename(file) });
    return { id: name, md5: cap.md5, file: file };
  }

  /** 报告：dupes 非空 = 这一步的截图不合格（调用方据此判失败） */
  function report() {
    return { round, shots, dupes };
  }

  return { shoot, report, shots, dupes };
};
