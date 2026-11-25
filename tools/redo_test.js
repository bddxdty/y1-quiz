/* redo_test.js — 错题重做的界面行为验收
 * 用最小 DOM 垫片真正跑一遍 qb-page.js：进错题模式 → 选项应可点 → 点对 → 判定与错题集合的变化。
 * 用法：node tools/redo_test.js <页面 html>
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(process.argv[2], 'utf8');
function grab(name) {
  const key = 'window.' + name + '=';
  const i = html.indexOf(key);
  if (i < 0) return null;
  const s = i + key.length;
  let d = 0, inStr = false, esc = false, j = s;
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') d++;
    else if (c === '}' || c === ']') { d--; if (d === 0) { j++; break; } }
  }
  return JSON.parse(html.slice(s, j));
}

/* ---------------- 最小 DOM ---------------- */
function mkEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, options: [], value: '', textContent: '',
    innerHTML: '', disabled: false, type: '', rows: 0, placeholder: '', href: '', src: '', alt: '',
    title: '', _handlers: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { this[k] = v; },
    select() {}, focus() {},
    click() { (this._handlers.click || []).forEach(fn => fn({ target: this, preventDefault() {} })); }
  };
  // 真实 DOM 里 innerHTML = '' 会清空子节点，垫片不模拟这一步的话，
  // 重画后新旧节点会一起被遍历到，测出来的状态是假的
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(v) { el._html = String(v); if (v === '') el.children = []; }
  });
  // 页面里用 el.className = 'opt' 赋值，真实 DOM 会同步到 classList，垫片也要跟上
  Object.defineProperty(el, 'className', {
    get() { return Array.from(el.classList._s).join(' '); },
    set(v) { el.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  return el;
}
function walk(node, fn) {
  if (!node) return;
  fn(node);
  (node.children || []).forEach(c => walk(c, fn));
}
function findText(root, text) {
  let hit = null;
  walk(root, n => { if (!hit && n.textContent === text) hit = n; });
  return hit;
}

const registry = {};
const modes = ['seq', 'random', 'wrong', 'fav', 'undone'].map(m => {
  const b = mkEl('button'); b.dataset.mode = m; return b;
});
const document = {
  readyState: 'complete',
  createElement: mkEl,
  querySelector(sel) { if (!registry[sel]) registry[sel] = mkEl('div'); return registry[sel]; },
  querySelectorAll(sel) { return sel === '#modes button' ? modes : []; },
  addEventListener() {}, execCommand() { return true; }, hidden: false
};
const window = { scrollTo() {}, addEventListener() {} };
const mem = {};
global.document = document;
global.window = window;
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
  length: 0, key: () => null
};
global.location = { hash: '#mode=wrong', pathname: '/index.html' };
global.history = { replaceState() {} };
global.confirm = () => true;

const QB = require(path.join(__dirname, '..', 'packages', 'qb-core', 'qb-core.js'));
window.QB = QB; global.QB = QB;
const def = grab('QB_SITE');
window.QB_SITE = def;
window.QB_META = grab('QB_META') || {};

/* 造一条错题记录：取本题库第一道题，标记为答错 */
const first = def.units[0].questions[0];
const decl = def.types[first.type] || {};
const kind = decl.answerShape === 'choice' ? 'choice' : (decl.judge === 'rubric' ? 'rubric' : 'auto');
const gid = QB.fingerprint(first, (def.codec && def.codec.gidBits) || 32);
mem['qb.site.ans.v1'] = JSON.stringify({ [gid]: { ok: false, at: 1, p: [0] } });
mem['qb.site.wrong.v1'] = JSON.stringify({ [gid]: 1 });

require(path.join(__dirname, '..', 'packages', 'qb-core', 'qb-page.js'));

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const cardNow = () => registry['#card'];
function collect(cls) {
  const out = [];
  walk(cardNow(), n => { if (n.classList && n.classList.contains(cls)) out.push(n); });
  return out;
}
function fields() {
  const out = [];
  walk(cardNow(), n => { if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') out.push(n); });
  return out;
}

ok(cardNow().children.length > 0, '错题模式下题目卡片没有渲染');

/* 1. 进错题本要能直接作答 */
if (kind === 'choice') {
  const opts = collect('opt');
  ok(opts.length >= 2, '没有渲染出选项');
  ok(opts.every(o => !o.disabled), '错题模式下的选项仍是禁用的（这就是「没法重做」）');
  ok(opts.every(o => !o.classList.contains('right')), '错题模式下提前把正确答案标出来了');
} else {
  const ins = fields();
  ok(ins.length >= 1 && ins.every(i => !i.disabled), '错题模式下的输入框仍是禁用的');
}
ok(!!findText(cardNow(), '提交'), '错题模式下没有「提交」按钮');

/* 2. 作答正确 */
if (kind === 'choice') {
  collect('opt')[first.answer[0]].click();
} else {
  const ins = fields();
  ins[0].value = kind === 'auto' ? String((first.answers || [''])[0]) : '测试作答内容';
  (ins[0]._handlers.input || []).forEach(fn => fn({ target: ins[0] }));
  const sub = findText(cardNow(), '提交');
  ok(!!sub, '主观/填空题没有提交按钮');
  if (sub) sub.click();
  if (kind === 'rubric') {
    const self = findText(cardNow(), '达标');
    ok(!!self, '提交后没有自评按钮');
    if (self) self.click();
  }
}

/* 3. 判定与错题集合 */
ok(!!findText(cardNow(), '✓ 答对'), '答对后没有显示「✓ 答对」');
ok(!JSON.parse(mem['qb.site.wrong.v1'] || '{}')[gid], '答对后没有移出错题本');
ok((JSON.parse(mem['qb.site.ans.v1'] || '{}')[gid] || {}).ok === true, '答对后作答记录没有更新为 true');

/* 4. 答完还能再重做一次 */
const again = findText(cardNow(), '重做本题');
ok(!!again, '答完后没有「重做本题」按钮');
if (again) again.click();
if (kind === 'choice') {
  const o2 = collect('opt');
  ok(o2.length >= 2 && o2.every(o => !o.disabled), '点「重做本题」后选项仍不可点');
  ok(o2.every(o => !o.classList.contains('right')), '点「重做本题」后仍标着正确答案');
} else {
  const i2 = fields();
  ok(i2.length >= 1 && i2.every(i => !i.disabled), '点「重做本题」后输入框仍不可用');
  ok(i2.length >= 1 && !i2[0].value, '点「重做本题」后没有清空上次输入');
}
ok(!!findText(cardNow(), '提交'), '点「重做本题」后没有恢复「提交」按钮');

/* 5. 错题本专属的「全部重做」 */
ok(!!findText(registry['#nav'], '全部重做'), '错题本里没有「全部重做」按钮');

if (fails.length) {
  console.log('✗ 错题重做验收失败 ' + fails.length + ' 项');
  fails.forEach(f => console.log('   · ' + f));
  process.exit(1);
}
console.log('✓ 错题重做正常：可直接作答、答对移出、可再次重做（' + def.units[0].key
  + '，' + ({ choice: '选择题', rubric: '主观题', auto: '填空题' })[kind] + '）');
