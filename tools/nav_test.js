/* nav_test.js — 全量验收「逐级返回」：单元页 → 题库集 → 大一题库
 * 用法：node tools/nav_test.js
 *
 * 静态检查：deploy/ 下每个带 id="home" / id="back" 的页面，链接不能是 "#"，
 *           解析出的目标文件必须真实存在且层级正确（单元页 → 题库集入口，题库集 → 根入口）。
 * 浏览器检查：起本机静态服务器，逐页真点一次「返回」，核对落点 URL 与标题。
 *
 * 依赖 playwright-core 与本机 Edge（channel: msedge）。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = path.join(ROOT, 'deploy');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* ---------- 工具 ---------- */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

function attr(html, id) {
  const m = html.match(new RegExp('<a[^>]*id="' + id + '"[^>]*>'));
  if (!m) return null;
  const h = m[0].match(/href="([^"]*)"/);
  return { tag: m[0], href: h ? h[1] : null };
}

/* deploy 内的绝对路径 → 站内路径（/collections/...） */
function sitePath(file) {
  return '/' + path.relative(DEPLOY, file).split(path.sep).join('/');
}

/* 入口页注入的数据：window.QB_INDEX = {...}; */
function indexData(html) {
  const m = html.match(/window\.QB_INDEX=([\s\S]*?);<\/script>/);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (e) { return {}; }
}

/* ---------- 静态检查 ---------- */
function staticCheck() {
  console.log('\n【静态】deploy/ 全量页面的返回链接');
  const pages = walk(DEPLOY);
  let bankPages = 0, indexPages = 0;

  for (const file of pages) {
    const html = fs.readFileSync(file, 'utf8');
    const home = attr(html, 'home');
    const back = attr(html, 'back');
    const rel = sitePath(file);

    if (home) {
      bankPages++;
      const target = home.href && home.href !== '#'
        ? path.resolve(path.dirname(file), home.href) : null;
      const okLink = !!target && fs.existsSync(target);
      // 单元页 / 题库集内页都在 dist 的下一级或两级，上一级必须是题库集入口
      const expect = /\/dist\/banks\/[^/]+\/index\.html$/.test(file)
        ? path.join(path.dirname(path.dirname(path.dirname(file))), 'index.html')
        : /\/dist\/[^/]+\/[^/]+\.html$/.test(file)
          ? path.join(path.dirname(path.dirname(file)), 'index.html')
          : null;
      ok(okLink && expect && path.resolve(target) === path.resolve(expect),
        `${rel} → ${home.href}${okLink ? '' : '（目标不存在）'}`);
    }

    if (back) {
      // 入口页的 href 由 qb-index.js 在运行时按 QB_INDEX.back 写入，静态值就是 "#"，
      // 所以这里校验的是注入数据，而不是标签上的 href。
      const data = indexData(html);
      const rootIndex = path.join(DEPLOY, 'index.html');
      if (file === rootIndex) {
        ok(!data.back, '根入口 index.html 无上一级，不注入返回链接');
      } else {
        indexPages++;
        const href = data.back && data.back.href;
        const target = href ? path.resolve(path.dirname(file), href) : null;
        const okLink = !!target && fs.existsSync(target) && target === rootIndex;
        ok(okLink, `${rel} → ${href || '（未注入 back）'}${okLink ? '' : '（目标不存在）'}`);
      }
    }
  }

  console.log(`  —— 静态扫描 ${pages.length} 个页面：${bankPages} 个题库页、${indexPages} 个题库集入口页`);
  return { bankPages, indexPages, pages: pages.length };
}

/* ---------- 静态服务器 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      let file = path.join(DEPLOY, rel);
      if (!file.startsWith(DEPLOY)) { res.writeHead(403).end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* ---------- 浏览器检查 ---------- */
