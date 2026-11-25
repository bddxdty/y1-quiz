/* swipe_test.js — 真实浏览器里验收「左滑下一题 / 右滑上一题」
 * 用法：node tools/swipe_test.js [页面 html ...]
 *      不给参数时跑 cs / math / ethics 各一页的代表性用例。
 *
 * 依赖 playwright-core 与本机 Edge（channel: msedge），不下载额外浏览器。
 * 判定口径与 qb-page.js 的 initSwipe() 一致：水平 ≥56px、水平 ≥ 垂直×1.2、≤1200ms。
 */
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PAGES = [
  'deploy/collections/cs/dist/banks/u1/index.html',      // 单选为主
  'deploy/collections/cs/dist/banks/terms/index.html',   // 名词解释（长文本 + textarea）
  'deploy/collections/math/dist/banks/u3/index.html',    // 含公式，需让位给横向滚动
  'deploy/collections/ethics/dist/banks/ch1/index.html'  // 另一科目
];

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* 在页面里合成一次触摸滑动。from/to 是视口坐标。 */
const SWIPE_FN = `
window.__swipe = function (sel, x0, y0, x1, y1) {
  var el = document.querySelector(sel) || document.body;
  var mk = function (x, y) {
    return new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
  };
  function fire(type, t, touched) {
    var ev = new TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: touched ? [t] : [],
      targetTouches: touched ? [t] : [],
      changedTouches: [t]
    });
    el.dispatchEvent(ev);
  }
  var steps = 6;
  fire('touchstart', mk(x0, y0), true);
  for (var i = 1; i <= steps; i++) {
    fire('touchmove', mk(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps), true);
  }
  fire('touchend', mk(x1, y1), false);
};
`;

const qno = (page) => page.evaluate(() => {
  const el = document.querySelector('#card .q-no');
  return el ? el.textContent.trim() : '';
});

