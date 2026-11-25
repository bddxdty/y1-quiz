/* compat_test.js — 旧数据兼容性验收
 * 1) v9 旧导出码能否被新内核正确解出
 * 2) csg_*（gid 键）与 csunitN_*（旧题号键）两类历史命名空间能否迁进全站三表
 * 3) 迁移是否幂等、旧键是否保留
 * 用法：node tools/compat_test.js collections/cs/dist/banks/u1/index.html
 */
const fs = require('fs');
const path = require('path');
const QB = require(path.join(__dirname, '..', 'packages', 'qb-core', 'qb-core.js'));

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

const mem = {};
global.localStorage = {
  length: 0,
  key(i) { return Object.keys(mem)[i]; },
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
function refreshLen() { global.localStorage.length = Object.keys(mem).length; }

const def = grab('QB_SITE');
const site = QB.create(def);
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

/* ---------- 1. v9 旧码 ---------- */
function encodeV9(site, state) {
  const gids = site.legacyGids();
  const total = gids.length, len = Math.ceil(total / 8);
  const ansBits = new Uint8Array(len), favBits = new Uint8Array(len), txtBits = new Uint8Array(len);
  const body = [];
  let cur = 0, cb = 0;
  const put = (v, w) => { for (let k = w - 1; k >= 0; k--) { cur = (cur << 1) | ((v >> k) & 1); if (++cb === 8) { body.push(cur); cur = 0; cb = 0; } } };
  for (let i = 0; i < total; i++) {
    const g = gids[i], r = state[g];
    if (!r) continue;
    ansBits[i >> 3] |= 1 << (i & 7);
    put(r.ok === true ? 1 : (r.ok === false ? 2 : 0), 2);
    let mask = 0;
    (r.p || []).forEach(k => { if (k >= 0 && k < 4) mask |= 1 << k; });
    put(mask, 4);
  }
  if (cb) body.push((cur << (8 - cb)) & 0xFF);
  const out = [9, (total >> 8) & 255, total & 255, ...ansBits, ...favBits, ...txtBits, ...body];
  return '9:' + Buffer.from(out).toString('base64url').replace(/=+$/, '');
}

const qs = site.questions;
const state = {};
state[qs[0]._gid] = { ok: true, p: qs[0].answer ? qs[0].answer.slice() : [0] };
state[qs[3]._gid] = { ok: false, p: [1] };
state[qs[7]._gid] = { ok: null, p: [] };

const code9 = encodeV9(site, state);
const got = site.decode(code9);
ok(got.v === 9, 'v9 编码没有被识别');
ok(Object.keys(got.ans).length === 3, `v9 解出 ${Object.keys(got.ans).length} 条，应为 3 条`);
ok(got.ans[qs[0]._gid] && got.ans[qs[0]._gid].ok === true, 'v9 答对记录解码错误');
ok(got.ans[qs[3]._gid] && got.ans[qs[3]._gid].ok === false, 'v9 答错记录解码错误');
ok(got.ans[qs[7]._gid] && got.ans[qs[7]._gid].ok === null, 'v9 待自评记录解码错误');
ok(JSON.stringify(got.ans[qs[0]._gid].p) === JSON.stringify(state[qs[0]._gid].p), 'v9 选项掩码解码错误');

// 导入后应进入全站表
site.importCode(code9);
ok(Object.keys(site.allAns()).length >= 3, 'v9 导入没有写入作答表');

// 迁移用全新实例，避免与上面的 v9 导入互相干扰
for (const k of Object.keys(mem)) delete mem[k];
global.localStorage.length = 0;
const site2 = QB.create(def);

/* ---------- 2. 旧命名空间迁移 ---------- */
const q0 = qs[0], q1 = qs[1], q2 = qs[2];
const legacyId = (q0.meta && q0.meta.origin && q0.meta.origin.id) || null;
mem['csg_ans_v1'] = JSON.stringify({
  [q0._gid]: { picked: q0.answer ? q0.answer.slice() : [0], text: '', done: true, ok: true, self: null },
  [q1._gid]: { picked: [], text: ' 10 3 机\uFEFF ', done: true, ok: null, self: false }
});
mem['csg_wrong_v1'] = JSON.stringify({ [q2._gid]: 1760000000000 });
mem['csg_fav_v1'] = JSON.stringify([q2._gid]);
if (legacyId) {
  mem['csunit1_ans_v1'] = JSON.stringify({ [legacyId]: { picked: [2], text: '', done: true, ok: false, self: null } });
}
refreshLen();

const mig = site2.migrateLegacy();
ok(!mig.skipped, '迁移被跳过，应识别到旧键');
ok(mig.ans >= 2, `迁移作答 ${mig.ans} 条，至少应有 2 条`);
ok(mig.wrong >= 1, '迁移错题失败');
ok(mig.fav >= 1, '迁移收藏失败');
ok(!!site2.get(q0._gid), '迁移后 q0 记录缺失');
ok(site2.get(q1._gid) && site2.get(q1._gid).x === '10 3 机', '迁移后文字未清洗（BOM/空格应去掉）');
ok(!!site2.allWrong()[q2._gid], '迁移后错题集合为空');
ok(!!site2.allFav()[q2._gid], '迁移后收藏集合为空');
if (legacyId) {
  ok(site2.get(q0._gid) && site2.get(q0._gid).ok === true, '旧题号键的记录没有映射到 gid');
}

// 幂等 + 旧键保留
const again = site2.migrateLegacy();
ok(again.skipped === true, '第二次迁移没有跳过（不幂等）');
ok('csg_ans_v1' in mem, '迁移后旧键被删除（规范要求保留以便回退）');

/* ---------- 3. 字符集包容性 ---------- */
ok(QB.cleanText('\uFEFF中文\u200B内容').replace(/\u200B/g, '') === '中文内容', 'cleanText 未去掉 BOM / 零宽字符');
ok(QB.fuzzyEq(' ３２ ', '32'), '全角数字未归一');
const wrapped = code9.slice(0, 20) + '\n  ' + code9.slice(20);
ok(!!site.decode(wrapped).ans, '带换行空格的编码无法解码');

if (fails.length) {
  console.log('✗ 兼容性验收失败 ' + fails.length + ' 项');
  fails.forEach(f => console.log('   · ' + f));
  process.exit(1);
}
console.log(`✓ 兼容性通过：v9 解出 ${Object.keys(got.ans).length} 条；迁移 作答 ${mig.ans} / 错题 ${mig.wrong} / 收藏 ${mig.fav}，幂等且旧键保留`);