(async () => {
  const LIVE = process.argv.includes('--live');
  if (!LIVE) {
    const stat = staticCheck();
    if (!stat.bankPages || !stat.indexPages) {
      console.error('✗ 没有扫到题库页或入口页，deploy/ 可能没生成');
      process.exit(2);
    }
  }

  // 线上地址不写死：--live 时从 QB_LIVE_BASE 读（形如 https://<env-id>-<access-id>.tcloudbaseapp.com）
  const LIVE_BASE = process.env.QB_LIVE_BASE || '';
  if (process.argv.includes('--live') && !LIVE_BASE) {
    console.error('✗ --live 需要环境变量 QB_LIVE_BASE=<线上地址>');
    process.exit(2);
  }
  const srv = LIVE ? null : await serve();
  const base = LIVE ? LIVE_BASE : 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({
    channel: 'msedge', headless: true,
    // 本机直连外网不通，浏览器要走 shell 里的 HTTP 代理（curl 同样靠它）
    proxy: LIVE ? { server: process.env.HTTPS_PROXY || process.env.HTTP_PROXY } : undefined
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

  console.log('\n【浏览器】逐级点「返回」' + (LIVE ? '（线上 ' + LIVE_BASE + '）' : ''));

  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  for (const col of catalog.collections) {
    const colIndex = `/collections/${col.id}/dist/index.html`;
    const manifest = JSON.parse(fs.readFileSync(path.join(DEPLOY, colIndex.replace(/^\//, '').replace('index.html', 'manifest.json')), 'utf8'));

    let bankOk = 0;
    for (const b of manifest.banks) {
      const url = `${base}/collections/${col.id}/dist/banks/${b.key}/index.html`;
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto(url, { waitUntil: 'load' });

      const info = await page.evaluate(() => {
        const a = document.querySelector('#home');
        if (!a) return { missing: true };
        const cs = getComputedStyle(a);
        return {
          href: a.getAttribute('href'),
          text: a.textContent.trim(),
          visible: cs.display !== 'none' && cs.visibility !== 'hidden' && a.getClientRects().length > 0,
          abs: a.href
        };
      });

      const linkOk = info.visible && info.href && info.href !== '#'
        && new URL(info.abs).pathname === colIndex;
      if (!linkOk || errors.length) {
        ok(false, `${col.name} / ${b.label}（${b.key}）返回链接异常：` +
          JSON.stringify(info) + (errors.length ? ' 报错：' + errors[0] : ''));
        await page.close();
        continue;
      }

      // 真点一次，核对落到题库集入口
      await Promise.all([page.waitForURL(base + colIndex, { timeout: 5000 }), page.click('#home')]);
      await page.waitForLoadState('load');
      const landed = await page.evaluate(() => ({
        title: document.title,
        back: (() => {
          const a = document.querySelector('#back');
          return a ? { text: a.textContent.trim(), href: a.getAttribute('href') } : null;
        })()
      }));
      const landedOk = new URL(page.url()).pathname === colIndex
        && landed.back && landed.back.text === '返回大一题库' && landed.back.href !== '#';
      if (landedOk) bankOk++;
      else ok(false, `${col.name} / ${b.label}（${b.key}）点返回后落点异常：` + JSON.stringify(landed));
      await page.close();
    }
    ok(bankOk === manifest.banks.length,
      `${col.name}：${bankOk}/${manifest.banks.length} 个题库页「返回题库集」可用`);

    // 题库集 → 大一题库
    const page = await ctx.newPage();
    await page.goto(base + colIndex, { waitUntil: 'load' });
    const backInfo = await page.evaluate(() => {
      const a = document.querySelector('#back');
      if (!a) return { missing: true };
      const cs = getComputedStyle(a);
      return {
        href: a.getAttribute('href'), abs: a.href, text: a.textContent.trim(),
        visible: cs.display !== 'none' && a.getClientRects().length > 0
      };
    });
    const backOk = backInfo.visible && backInfo.href !== '#' && backInfo.text === '返回大一题库'
      && new URL(backInfo.abs).pathname === '/index.html';
    if (backOk) {
      await Promise.all([page.waitForURL(base + '/index.html', { timeout: 5000 }), page.click('#back')]);
      await page.waitForLoadState('load');
      const root = await page.evaluate(() => ({
        title: document.title,
        backHidden: (() => {
          const a = document.querySelector('#back');
          return a ? getComputedStyle(a).display === 'none' : true;
        })()
      }));
      ok(root.title === '大一题库' && root.backHidden,
        `${col.name} 题库集「返回大一题库」落到根入口（${root.title}，根入口无上一级按钮）`);
    } else {
      ok(false, `${col.name} 题库集返回链接异常：` + JSON.stringify(backInfo));
    }
    await page.close();
  }

  /* file:// 双击场景：相对链接在本地文件系统上同样要能解析到题库集入口 */
  if (!LIVE) {
    const filePage = await ctx.newPage();
    const fileUrl = 'file://' + path.join(DEPLOY, 'collections/cs/dist/banks/u1/index.html');
    await filePage.goto(fileUrl, { waitUntil: 'load' });
    const fileHome = await filePage.evaluate(() => {
      const a = document.querySelector('#home');
      return { href: a.getAttribute('href'), abs: a.href, visible: getComputedStyle(a).display !== 'none' };
    });
    await Promise.all([filePage.waitForURL('**/collections/cs/dist/index.html', { timeout: 5000 }), filePage.click('#home')]);
    ok(fileHome.visible && new URL(filePage.url()).pathname.endsWith('/collections/cs/dist/index.html'),
      'file:// 双击打开单元页，「返回题库集」同样可用');
    await filePage.close();
  }

  await browser.close();
  if (srv) srv.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
