/* qb-sync.js — 云端同步（手动上传 / 下载，不做任何自动网络请求）
 *
 * 与线上原方案C 完全同一套契约，保证老页面与新页面读写同一行、同一份数据：
 *   环境      window.QB_SYNC.env
 *   RPC       POST <env>.api.tcloudbasegateway.com/v1/rdb/rest/rpc/quiz_pull | quiz_push
 *   鉴权      Authorization: Bearer <publishable key>
 *   行键      (同步码, 'global')，全站一行
 *   payload   {v:1, quiz:'global', at, ans:{gid:{picked,text,done,ok,self,upd}}, del:{gid:t}, fav:{gid:{on,t}}}
 *   同步码    localStorage['csquiz_sync_code_v1']（与旧页面共用，用户不用重填）
 *
 * 内核内部记录用规范 3.2 的短键（ok/at/p/x/self），payload 用旧站的长键。
 * 转换集中在本文件的 toRemote / fromRemote，两端格式谁都不改，所以新旧页面可以并存。
 */
(function (root) {
  'use strict';

  var QB = root.QB;
  if (!QB) return;

  function Sync(site, cfg) {
    this.site = site;
    this.cfg = cfg || {};
    this.env = this.cfg.env || '';
    this.key = this.cfg.key || '';
    this.code = this.cfg.code || '';
    this.quiz = this.cfg.quiz || 'global';
    this.base = this.cfg.rpc || ('https://' + this.env + '.api.tcloudbasegateway.com/v1/rdb/rest/rpc/');
    this.busy = false;
    this.lastMsg = '';
    this.lastAt = 0;
    this.codeKey = this.cfg.codeKey || 'csquiz_sync_code_v1';
    this.stateKey = 'qb.site.sync.v1';
    var st = this._load();
    if (!this.code && st.code) this.code = st.code;
  }

  Sync.prototype._load = function () {
    try {
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(this.stateKey) : null;
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  };

  Sync.prototype._save = function (patch) {
    var st = this._load();
    for (var k in patch) st[k] = patch[k];
    st.at = Date.now();
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(this.stateKey, JSON.stringify(st)); } catch (e) {}
  };

  Sync.prototype.configured = function () {
    return !!this.env && this.key.length > 20 && this.key.indexOf('__') !== 0;
  };

  Sync.prototype.enabled = function () { return this.configured() && !!this.code; };

  Sync.prototype.setCode = function (v) {
    this.code = QB.cleanText(v).trim().toUpperCase();
    this._save({ code: this.code });
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(this.codeKey, this.code); } catch (e) {}
  };

  Sync.prototype.readSharedCode = function () {
    try {
      var v = (typeof localStorage !== 'undefined') ? localStorage.getItem(this.codeKey) : '';
      if (v && !this.code) { this.code = v; }
      return this.code || '';
    } catch (e) { return this.code || ''; }
  };

  /* ---------- 记录形态转换 ---------- */

  function toRemote(rec) {
    if (!rec) return null;
    var picked = Array.isArray(rec.p) ? rec.p.slice(0, 16) : [];
    var text = rec.x == null ? '' : String(rec.x).slice(0, 2000);
    return {
      picked: picked,
      text: text,
      done: rec.ok !== null || picked.length > 0 || text.length > 0,
      ok: rec.ok === true ? true : (rec.ok === false ? false : null),
      self: rec.self === true ? true : null,
      upd: typeof rec.at === 'number' ? rec.at : 0
    };
  }

  function fromRemote(r) {
    if (!r || typeof r !== 'object') return null;
    var rec = { ok: r.ok === true ? true : (r.ok === false ? false : null), at: typeof r.upd === 'number' ? r.upd : Date.now() };
    if (Array.isArray(r.picked) && r.picked.length) {
      rec.p = r.picked.filter(function (k) { return typeof k === 'number' && k >= 0 && k < 16; })
        .sort(function (a, b) { return a - b; });
    }
    if (typeof r.text === 'string' && r.text) rec.x = QB.cleanText(r.text);
    if (r.self === true) rec.self = true;
    return rec;
  }

  Sync.prototype._localSnap = function () {
    var site = this.site;
    var ans = site.allAns(), wrong = site.allWrong(), fav = site.allFav();
    var known = {};
    site.questions.forEach(function (q) { known[q._gid] = 1; });
    var snap = { ans: {}, del: {}, fav: {} };
    Object.keys(ans).forEach(function (g) {
      if (!known[g]) return;
      var r = toRemote(ans[g]);
      if (r) snap.ans[g] = r;
    });
    Object.keys(fav).forEach(function (g) { if (known[g]) snap.fav[g] = { on: true, t: fav[g] || 0 }; });
    return snap;
  };

  Sync.prototype._remoteSnap = function (payload) {
    var known = {};
    this.site.questions.forEach(function (q) { known[q._gid] = 1; });
    var snap = { ans: {}, del: {}, fav: {} };
    var a = (payload && payload.ans) || {};
    var d = (payload && payload.del) || {};
    var f = (payload && payload.fav) || {};
    Object.keys(a).forEach(function (g) {
      if (!known[g]) return;
      var r = fromRemote(a[g]);
      if (r) snap.ans[g] = toRemote(r);
    });
    Object.keys(d).forEach(function (g) { if (known[g] && typeof d[g] === 'number') snap.del[g] = d[g]; });
    Object.keys(f).forEach(function (g) {
      if (known[g] && f[g] && typeof f[g] === 'object') snap.fav[g] = { on: f[g].on === true, t: typeof f[g].t === 'number' ? f[g].t : 0 };
    });
    return snap;
  };

  /* 合并：并集，同一条取 upd 较新者；墓碑优先 */
  function combine(a, b) {
    var out = { ans: {}, del: {}, fav: {} };
    [b, a].forEach(function (src) {
      Object.keys(src.ans).forEach(function (g) {
        var cur = out.ans[g];
        if (!cur || (src.ans[g].upd || 0) >= (cur.upd || 0)) out.ans[g] = src.ans[g];
      });
    });
    var dels = {};
    [a, b].forEach(function (src) {
      Object.keys(src.del).forEach(function (g) { dels[g] = Math.max(dels[g] || 0, src.del[g]); });
    });
    Object.keys(dels).forEach(function (g) {
      var rec = out.ans[g];
      if (!rec || dels[g] >= (rec.upd || 0)) { delete out.ans[g]; out.del[g] = dels[g]; }
    });
    var keys = {};
    Object.keys(a.fav).forEach(function (k) { keys[k] = 1; });
    Object.keys(b.fav).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var x = a.fav[k], y = b.fav[k];
      out.fav[k] = (x && y) ? ((x.t || 0) >= (y.t || 0) ? x : y) : (x || y);
    });
    return out;
  }

  Sync.prototype._apply = function (snap) {
    var site = this.site;
    var ans = site.allAns(), fav = site.allFav();
    Object.keys(snap.ans).forEach(function (g) {
      var incoming = fromRemote(snap.ans[g]);
      if (incoming) ans[g] = QB.mergeRecord(ans[g] || null, incoming);
    });
    Object.keys(snap.del).forEach(function (g) { delete ans[g]; });
    Object.keys(snap.fav).forEach(function (g) { if (snap.fav[g].on) fav[g] = snap.fav[g].t || Date.now(); else delete fav[g]; });
    site.store.set('ans', ans);
    site.store.set('fav', fav);
  };

  Sync.prototype._payload = function (snap) {
    var ans = {};
    Object.keys(snap.ans).forEach(function (g) {
      var r = snap.ans[g];
      ans[g] = { picked: r.picked, text: r.text, done: r.done, ok: r.ok, self: r.self, upd: r.upd };
    });
    return { v: 1, quiz: this.quiz, at: Date.now(), ans: ans, del: snap.del, fav: snap.fav };
  };

  /* ---------- 网络 ---------- */

  Sync.prototype._rpc = function (fn, body) {
    var self = this;
    return fetch(this.base + fn, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + this.key
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      // 统一按 UTF-8 文本解析，避免响应头缺 charset 时按 latin-1 解出乱码
      var json;
      try { json = JSON.parse(text); } catch (e) { throw new Error('云端返回非 JSON'); }
      if (json && json.ok === false && json.error === 'conflict') return json;
      if (!json || json.ok === false) throw new Error((json && json.error) || '云端返回异常');
      return json;
    });
  };

  Sync.prototype._guard = function () {
    if (!this.configured()) return '同步未配置（缺少环境或 Key）';
    if (!this.code) return '请先填写并保存同步码';
    if (this.busy) return '正在同步中';
    return null;
  };

  Sync.prototype.upload = function () {
    var self = this, why = this._guard();
    if (why) return Promise.reject(new Error(why));
    this.busy = true;

    function once() {
      return self._rpc('quiz_pull', { p_code: self.code, p_quiz: self.quiz }).then(function (r) {
        var merged = combine(self._localSnap(), self._remoteSnap(r.payload));
        return self._rpc('quiz_push', {
          p_code: self.code, p_quiz: self.quiz,
          p_base_rev: r.rev || 0, p_payload: self._payload(merged)
        }).then(function (res) { return { res: res, merged: merged }; });
      });
    }

    return once().then(function (x) {
      if (x.res && x.res.ok === false && x.res.error === 'conflict') return once();   // 被别的设备抢先，重来一次
      self._apply(x.merged);
      self._save({ rev: x.res.rev || 0, code: self.code });
      self.busy = false;
      return { count: Object.keys(x.merged.ans).length };
    }).catch(function (e) { self.busy = false; throw e; });
  };

  Sync.prototype.download = function () {
    var self = this, why = this._guard();
    if (why) return Promise.reject(new Error(why));
    this.busy = true;
    return this._rpc('quiz_pull', { p_code: this.code, p_quiz: this.quiz }).then(function (r) {
      var merged = combine(self._localSnap(), self._remoteSnap(r.payload));
      self._apply(merged);
      self._save({ rev: r.rev || 0, code: self.code });
      self.busy = false;
      return { count: Object.keys(merged.ans).length };
    }).catch(function (e) { self.busy = false; throw e; });
  };

  Sync.prototype.pending = function () {
    var st = this._load();
    var since = st.at || 0;
    var n = 0;
    var ans = this.site.allAns();
    Object.keys(ans).forEach(function (g) { if ((ans[g].at || 0) > since) n++; });
    return n;
  };

  root.QBSync = { create: function (site, cfg) { return new Sync(site, cfg); }, toRemote: toRemote, fromRemote: fromRemote };
})(typeof globalThis !== 'undefined' ? globalThis : this);
