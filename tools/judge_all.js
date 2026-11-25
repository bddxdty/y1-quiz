/* judge_all.js — 逐题走真实判分路径：正确输入必须判对，错误输入必须判错。
 * 用法：node judge_all.js <页面 html> [...]
 * 覆盖 single / multi / fill / term / short / comp 六种题型，
 * 检查答案键与判分器是否对齐（选项换序后最容易在这里出错）。
 */
const fs = require('fs');
const path = require('path');
const QB = require(path.join(__dirname, '..', 'packages', 'qb-core', 'qb-core.js'));

const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

function grab(html, name) {
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

let total = 0, fails = [];
for (const file of process.argv.slice(2)) {
  const html = fs.readFileSync(file, 'utf8');
  const def = grab(html, 'QB_SITE');
  const site = QB.create(def);
  const decls = def.types || {};

  site.questions.forEach(q => {
    const decl = decls[q.type];
    total++;
    const tag = q.qid;

    if (decl.answerShape === 'choice') {
      const right = QB.judge(q, decl, { picked: q.answer.slice() });
      if (right.ok !== true) fails.push(`${tag} 正确选项未判对（ok=${right.ok}）`);
      // 错选：单选取一个非答案项；多选取答案的真子集
      if (q.type === 'single') {
        const wrongIdx = q.options.map((_, i) => i).filter(i => i !== q.answer[0]);
        const bad = QB.judge(q, decl, { picked: [wrongIdx[0]] });
        if (bad.ok !== false) fails.push(`${tag} 错选项未判错（ok=${bad.ok}）`);
      } else {
        const subset = q.answer.slice(0, q.answer.length - 1);
        const bad = QB.judge(q, decl, { picked: subset });
        if (bad.ok !== false) fails.push(`${tag} 少选未判错（ok=${bad.ok}）`);
      }
    } else if (decl.answerShape === 'tokenList') {
      q.answers.forEach(a => {
        const r = QB.judge(q, decl, { text: a });
        if (r.ok !== true) fails.push(`${tag} 标准答案「${a}」未判对（ok=${r.ok}）`);
      });
      const bad = QB.judge(q, decl, { text: '这个答案肯定不对XYZ' });
      if (bad.ok !== false) fails.push(`${tag} 乱答未判错（ok=${bad.ok}）`);
    } else {
      const r = QB.judge(q, decl, { text: '主观题作答' });
      if (r.ok !== null) fails.push(`${tag} 主观题判定应为 null，实际 ${r.ok}`);
    }
  });
  console.log(`  ${path.basename(path.dirname(file))}  ${site.questions.length} 题`);
}

console.log(`\n判分全量测试：${total} 题，失败 ${fails.length} 项`);
fails.slice(0, 20).forEach(f => console.log('  · ' + f));
process.exit(fails.length ? 1 : 0);
