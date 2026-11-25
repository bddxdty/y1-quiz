/* ui_smoke.js — 用最小 DOM 垫片跑一遍页面初始化，确认渲染层不会抛错
 * 用法：node tools/ui_smoke.js <页面 html>
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(process.argv[2], 'utf8');

function grab(name) {
  const key = 'window.' + name + '=';
  const i = html.indexOf(key);
  if (i < 0) return null;
  const s = i + key.length;
  let depth = 0, inStr = false, esc = false, j = s;
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) { j++; break; } }
  }
  return JSON.parse(html.slice(s, j));
}

/* ---------------- 最小 DOM ---------------- */
function mkEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, options: [], value: '', textContent: '',
    innerHTML: '', disabled: false, type: '', rows: 0, placeholder: '', href: '', src: '', alt: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, setAttribute(k, v) { this[k] = v; },
    select() {}, focus() {}, click() {}
  };
  return el;
}

const registry = {};
const document = {
  readyState: 'complete',
  createElement: mkEl,
  querySelector(sel) { if (!registry[sel]) registry[sel] = mkEl('div'); return registry[sel]; },
  querySelectorAll() { return []; },
  addEventListener() {},
  execCommand() { return true; },
  hidden: false
};
const window = { scrollTo() {}, addEventListener() {} };

const mem = {};
global.document = document;
global.window = window;
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
global.location = { hash: '', pathname: '/index.html' };
global.history = { replaceState() {} };
global.confirm = () => true;

const QB = require(path.join(__dirname, '..', 'packages', 'qb-core', 'qb-core.js'));
global.QB = QB;
window.QB = QB;
window.QB_SITE = grab('QB_SITE');
window.QB_META = grab('QB_META') || {};

try {
  require(path.join(__dirname, '..', 'packages', 'qb-core', 'qb-page.js'));
} catch (e) {
  console.log('✗ 页面初始化抛错：' + e.message);
  console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

const card = registry['#card'];
const rendered = card && (card.children.length > 0);
if (!rendered) {
  console.log('✗ 题目卡片没有渲染出任何内容');
  process.exit(1);
}
const stats = registry['#stats'];
console.log(`✓ 初始化正常  题卡子节点 ${card.children.length}  统计块 ${stats.children.length}  `
  + `单元 ${(window.QB_SITE.units || []).map(u => u.key).join(',')}`);
