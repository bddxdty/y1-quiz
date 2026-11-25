/* smoke_test.js — 用构建产物里的真实数据跑内核行为验收（规范附录 D）
 * 用法：node tools/smoke_test.js <页面 html>
 * 无浏览器：用内存版 localStorage 顶替。
 */
const fs = require('fs');
const path = require('path');
const QB = require(path.join(__dirname, '..', 'packages', 'qb-core', 'qb-core.js'));

const html = fs.readFileSync(process.argv[2], 'utf8');

function grab(name) {
  const key = 'window.' + name + '=';
  const i = html.indexOf(key);
  if (i < 0) throw new Error('页面里找不到 window.' + name);
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

// 内存版 localStorage
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

const def = grab('QB_SITE');
const site = QB.create(def);
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

// 1. 题目与 gid
ok(site.questions.length > 0, '页面没有题目');
const orderSet = new Set(site.order);
site.questions.forEach(q => ok(orderSet.has(q._gid), `${q.qid} 的 gid 不在 order 内`));

// 2. 错题状态机（规则 #1 #3 #2）
const choice = site.questions.find(q => (def.types[q.type] || {}).answerShape === 'choice');
if (choice) {
  const wrongAnswer = choice.options.map((_, i) => i).filter(i => !(choice.answer || []).includes(i));

  site.put(choice._gid, { ok: false, p: wrongAnswer.slice(0, 1), at: 1 }, 'seq');
  ok(!!site.allWrong()[choice._gid], '答错后未进入错题本（规则 #1）');

  site.put(choice._gid, { ok: true, p: choice.answer.slice(), at: 2 }, 'seq');
  ok(!!site.allWrong()[choice._gid], '顺序练习答对却移出了错题本（规则 #3 被破坏）');

  site.put(choice._gid, { ok: true, p: choice.answer.slice(), at: 3 }, 'wrong');
  ok(!site.allWrong()[choice._gid], '错题本里答对后未移出错题本（规则 #2）');

  // 重做：已答对的题再做错，判定必须跟着改，否则错题永远收不回来
  site.put(choice._gid, { ok: true, p: choice.answer.slice(), at: 4 }, 'seq');
  site.put(choice._gid, { ok: false, p: wrongAnswer.slice(0, 1), at: 5 }, 'seq');
  ok(site.get(choice._gid).ok === false, '重做答错后判定仍停在「答对」，重做无效');
  ok(!!site.allWrong()[choice._gid], '重做答错后没有回到错题本');
  site.put(choice._gid, { ok: true, p: choice.answer.slice(), at: 6 }, 'wrong');

  // 重做：已答对的题再做错，判定必须跟着改，否则错题永远收不回来
  site.put(choice._gid, { ok: true, p: choice.answer.slice(), at: 4 }, 'seq');
  site.put(choice._gid, { ok: false, p: wrongAnswer.slice(0, 1), at: 5 }, 'seq');
  ok(site.get(choice._gid).ok === false, '重做答错后判定仍停在「答对」，重做无效');
  ok(!!site.allWrong()[choice._gid], '重做答错后没有回到错题本');
  site.put(choice._gid, { ok: true, p: choice.answer.slice(), at: 6 }, 'wrong');
} else {
  const q = site.questions[0];
  site.put(q._gid, { ok: false, at: 1, x: '答错' }, 'seq');
  ok(!!site.allWrong()[q._gid], '答错后未进入错题本（规则 #1）');
}

// 3. 编码往返（同语言）
const kind = def.units.length === 1 ? 'unit' : 'unit';
const key = def.units[0].key;
const before = JSON.stringify(site.allAns());
const code = site.encode(kind, key);
ok(code.length <= (site.budget || 6000), `导出码 ${code.length} 字节超出预算`);
const dec = site.decode(code);
const answeredInScope = site.scopeGids(kind, key).filter(g => site.get(g)).length;
ok(Object.keys(dec.ans).length === answeredInScope,
   `解码得到 ${Object.keys(dec.ans).length} 条，本地已答 ${answeredInScope} 条`);
ok(JSON.stringify(site.allAns()) === before, '编码过程改动了本地状态');

// 4. 掌握度
const topic = (choice || site.questions[0]).topic;
const m = site.masteryOf(topic);
ok(m.n > 0 && m.score != null, `知识点「${topic}」掌握度未算出`);

// 5. 事件重放一致
const snap = site.rebuild();
const ansNow = site.allAns();
const same = Object.keys(ansNow).every(g => snap.ans[g] && snap.ans[g].ok === ansNow[g].ok);
ok(same, 'rebuild(事件日志) 与当前快照不一致（规则 #6 被破坏）');

// 6. 导入只覆盖作用域内
const otherKey = def.units.length > 1 ? def.units[1].key : null;
if (otherKey) {
  const g = site.scopeGids('unit', otherKey)[0];
  site.put(g, { ok: true, at: 9 }, 'seq');
  const keep = site.get(g);
  site.importCode(code);
  ok(!!site.get(g) === !!keep, '导入题组作用域的码后，作用域外的记录被清空（规则 #3 被破坏）');
}

if (fails.length) {
  console.log('✗ ' + path.basename(path.dirname(process.argv[2])) + '  ' + fails.length + ' 项失败');
  fails.slice(0, 8).forEach(f => console.log('   · ' + f));
  process.exit(1);
}
console.log(`✓ ${path.basename(path.dirname(process.argv[2]))}  ${site.questions.length} 题  `
  + `${Object.keys(site.allAns()).length} 条记录  ${code.length} 字节`);