(async () => {
  const pages = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PAGES;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2
  });

  for (const rel of pages) {
    const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    console.log('\n' + rel);
    await page.goto('file://' + file);
    await page.waitForSelector('#card .q-no', { timeout: 5000 });
    await page.addScriptTag({ content: SWIPE_FN });

    const first = await qno(page);
    ok(/^1 \//.test(first), '初始停在第 1 题（' + first + '）');

    // 左滑 → 下一题
    await page.evaluate(() => window.__swipe('#card .q-stem', 320, 400, 120, 404));
    await page.waitForTimeout(420);
    const second = await qno(page);
    ok(/^2 \//.test(second), '左滑进入第 2 题（' + second + '）');

    // 右滑 → 上一题
    await page.evaluate(() => window.__swipe('#card .q-stem', 120, 400, 320, 396));
    await page.waitForTimeout(420);
    ok((await qno(page)) === first, '右滑退回第 1 题');

    // 首题右滑：不越界、不抖动
    await page.evaluate(() => window.__swipe('#card .q-stem', 120, 400, 320, 400));
    await page.waitForTimeout(420);
    ok((await qno(page)) === first, '首题右滑不越界');

    // 纵向滑动：判定为滚动，不翻题
    await page.evaluate(() => window.__swipe('#card .q-stem', 200, 300, 206, 560));
    await page.waitForTimeout(420);
    ok((await qno(page)) === first, '纵向滑动不翻题');

    // 小幅横滑（30px）：不到阈值，不翻题
    await page.evaluate(() => window.__swipe('#card .q-stem', 220, 400, 190, 400));
    await page.waitForTimeout(420);
    ok((await qno(page)) === first, '小幅横滑不翻题');

    // 从控制区起手：不翻题
    await page.evaluate(() => window.__swipe('#modes', 320, 60, 120, 60));
    await page.waitForTimeout(420);
    ok((await qno(page)) === first, '控制区起手不翻题');

    // 滑动后卡片样式复位，不残留 transform
    const dirty = await page.evaluate(() => {
      const c = document.querySelector('#card');
      return c.style.transform || c.style.opacity;
    });
    ok(!dirty, '卡片 transform / opacity 已复位');

    // 页面在顶部时翻题：滚动位置不动（不能回弹到顶部）
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__swipe('#card .q-stem', 320, 400, 120, 404));
    await page.waitForTimeout(450);
    ok((await page.evaluate(() => window.scrollY)) === 0, '页面在顶部时左滑不回弹');

    // 滚进题目中途再翻题：不能回到最上方，题卡顶部也不能跑到视野外
    // 题库页本身不够高，先垫一段空白造出滚动空间，测完移除
    const pre = await page.evaluate(() => {
      const sp = document.createElement('div');
      sp.id = '__spacer';
      sp.style.height = '1600px';
      document.body.appendChild(sp);
      const c = document.querySelector('#card');
      window.scrollTo(0, window.scrollY + c.getBoundingClientRect().top + 200);
      return { y: window.scrollY, top: c.getBoundingClientRect().top };
    });
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__swipe('#card .q-stem', 320, 600, 120, 604));
    await page.waitForTimeout(450);
    const scrolled = await page.evaluate(() => ({
      y: window.scrollY,
      top: document.querySelector('#card').getBoundingClientRect().top
    }));
    ok(scrolled.y > 0, '中途翻题不回最上方（' + pre.y + ' → ' + scrolled.y + '）');
    if (pre.top < 8) {
      ok(scrolled.top >= -8 && scrolled.top <= 24,
        '题卡顶部已滚出视野时，翻题把它拉回视野顶部（top=' + Math.round(scrolled.top) + '）');
    } else {
      ok(true, '页面高度不足以让题卡顶部滚出视野，跳过定位断言');
    }
    await page.evaluate(() => {
      const sp = document.querySelector('#__spacer');
      if (sp) sp.parentNode.removeChild(sp);
      window.scrollTo(0, 0);
    });

    // 按钮翻页与手势同一条路径，同样不回弹
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      const b = document.querySelectorAll('#nav button');
      for (let i = 0; i < b.length; i++) {
        if (b[i].textContent.indexOf('下一题') >= 0 && !b[i].disabled) { b[i].click(); return; }
      }
    });
    await page.waitForTimeout(250);
    ok((await page.evaluate(() => window.scrollY)) === 0, '点「下一题」按钮同样不回弹');

    // 滑动末尾不会顺手把选项点掉（左滑起手在选项上）
    const hasOpt = await page.evaluate(() => !!document.querySelector('#card .opt'));
    if (hasOpt) {
      const statBefore = await page.evaluate(() => document.querySelector('#stats .stat-v').textContent);
      await page.evaluate(() => window.__swipe('#card .opt', 320, 300, 120, 302));
      await page.waitForTimeout(500);
      const statAfter = await page.evaluate(() => document.querySelector('#stats .stat-v').textContent);
      ok(statBefore === statAfter, '从选项起手左滑不会误判作答（' + statBefore + ' → ' + statAfter + '）');
    } else {
      ok(true, '本题无选项，跳过误触检查');
    }

    // 可横向滚动的容器（长公式 / 代码块）内起手：让位给横向滚动，不翻题
    const scrollBox = await page.evaluate(() => {
      const card = document.querySelector('#card');
      const box = document.createElement('div');
      box.id = '__hs';
      box.style.cssText = 'overflow-x:auto;overflow-y:hidden;max-width:100%;white-space:nowrap';
      box.innerHTML = '<span>' + new Array(120).join('很长的一行公式占位内容 ') + '</span>';
      card.appendChild(box);
      return box.scrollWidth - box.clientWidth;
    });
    const beforeScrollSwipe = await qno(page);
    await page.evaluate(() => window.__swipe('#__hs', 320, 300, 120, 302));
    await page.waitForTimeout(420);
    ok((await qno(page)) === beforeScrollSwipe,
      '横向可滚动容器内起手不翻题（溢出 ' + scrollBox + 'px）');

    // 空列表（错题本还没记录）：滑动不抛错、不改变页面
    await page.evaluate(() => {
      const b = Array.prototype.slice.call(document.querySelectorAll('#modes button'))
        .filter(function (x) { return x.dataset.mode === 'wrong'; })[0];
      if (b) b.click();
    });
    await page.waitForTimeout(200);
    const emptyBefore = await page.evaluate(() => document.querySelector('#card').textContent.slice(0, 20));
    await page.evaluate(() => window.__swipe('#card', 320, 400, 120, 404));
    await page.waitForTimeout(420);
    const emptyAfter = await page.evaluate(() => document.querySelector('#card').textContent.slice(0, 20));
    ok(emptyBefore === emptyAfter, '空列表滑动无副作用');

    // 末题左滑：不越界
    const lastQid = await page.evaluate(() => {
      const u = window.QB_SITE.units[0];
      return u.questions[u.questions.length - 1].qid;
    });
    await page.evaluate((qid) => { location.hash = '#q=' + qid; }, lastQid);
    await page.reload();
    await page.waitForSelector('#card .q-no', { timeout: 5000 });
    await page.addScriptTag({ content: SWIPE_FN });
    const lastNo = await qno(page);
    await page.evaluate(() => window.__swipe('#card .q-stem', 320, 400, 120, 404));
    await page.waitForTimeout(420);
    ok((await qno(page)) === lastNo && /\/(?:\s*)(\d+)$/.test(lastNo),
      '末题左滑不越界（' + lastNo + '）');

    ok(errors.length === 0, '控制台无报错' + (errors.length ? '：' + errors[0] : ''));
    await page.close();
  }

  await browser.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
