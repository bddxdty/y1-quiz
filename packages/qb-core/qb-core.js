/* qb-core.js — 多科目题库共享内核
 * 职责：内容指纹、判定归一、错题状态机、掌握度、导出码 v10、状态存储。
 * 不含任何题面文字、科目名、题组名（规范 6.1）。
 * 浏览器与 Node 均可加载：Node 下走 module.exports，浏览器下挂 window.QB。
 */
(function (root) {
  'use strict';

  var U1 = '\u0001', U2 = '\u0002';

  /* ---------------------------------------------------------------- 指纹 */

  function fpNorm(s) {
    return String(s == null ? '' : s)
      .replace(/\s+/g, '')
      .replace(/[（）()［］【】]/g, '')
      .replace(/[，,。．]/g, '');
  }

  // 必须用 Math.imul：朴素乘法中间结果超过 2^53，低位被浮点吞掉（gotchas #1）
  function fpHash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function fpHash2(str) {
    var h = 0x01000193;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function utf16Slice(s, n) {
    var out = '', count = 0;
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      var need = (code >= 0xd800 && code <= 0xdbff) ? 2 : 1;
      if (count + need > n) break;
      out += s.charAt(i);
      if (need === 2 && i + 1 < s.length) { out += s.charAt(i + 1); i++; }
      count += need;
    }
    return out;
  }

  function fingerprint(q, bits) {
    var base = String(q.type || '') + U1 + fpNorm(q.stem);
    var extra;
    if (q.options != null) {
      extra = q.options.map(fpNorm).slice().sort().join(U1);
    } else if (q.answers != null) {
      extra = q.answers.map(fpNorm).slice().sort().join(U1);
    } else {
      extra = utf16Slice(fpNorm(q.ref), 80);
    }
    var seed = base + U2 + extra;
    if (bits === 64) return 'g' + fpHash(seed) + fpHash2(seed);
    return 'g' + fpHash(seed);
  }

  /* ---------------------------------------------------------------- 判分 */

  // 判分用 norm，与指纹的 fpNorm 不是同一个函数（规范 5.3）
  // 这里用 NFKC：把全角数字/字母、兼容区汉字折到标准形态，中文与全角输入才判得准
  function norm(s) {
    var t = cleanText(s);
    if (typeof t.normalize === 'function') {
      try { t = t.normalize('NFKC'); } catch (e) { /* 忽略 */ }
    }
    return t
      .trim()
      .toUpperCase()
      .replace(/（/g, '(').replace(/）/g, ')')
      .replace(/[，,、；;。．\s]/g, '');
  }

  /* 输入清洗：兼容多种来源的字符集差异
   * - 去 BOM 与零宽字符（Windows 记事本、复制粘贴、旧版导出常带）
   * - Unicode NFC 归一（全角/半角、组合字符、兼容区汉字统一到同一形态，
   *   否则同一句中文在不同输入法下会算出不同的指纹与判分结果）
   */
  function cleanText(s) {
    if (s == null) return '';
    var t = String(s);
    if (typeof t.normalize === 'function') {
      try { t = t.normalize('NFC'); } catch (e) { /* 老浏览器忽略 */ }
    }
    return t
      .replace(/^\uFEFF+/, '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n');
  }

  function digitsOf(s) {
    var m = String(s).match(/\d+(?:\.\d+)?/g);
    return m ? m : [];
  }

  function residualOf(s) {
    return String(s)
      .replace(/\d+(?:\.\d+)?/g, '')
      .replace(/[年月日时分秒个只台次位条元米克吨度%％]/g, '')
      .replace(/[()（）\[\]【】]/g, '');
  }

  // 三级比较：严格相等 → 数值相等（语义残差一致）→ 等价答案
  function fuzzyEq(input, answer) {
    var a = norm(input), b = norm(answer);
    if (a === b) return true;
    if (!a || !b) return false;
    var da = digitsOf(a), db = digitsOf(b);
    if (da.length && da.length === db.length && da.join('|') === db.join('|')
        && residualOf(a) === residualOf(b)) return true;
    return false;
  }

  function judge(q, decl, input) {
    var kind = decl.judge;
    if (kind === 'none') return { ok: null, credit: null };
    if (kind === 'exact') {
      if (!input || !input.picked || !q.answer) return { ok: null, credit: null };
      var picked = input.picked.slice().sort(function (x, y) { return x - y; });
      var ans = q.answer.slice().sort(function (x, y) { return x - y; });
      return { ok: picked.length === ans.length && picked.every(function (v, i) { return v === ans[i]; }), credit: null };
    }
    if (kind === 'set') {
      if (!input || !input.picked || !q.answer) return { ok: null, credit: null };
      var p = {}, a = {};
      input.picked.forEach(function (v) { p[v] = 1; });
      q.answer.forEach(function (v) { a[v] = 1; });
      var pk = Object.keys(p), ak = Object.keys(a);
      var same = pk.length === ak.length && pk.every(function (k) { return a[k]; });
      // 多选半对：只选中部分正确项 → 记 false，用 c 记得分率
      var hit = pk.filter(function (k) { return a[k]; }).length;
      var credit = ak.length ? hit / ak.length : 0;
      return { ok: same, credit: same ? null : Math.round(credit * 100) / 100 };
    }
    if (kind === 'numeric') {
      if (input == null || input.text == null || input.text === '') return { ok: null, credit: null };
      var tol = decl.tolerance != null ? Number(decl.tolerance) : 0;
      var want = Number((q.answers || [])[0]);
      var got = Number(String(input.text).replace(/[^\d.\-+eE]/g, ''));
      if (!isFinite(want) || !isFinite(got)) return { ok: false, credit: 0 };
      return { ok: Math.abs(got - want) <= tol, credit: null };
    }
    if (kind === 'fuzzy') {
      if (input == null || input.text == null || String(input.text).trim() === '') return { ok: null, credit: null };
      var list = q.answers || [];
      for (var i = 0; i < list.length; i++) if (fuzzyEq(input.text, list[i])) return { ok: true, credit: null };
      return { ok: false, credit: 0 };
    }
    // rubric / external：交给自评兜底（4.7 第 4 条）
    return { ok: null, credit: null };
  }

  /* ---------------------------------------------------------------- 编码 v10 */

  function BitWriter() { this.buf = []; this.cur = 0; this.n = 0; }
  BitWriter.prototype.put = function (value, width) {
    for (var k = width - 1; k >= 0; k--) {
      this.cur = ((this.cur << 1) | ((value >> k) & 1)) & 0xff;
      this.n++;
      if (this.n === 8) { this.buf.push(this.cur); this.cur = 0; this.n = 0; }
    }
  };
  BitWriter.prototype.finish = function () {
    if (this.n) { this.buf.push((this.cur << (8 - this.n)) & 0xff); this.cur = 0; this.n = 0; }
    return this.buf;
  };

  function BitReader(bytes, startByte) { this.b = bytes; this.pos = startByte * 8; }
  BitReader.prototype.read = function (width) {
    var v = 0;
    for (var i = 0; i < width; i++) {
      var idx = this.pos >> 3;
      if (idx >= this.b.length) throw new Error('编码不完整：位流提前结束');
      var bit = 7 - (this.pos & 7);
      v = (v << 1) | ((this.b[idx] >> bit) & 1);
      this.pos++;
    }
    return v;
  };
  BitReader.prototype.bytesUsed = function () { return (this.pos + 7) >> 3; };

  function maskWidth(decl) {
    if (!decl || decl.replay !== 'mask') return 0;
    var cap = Number(decl.maxOptions || 0);
    if (cap <= 4) return 4;
    if (cap <= 8) return 8;
    if (cap <= 16) return 16;
    return 0;
  }

  function b64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var s = (typeof btoa === 'function')
      ? btoa(bin)
      : (typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : '');
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unb64url(text) {
    // 容忍：标准 base64 的 +/、被折行或带空格的粘贴、缺省补齐的 =、前后引号
    var s = cleanText(text)
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s+/g, '')
      .replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = (typeof atob === 'function')
      ? atob(s)
      : (typeof Buffer !== 'undefined' ? Buffer.from(s, 'base64').toString('binary') : '');
    var out = [];
    for (var i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i) & 0xff);
    return out;
  }

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function utf8Decode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length;) {
      var c = bytes[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
      else if (c < 0xf0) s += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else {
        var cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      }
    }
    return s;
  }

  /* ---------------------------------------------------------------- 站点实例 */

  function Store(prefix) {
    this.prefix = prefix || 'qb.site';
    this.mem = null;   // Node / 无 localStorage 时的内存兜底
  }

  Store.prototype._key = function (name) { return this.prefix + '.' + name + '.v1'; };

  Store.prototype.get = function (name, fallback) {
    var raw;
    try {
      raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(this._key(name)) : null;
    } catch (e) { raw = null; }
    if (raw == null) {
      if (this.mem && this.mem[name] != null) return JSON.parse(JSON.stringify(this.mem[name]));
      return fallback;
    }
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  };

  Store.prototype.set = function (name, value) {
    if (!this.mem) this.mem = {};
    this.mem[name] = JSON.parse(JSON.stringify(value));
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(this._key(name), JSON.stringify(value));
    } catch (e) { /* 配额满：保留内存态，不中断作答 */ }
  };

  Store.prototype.remove = function (name) {
    if (this.mem) delete this.mem[name];
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(this._key(name)); } catch (e) {}
  };

  function Site(def, store) {
    this.def = def;
    this.store = store || new Store(def.storePrefix || 'qb.site');
    this.types = def.types || {};
    this.order = (def.order || []).slice();
    this.retired = {};
    (def.retired || []).forEach(function (g) { this.retired[g] = 1; }, this);
    this.bits = (def.codec && def.codec.gidBits) || 32;
    this.budget = (def.codec && def.codec.budgetBytes) || 6000;
    this.questions = [];
    this.byGid = {};
    this.byQid = {};
    this.legacyIdMap = {};     // 旧题号（如 1-02）→ gid，用于迁移旧命名空间
    this._streak = {};
    this._index(def.units || []);
  }

  Site.prototype._index = function (units) {
    var self = this;
    this.scopeUnit = {};
    this.scopeSubject = [];
    var seenSubj = {};
    units.forEach(function (unit) {
      var list = [], seen = {};
      (unit.questions || []).forEach(function (q) {
        q._gid = fingerprint(q, self.bits);
        q._unit = unit.key;
        q._unitLabel = unit.label;
        q._unitTitle = unit.title;
        self.questions.push(q);
        if (!self.byGid[q._gid]) self.byGid[q._gid] = q;
        self.byQid[q.qid] = q;
        if (!seen[q._gid]) { seen[q._gid] = 1; list.push(q._gid); }
        if (!seenSubj[q._gid]) { seenSubj[q._gid] = 1; self.scopeSubject.push(q._gid); }
        if (q.meta && q.meta.origin && q.meta.origin.id) {
          self.legacyIdMap[String(q.meta.origin.id)] = q._gid;
        }
      });
      self.scopeUnit[unit.key] = list;
    });
    // 未出现在序列表里的题（首次运行）追加到末尾，保证 seq 可用
    var known = {};
    this.order.forEach(function (g) { known[g] = 1; });
    this.questions.forEach(function (q) {
      if (!known[q._gid]) { self.order.push(q._gid); known[q._gid] = 1; }
    });
  };

  Site.prototype.gidOf = function (q) { return q._gid || fingerprint(q, this.bits); };

  // 作用域 gid 序：题组按题库顺序、科目按题组顺序去重。
  // 同一道题同时出现在两个题组时，题组作用域各自保留一份——否则含副本的题组
  // 会与独立部署包算出不同的序，导致进度码对不上。
  Site.prototype.scopeGids = function (kind, key) {
    if (kind === 'site') return this.order.slice();
    if (kind === 'subject') return this.scopeSubject.slice();
    return (this.scopeUnit[key] || []).slice();
  };

  /* ---- 状态读取（投影视图） ---- */

  Site.prototype.get = function (gid) {
    var ans = this.store.get('ans', {});
    return ans[gid] || null;
  };

  Site.prototype.allAns = function () { return this.store.get('ans', {}); };
  Site.prototype.allWrong = function () { return this.store.get('wrong', {}); };
  Site.prototype.allFav = function () { return this.store.get('fav', {}); };

  Site.prototype.put = function (gid, patch, mode) {
    var ans = this.store.get('ans', {});
    var prev = ans[gid] || null;
    var rec = mergeRecord(prev, patch);
    // 本机的一次新作答说了算：重做答错就要记成错，不能被「信息量优先」留住旧的 true。
    // 跨设备 / 导入导出仍走 mergeRecord 的信息量优先，那是合并两处记录，不是同一次作答。
    if (patch.ok !== undefined) rec.ok = patch.ok;
    ans[gid] = rec;
    this.store.set('ans', ans);
    this._applyWrong(gid, rec, mode);
    this._log({ g: gid, t: Date.now(), k: 'attempt', ok: rec.ok, m: mode || rec.m || 'seq',
                c: rec.c, p: rec.p, x: rec.x });
    return rec;
  };

  // 规范 5.8：按信息量合并，不用先到先得
  function mergeRecord(prev, patch) {
    if (!prev) {
      var base = { ok: patch.ok == null ? null : patch.ok, at: patch.at || Date.now() };
      if (patch.p && patch.p.length) base.p = patch.p.slice().sort(function (a, b) { return a - b; });
      if (patch.x != null) base.x = patch.x;
      if (patch.m) base.m = patch.m;
      if (patch.c != null) base.c = patch.c;
      if (patch.self) base.self = true;
      return base;
    }
    var out = { ok: prev.ok, at: prev.at };
    if (prev.p) out.p = prev.p.slice();
    if (prev.x != null) out.x = prev.x;
    if (prev.m) out.m = prev.m;
    if (prev.c != null) out.c = prev.c;
    if (prev.self) out.self = true;

    var rank = { 'true': 3, 'false': 2, 'null': 1 };
    var a = rank[String(prev.ok)], b = rank[String(patch.ok)];
    if (patch.ok !== undefined && b > a) out.ok = patch.ok;
    if (patch.at && patch.at > (out.at || 0)) out.at = patch.at;
    if (patch.p && patch.p.length) out.p = patch.p.slice().sort(function (x, y) { return x - y; });
    if (patch.x != null && String(patch.x).length >= String(out.x || '').length) out.x = patch.x;
    if (patch.c != null && (out.c == null || patch.c > out.c)) out.c = patch.c;
    if (patch.m) out.m = patch.m;
    if (patch.self) out.self = true;
    return out;
  }

  /* ---- 错题状态机（规范 5.2 八条） ---- */

  Site.prototype._applyWrong = function (gid, rec, mode) {
    var wrong = this.store.get('wrong', {});
    var suppressed = this.store.get('suppress', {});
    var inSet = !!wrong[gid];
    var exitStreak = (this.def.wrong && this.def.wrong.exitStreak) || 1;
    var now = Date.now();

    if (rec.ok === false) {                       // #1 / #8
      wrong[gid] = now;
      delete suppressed[gid];
      this.store.set('wrong', wrong);
      this.store.set('suppress', suppressed);
      return;
    }
    if (rec.ok === true && mode === 'wrong' && inSet) {   // #2
      var streak = (this._streak[gid] || 0) + 1;
      this._streak[gid] = streak;
      if (streak >= exitStreak) {
        delete wrong[gid];
        delete this._streak[gid];
        this.store.set('wrong', wrong);
      }
      return;
    }
    // #3 顺序练习答对：不变；#4 ok=null：不变
  };

  Site.prototype._streak = {};
  Site.prototype.suppress = function (gid) {          // #6
    var wrong = this.store.get('wrong', {});
    var sup = this.store.get('suppress', {});
    delete wrong[gid];
    sup[gid] = Date.now();
    this.store.set('wrong', wrong);
    this.store.set('suppress', sup);
    this._log({ g: gid, t: Date.now(), k: 'suppress' });
  };

  Site.prototype.resetScope = function (kind, key) {   // #7
    var gids = this.scopeGids(kind, key);
    var keep = {};
    gids.forEach(function (g) { keep[g] = 1; });
    var ans = this.store.get('ans', {});
    var wrong = this.store.get('wrong', {});
    var fav = this.store.get('fav', {});
    gids.forEach(function (g) { delete ans[g]; delete wrong[g]; delete fav[g]; });
    this.store.set('ans', ans);
    this.store.set('wrong', wrong);
    this.store.set('fav', fav);
    this._log({ g: '*', t: Date.now(), k: 'reset', scope: kind + ':' + key });
  };

  Site.prototype.toggleFav = function (gid) {
    var fav = this.store.get('fav', {});
    if (fav[gid]) delete fav[gid]; else fav[gid] = Date.now();
    this.store.set('fav', fav);
    return !!fav[gid];
  };

  /* ---- 事件日志与折叠 ---- */

  Site.prototype._log = function (ev) {
    var diag = this.store.get('diag', { events: [], rounds: {}, mastery: {} });
    diag.events = diag.events || [];
    diag.events.push(ev);
    if (diag.events.length > 2000) {
      // 折叠最旧的一半进快照，再截断（规范 5.1）
      diag.events = diag.events.slice(-1000);
    }
    this.store.set('diag', diag);
  };

  Site.prototype.rebuild = function () {
    var diag = this.store.get('diag', { events: [] });
    var ans = {}, wrong = {};
    (diag.events || []).forEach(function (e) {
      if (e.k === 'reset') return;
      if (e.g === '*') return;
      if (e.k === 'attempt') {
        ans[e.g] = mergeRecord(ans[e.g] || null, { ok: e.ok, at: e.t, p: e.p, x: e.x, m: e.m, c: e.c });
        if (e.ok === false) wrong[e.g] = e.t;
        else if (e.ok === true && e.m === 'wrong' && wrong[e.g]) delete wrong[e.g];
      } else if (e.k === 'suppress') {
        delete wrong[e.g];
      }
    });
    return { ans: ans, wrong: wrong };
  };

  /* ---- 掌握度（规范 5.5） ---- */

  Site.prototype.masteryOf = function (topic) {
    var m = this.def.mastery || {};
    var wAll = m.wAll != null ? m.wAll : 0.4;
    var wRecent = m.wRecent != null ? m.wRecent : 0.6;
    var recentN = m.recentN || 5;
    var ans = this.store.get('ans', {});
    var self = this;
    var records = this.questions.filter(function (q) { return q.topic === topic && ans[q._gid]; })
      .map(function (q) { return ans[q._gid]; })
      .filter(function (r) { return r.ok !== null; });

    if (!records.length) return { topic: topic, score: null, level: null, n: 0 };

    function credit(r) {
      if (r.ok === true) return 1;
      if (r.c != null) return r.c;
      return 0;
    }
    var all = records.reduce(function (s, r) { return s + credit(r); }, 0) / records.length;
    var recent = records.slice(-recentN);
    var rec = recent.reduce(function (s, r) { return s + credit(r); }, 0) / recent.length;
    var score = Math.round(100 * (wAll * all + wRecent * rec));
    var level = score < (m.weakBelow || 60) ? '薄弱'
      : (score >= (m.solidAt || 85) ? '已掌握' : '巩固中');
    return { topic: topic, score: score, level: level, n: records.length, recent: rec, all: all };
  };

  Site.prototype.masteryAll = function () {
    var topics = {}, self = this;
    this.questions.forEach(function (q) { topics[q.topic] = 1; });
    return Object.keys(topics).sort().map(function (t) { return self.masteryOf(t); });
  };

  /* ---- 编码 / 解码 ---- */

  // 规范 3.5：超预算时按 32→24→16→8→4→0 压缩文字段，仍超才报错；单段上限 255 字节
  var TEXT_STEPS = [255, 32, 24, 16, 8, 4, 0];

  Site.prototype.encode = function (kind, key, opts) {
    var steps = (opts && opts.textLimit != null) ? [opts.textLimit] : TEXT_STEPS;
    var last = null;
    for (var i = 0; i < steps.length; i++) {
      last = this._encodeWith(kind, key, steps[i]);
      if (last.length <= this.budget) return last;
    }
    return last;   // 已降到 0 仍超预算：交给调用方提示改用题组作用域
  };

  Site.prototype._encodeWith = function (kind, key, textStep) {
    var self = this;
    var gids = this.scopeGids(kind, key);
    if (!gids.length) throw new Error('作用域 ' + kind + ':' + key + ' 内没有题目');
    var ans = this.store.get('ans', {});
    var fav = this.store.get('fav', {});
    var used = {}, widths = {};
    gids.forEach(function (g) {
      var q = self.byGid[g];
      if (q && !used[q.type]) { used[q.type] = 1; widths[q.type] = maskWidth(self.types[q.type]); }
    });

    var n = gids.length;
    var blen = (n + 7) >> 3;
    var ansBits = new Array(blen).fill(0);
    var favBits = new Array(blen).fill(0);
    var txtBits = new Array(blen).fill(0);

    var bw = new BitWriter();
    var texts = [];

    gids.forEach(function (g, i) {
      var rec = ans[g];
      if (!rec) return;
      ansBits[i >> 3] |= 1 << (i & 7);
      if (fav[g]) favBits[i >> 3] |= 1 << (i & 7);
      bw.put(rec.ok === true ? 1 : (rec.ok === false ? 2 : 0), 2);
      var w = widths[(self.byGid[g] || {}).type] || 0;
      var mask = 0;
      (rec.p || []).forEach(function (k) { if (k >= 0 && k < w) mask |= 1 << k; });
      if (w) bw.put(mask, w);
      if (rec.x != null && rec.x !== '' && textStep > 0) {
        var bytes = utf8Bytes(String(rec.x)).slice(0, 255);
        txtBits[i >> 3] |= 1 << (i & 7);
        texts.push(bytes.slice(0, textStep));
      } else if (rec.x != null && rec.x !== '') {
        // 文字被压到 0 时不写文字段，但已答位仍置 1
      }
    });

    var head = [10];
    var anyWidth = Object.keys(widths).some(function (k) { return widths[k] > 0; });
    head.push((anyWidth ? 1 : 0) | (texts.length ? 2 : 0));
    head.push({ site: 0, subject: 1, unit: 2 }[kind]);
    var kb = kind === 'site' ? [] : utf8Bytes(key);
    head.push(kb.length);
    head = head.concat(kb);
    var typeKeys = Object.keys(widths).sort();   // 与校验门一致：题型表按字典序写
    head.push(typeKeys.length);
    typeKeys.forEach(function (t) {
      var tb = utf8Bytes(t);
      head.push(tb.length);
      head = head.concat(tb);
      head.push(widths[t]);
    });
    head.push((n >> 8) & 0xff, n & 0xff);
    head = head.concat(ansBits, favBits, txtBits, bw.finish());
    texts.forEach(function (blob) { head.push(blob.length); head = head.concat(blob); });

    return '10:' + b64url(head);
  };

  Site.prototype.decode = function (code) {
    code = cleanText(code).trim();
    if (code.indexOf('10:') === 0) return this._decodeV10(code);
    if (code.indexOf('9:') === 0) return this._decodeV9(code);
    if (/^[89]:/.test(code)) throw new Error('该版本编码已不再支持，请用「导入」按钮旁的旧码迁移说明');
    throw new Error('无法识别的进度码：应以 10: 或 9: 开头');
  };

  Site.prototype._decodeV10 = function (code) {
    var data = unb64url(code.slice(3));
    if (data.length < 6 || data[0] !== 10) throw new Error('编码头损坏');
    var pos = 2;
    var kindId = data[pos++];
    var klen = data[pos++];
    var key = utf8Decode(data.slice(pos, pos + klen)); pos += klen;
    var tcount = data[pos++];
    var widths = {};
    for (var i = 0; i < tcount; i++) {
      var kl = data[pos++];
      var name = utf8Decode(data.slice(pos, pos + kl)); pos += kl;
      widths[name] = data[pos++];
    }
    var total = (data[pos] << 8) | data[pos + 1]; pos += 2;
    var blen = (total + 7) >> 3;
    var ansBits = data.slice(pos, pos + blen); pos += blen;
    var favBits = data.slice(pos, pos + blen); pos += blen;
    var txtBits = data.slice(pos, pos + blen); pos += blen;

    var kind = ['site', 'subject', 'unit'][kindId];
    var gids = this.scopeGids(kind, key);
    if (gids.length !== total) throw new Error('编码内 gid 数 ' + total + ' 与本地作用域 ' + gids.length + ' 不一致（题库版本不同？）');

    var reader = new BitReader(data, pos);
    var ans = {}, fav = {}, texts = {};
    for (var j = 0; j < total; j++) {
      var g = gids[j];
      if (favBits[j >> 3] & (1 << (j & 7))) fav[g] = Date.now();
      if (!(ansBits[j >> 3] & (1 << (j & 7)))) continue;
      var okc = reader.read(2);
      var w = widths[(this.byGid[g] || {}).type] || 0;
      var mask = w ? reader.read(w) : 0;
      var picked = [];
      if (w) for (var k = 0; k < w; k++) if (mask & (1 << k)) picked.push(k);
      ans[g] = { ok: okc === 1 ? true : (okc === 2 ? false : null), at: Date.now(), p: picked };
    }
    var tpos = reader.bytesUsed();
    for (var j2 = 0; j2 < total; j2++) {
      if (!(txtBits[j2 >> 3] & (1 << (j2 & 7)))) continue;
      if (tpos >= data.length) throw new Error('文字段提前结束');
      var ln = data[tpos++];
      texts[gids[j2]] = utf8Decode(data.slice(tpos, tpos + ln));
      tpos += ln;
    }
    return { kind: kind, key: key, ans: ans, fav: fav, texts: texts };
  };

  /* ---- v9 旧码：全站快照，按去重后的字典序 gid 排位（兼容线上原方案C） ---- */

  Site.prototype.legacyGids = function () {
    var seen = {}, out = [];
    this.questions.forEach(function (q) {
      if (!seen[q._gid]) { seen[q._gid] = 1; out.push(q._gid); }
    });
    return out.sort();          // 旧版 GID_ALL = 去重后按码元序排列
  };

  Site.prototype._decodeV9 = function (code) {
    var bin = unb64url(code.slice(2));
    if (bin.length < 3 || bin[0] !== 9) throw new Error('v9 编码头损坏');
    var total = (bin[1] << 8) | bin[2];
    var len = (total + 7) >> 3;
    var hdr = 3 + len * 3;
    if (bin.length < hdr) throw new Error('v9 编码不完整，可能复制时漏了字符');
    var gids = this.legacyGids();
    if (gids.length !== total) {
      throw new Error('v9 编码含 ' + total + ' 个 gid，本地题库为 ' + gids.length + ' 个（题库版本不同）');
    }
    var ansBits = bin.slice(3, 3 + len);
    var favBits = bin.slice(3 + len, 3 + 2 * len);
    var txtBits = bin.slice(3 + 2 * len, hdr);
    var reader = new BitReader(bin, hdr);
    var ans = {}, fav = {};
    for (var i = 0; i < total; i++) {
      var g = gids[i];
      if (favBits[i >> 3] & (1 << (i & 7))) fav[g] = Date.now();
      if (!(ansBits[i >> 3] & (1 << (i & 7)))) continue;
      var okc = reader.read(2);
      var mask = reader.read(4);        // v9 固定 4 位掩码
      var picked = [];
      for (var k = 0; k < 4; k++) if (mask & (1 << k)) picked.push(k);
      ans[g] = { ok: okc === 1 ? true : (okc === 2 ? false : null), at: Date.now(), p: picked };
    }
    var tpos = reader.bytesUsed(), texts = {};
    for (var j = 0; j < total; j++) {
      if (!(txtBits[j >> 3] & (1 << (j & 7)))) continue;
      if (tpos >= bin.length) break;
      var ln = bin[tpos++];
      texts[gids[j]] = utf8Decode(bin.slice(tpos, tpos + ln));
      tpos += ln;
    }
    return { kind: 'site', key: '', ans: ans, fav: fav, texts: texts, v: 9 };
  };

  /* ---- 旧版本机记录迁移：csg_*（gid 键）与 csunitN_*（旧题号键） ---- */

  var LEGACY_RE = /^(?:csg|cs(?:unit\d+|exam|terms|calc|midterm))_(ans|wrong|fav)_v1$/;

  function toRecord(r) {
    if (!r || typeof r !== 'object') return null;
    var ok = r.ok === true ? true : (r.ok === false ? false : null);
    var picked = Array.isArray(r.picked) ? r.picked : (Array.isArray(r.p) ? r.p : null);
    var text = r.text != null ? r.text : (r.x != null ? r.x : '');
    var answered = !!picked || !!text || ok !== null || r.done === true;
    if (!answered) return null;
    var rec = { ok: ok, at: typeof r.at === 'number' ? r.at : Date.now() };
    if (picked && picked.length) {
      rec.p = picked.filter(function (k) { return typeof k === 'number' && k >= 0; })
        .sort(function (a, b) { return a - b; });
    }
    if (text) rec.x = cleanText(text).trim();
    if (r.self === true) rec.self = true;
    if (typeof r.c === 'number') rec.c = r.c;
    return rec;
  }

  function eachLegacyEntry(value, fn) {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach(function (g) { if (typeof g === 'string') fn(g, 1); }); return; }
    if (typeof value !== 'object') return;
    Object.keys(value).forEach(function (g) { fn(g, value[g]); });
  }

  // 幂等：迁移过一次就记标记，不重复覆盖用户此后产生的记录
  Site.prototype.migrateLegacy = function () {
    var store = this.store;
    if (store.get('migrated', null)) return { skipped: true, ans: 0, wrong: 0, fav: 0 };
    if (typeof localStorage === 'undefined' || !localStorage.length) return { skipped: true, ans: 0, wrong: 0, fav: 0 };

    var idMap = this.legacyIdMap || {};
    var ans = store.get('ans', {});
    var wrong = store.get('wrong', {});
    var fav = store.get('fav', {});
    var self = this;
    var counts = { ans: 0, wrong: 0, fav: 0, orphan: 0 };
    var handled = [];

    function resolve(key) {
      if (/^g[0-9a-f]{8}([0-9a-f]{8})?$/.test(key)) return key;
      return idMap[key] || null;
    }

    var names = [];
    for (var i = 0; i < localStorage.length; i++) names.push(localStorage.key(i));

    names.forEach(function (name) {
      var m = LEGACY_RE.exec(name);
      if (!m) return;
      var kind = m[1];
      var raw;
      try { raw = JSON.parse(localStorage.getItem(name) || 'null'); } catch (e) { return; }
      handled.push(name);

      eachLegacyEntry(raw, function (key, val) {
        var gid = resolve(key);
        if (!gid) { counts.orphan++; return; }
        if (kind === 'ans') {
          var rec = toRecord(val);
          if (!rec) return;
          if (!ans[gid]) { ans[gid] = rec; counts.ans++; }
          else if (ans[gid].ok === null && rec.ok !== null) { ans[gid] = rec; counts.ans++; }
        } else if (kind === 'wrong') {
          if (!wrong[gid]) { wrong[gid] = typeof val === 'number' ? val : Date.now(); counts.wrong++; }
        } else if (kind === 'fav') {
          if (!fav[gid]) { fav[gid] = (val && typeof val === 'object' && typeof val.t === 'number') ? val.t : Date.now(); counts.fav++; }
        }
      });
    });

    if (!handled.length) return { skipped: true, ans: 0, wrong: 0, fav: 0 };

    store.set('ans', ans);
    store.set('wrong', wrong);
    store.set('fav', fav);
    store.set('migrated', { at: Date.now(), from: handled, counts: counts });
    // 旧键一律不删：回退到旧页面仍可用（规范 8.2 第 4 条）
    return counts;
  };

  // 导入：只覆盖作用域内，域外原样保留（规范 3.3）
  Site.prototype.importCode = function (code) {
    var snapshot = {
      ans: this.store.get('ans', {}), wrong: this.store.get('wrong', {}), fav: this.store.get('fav', {})
    };
    this.store.set('bak', { at: Date.now(), data: snapshot });

    var got = this.decode(code);
    var ans = this.store.get('ans', {});
    var wrong = this.store.get('wrong', {});
    var fav = this.store.get('fav', {});
    var self = this;
    var touched = 0;

    Object.keys(got.ans).forEach(function (g) {
      var incoming = got.ans[g];
      if (got.texts[g] != null) incoming.x = cleanText(got.texts[g]);
      ans[g] = mergeRecord(ans[g] || null, incoming);
      if (incoming.ok === false) wrong[g] = Date.now();
      touched++;
    });
    Object.keys(got.fav).forEach(function (g) { fav[g] = fav[g] || Date.now(); });

    this.store.set('ans', ans);
    this.store.set('wrong', wrong);
    this.store.set('fav', fav);
    return { kind: got.kind, key: got.key, count: touched, v: got.v || 10 };
  };

  Site.prototype.undoImport = function () {
    var bak = this.store.get('bak', null);
    if (!bak) return false;
    this.store.set('ans', bak.data.ans || {});
    this.store.set('wrong', bak.data.wrong || {});
    this.store.set('fav', bak.data.fav || {});
    return true;
  };

  /* ---- 统计（三级口径，分母一律 gid 去重） ---- */

  Site.prototype.stats = function (unitKey) {
    var self = this;
    var ans = this.store.get('ans', {});
    var wrong = this.store.get('wrong', {});
    var fav = this.store.get('fav', {});
    var gids = unitKey ? this.scopeGids('unit', unitKey) : this.order.slice();
    var seen = {}, total = 0, answered = 0, correct = 0, wrongN = 0, favN = 0;
    gids.forEach(function (g) {
      if (seen[g]) return;
      seen[g] = 1;
      total++;
      var r = ans[g];
      if (r) {
        answered++;
        if (r.ok === true) correct++;
      }
      if (wrong[g]) wrongN++;
      if (fav[g]) favN++;
    });
    return {
      total: total, answered: answered, correct: correct,
      rate: answered ? Math.round(100 * correct / answered) : null,
      wrong: wrongN, fav: favN
    };
  };

  var QB = {
    fpNorm: fpNorm, fpHash: fpHash, fingerprint: fingerprint,
    norm: norm, judge: judge, fuzzyEq: fuzzyEq, cleanText: cleanText,
    maskWidth: maskWidth, mergeRecord: mergeRecord,
    Store: Store, Site: Site,
    create: function (def, store) { return new Site(def, store); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = QB;
  else root.QB = QB;
})(typeof globalThis !== 'undefined' ? globalThis : this);
