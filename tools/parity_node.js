/* parity_node.js — 跨语言一致性检查的 Node 侧
 * 读 stdin 的 JSON（{def, state, favs, texts, scopes}），输出 {gids, codes}
 * 供 tools/parity_test.py 与 qb_gate.py 逐条比对（规范 2.3 跨语言要求）。
 */
const QB = require(process.argv[2]);
let raw = '';
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const fake = {
    data: { ans: input.state || {}, fav: input.favs || {}, wrong: {}, diag: {} },
    get(n, f) { return this.data[n] !== undefined ? this.data[n] : f; },
    set(n, v) { this.data[n] = v; },
    remove(n) { delete this.data[n]; }
  };
  const site = QB.create(input.def, fake);
  const gids = {};
  site.questions.forEach(q => { gids[q.qid] = q._gid; });
  const codes = {};
  (input.scopes || []).forEach(([kind, key]) => {
    codes[kind + ':' + key] = site.encode(kind, key);
  });
  process.stdout.write(JSON.stringify({ gids, codes, order: site.order }));
});
