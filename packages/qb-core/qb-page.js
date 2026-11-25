/* qb-page.js — 练习页渲染层
 * 只读 window.QB_SITE（站点定义 + 本题组题目），所有状态变更走 QB 内核（规范 6.4）。
 */
(function () {
  'use strict';

  var def = window.QB_SITE;
  var meta = window.QB_META || {};
  if (!def) return;

  var site = QB.create(def);
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var S = {
    mode: 'seq',
    type: '',
    diff: '',
    kw: '',
    list: [],
    idx: 0,
    shown: {},       // qid -> true，已揭晓答案
    redo: {},        // qid -> true，本题正在重做，忽略旧记录
    draft: {}        // qid -> 当前输入
  };

  var DIFF_ORDER = { '易': 0, '中': 1, '难': 2 };
  var TYPE_ORDER = Object.keys(def.types || {});

  /* ------------------------------------------------------------ 路由 */

  function readRoute() {
    var h = location.hash.replace(/^#/, '');
    var p = new URLSearchParams(h);
    S.mode = p.get('mode') || 'seq';
    S.type = p.get('t') || '';
    S.diff = p.get('d') || '';
    S.kw = p.get('kw') || '';
    var qid = p.get('q');
    if (qid) S.pendingQid = qid;
  }

  function writeRoute() {
    var p = new URLSearchParams();
    if (S.mode !== 'seq') p.set('mode', S.mode);
    if (S.type) p.set('t', S.type);
    if (S.diff) p.set('d', S.diff);
    if (S.kw) p.set('kw', S.kw);
    var q = S.list[S.idx];
    if (q) p.set('q', q.qid);
    var url = location.pathname + '#' + p.toString();
    try { history.replaceState(null, '', url); } catch (e) { /* file:// 下可能被拒，忽略 */ }
  }

  /* ------------------------------------------------------------ 组卷 */

  function buildList() {
    var ans = site.allAns(), wrong = site.allWrong(), fav = site.allFav();
    var all = site.questions.slice();

    if (S.type) all = all.filter(function (q) { return q.type === S.type; });
    if (S.diff) all = all.filter(function (q) { return q.diff === S.diff; });
    if (S.kw) {
      var kw = S.kw.toLowerCase();
      all = all.filter(function (q) {
        return (q.stem + ' ' + q.topic + ' ' + (q.exp || '')).toLowerCase().indexOf(kw) >= 0;
      });
    }

    if (S.mode === 'wrong') all = all.filter(function (q) { return wrong[q._gid]; });
    else if (S.mode === 'fav') all = all.filter(function (q) { return fav[q._gid]; });
    else if (S.mode === 'undone') all = all.filter(function (q) { return !ans[q._gid]; });

    if (S.mode === 'random') {
      for (var i = all.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = all[i]; all[i] = all[j]; all[j] = t;
      }
    }
    S.list = all;
    if (S.pendingQid) {
      var k = all.findIndex(function (q) { return q.qid === S.pendingQid; });
      if (k >= 0) S.idx = k;
      S.pendingQid = null;
    }
    if (S.idx >= all.length) S.idx = Math.max(0, all.length - 1);
  }

  /* ------------------------------------------------------------ 渲染 */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // 显示优先用构建期排好版的视图（公式是内联 SVG），没有就转义纯文本
  function view(q, field, fallback) {
    if (q.views && q.views[field] != null) return q.views[field];
    var raw = fallback !== undefined ? fallback : q[field];
    return esc(raw).replace(/\n/g, '<br>');
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderStats() {
    var st = site.stats(def.units.length === 1 ? def.units[0].key : null);
    var box = $('#stats');
    box.innerHTML = '';
    var items = [
      ['进度', st.answered + ' / ' + st.total, st.total ? Math.round(100 * st.answered / st.total) : 0],
      ['正确率', st.rate == null ? '—' : st.rate + '%', st.rate || 0],
      ['错题', String(st.wrong), 0],
      ['收藏', String(st.fav), 0]
    ];
    items.forEach(function (it) {
      var c = el('div', 'stat');
      c.appendChild(el('div', 'stat-k', it[0]));
      c.appendChild(el('div', 'stat-v', it[1]));
      if (it[2]) {
        var bar = el('div', 'stat-bar');
        var fill = el('i');
        fill.style.width = it[2] + '%';
        bar.appendChild(fill);
        c.appendChild(bar);
      }
      box.appendChild(c);
    });
    var label = def.units.length === 1 ? '题组口径' : '题库集口径（gid 去重）';
    $('#stats').setAttribute('data-scope', label);
  }

  function renderFilters() {
    var tsel = $('#f-type');
    if (tsel.options.length <= 1) {
      TYPE_ORDER.forEach(function (t) {
        var o = el('option', null, def.types[t].label || t);
        o.value = t;
        tsel.appendChild(o);
      });
    }
    tsel.value = S.type;
    $('#f-diff').value = S.diff;
    $('#f-kw').value = S.kw;
    $$('#modes button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mode === S.mode);
    });
  }

  function optionMark(q, i) {
    return String.fromCharCode(65 + i);
  }

  function renderCard() {
    var card = $('#card');
    card.innerHTML = '';
    var q = S.list[S.idx];

    if (!q) {
      var empty = el('div', 'empty');
      empty.appendChild(el('div', 'empty-t', S.mode === 'wrong' ? '错题本是空的' : (S.mode === 'fav' ? '还没有收藏' : '没有符合条件的题目')));
      empty.appendChild(el('p', 'empty-s', S.mode === 'wrong'
        ? '答错的题会自动进入这里；在错题本里做对一次才会移出。'
        : '换个筛选条件，或者切回顺序练习。'));
      card.appendChild(empty);
      $('#nav').innerHTML = '';
      return;
    }

    var decl = def.types[q.type] || {};
    var rec = site.get(q._gid);
    // 错题本里默认让人重做：不预置上次的选项、也不提前摊开答案。
    // 点「重做」的题同理；其余模式仍按「做过就显示结果」的老规矩。
    var redoing = !!S.redo[q.qid] || (S.mode === 'wrong' && !S.shown[q.qid]);
    var revealed = !redoing && (!!S.shown[q.qid] || (rec && rec.ok !== null));
    var fav = site.allFav()[q._gid];

    var head = el('div', 'q-head');
    var tag = el('span', 'tag tag-type', decl.label || q.type);
    head.appendChild(tag);
    head.appendChild(el('span', 'tag tag-diff d-' + (DIFF_ORDER[q.diff] != null ? DIFF_ORDER[q.diff] : 1), q.diff));
    head.appendChild(el('span', 'q-topic', q.topic));
    var no = el('span', 'q-no', (S.idx + 1) + ' / ' + S.list.length);
    head.appendChild(no);
    card.appendChild(head);

    var stem = el('div', 'q-stem');
    stem.innerHTML = view(q, 'stem');
    card.appendChild(stem);

    if (q.media && q.media.img) {
      var im = el('img', 'q-img');
      im.src = q.media.img;
      im.alt = '题图';
      card.appendChild(im);
    }

    var area = el('div', 'q-area');

    if (decl.answerShape === 'choice') {
      var opts = el('div', 'opts');
      var picked = redoing ? (S.draft[q.qid] || [])
        : ((rec && rec.p) ? rec.p.slice() : (S.draft[q.qid] || []));
      q.options.forEach(function (text, i) {
        var b = el('button', 'opt');
        b.type = 'button';
        b.dataset.i = String(i);
        if (picked.indexOf(i) >= 0) b.classList.add('picked');
        if (revealed) {
          b.disabled = true;
          if ((q.answer || []).indexOf(i) >= 0) b.classList.add('right');
          else if (picked.indexOf(i) >= 0) b.classList.add('wrong');
        }
        var k = el('span', 'opt-k', optionMark(q, i));
        b.appendChild(k);
        var ot = el('span', 'opt-t');
        ot.innerHTML = (q.views && q.views.opts && q.views.opts[i] != null) ? q.views.opts[i] : esc(text);
        b.appendChild(ot);
        b.addEventListener('click', function () { pick(q, decl, i); });
        opts.appendChild(b);
      });
      area.appendChild(opts);
      if (decl.judge === 'set' && !revealed) {
        var tip = el('p', 'hint', '多选题：选好后点「提交」');
        area.appendChild(tip);
      }
    } else if (decl.answerShape === 'tokenList') {
      var inp = el('input', 'in');
      inp.type = 'text';
      inp.placeholder = '在此填写答案';
      inp.value = redoing ? (S.draft[q.qid] || '') : ((rec && rec.x) || S.draft[q.qid] || '');
      inp.disabled = revealed;
      inp.addEventListener('input', function () { S.draft[q.qid] = inp.value; });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(q, decl); });
      area.appendChild(inp);
    } else {
      var ta = el('textarea', 'ta');
      ta.placeholder = '写出你的答案或关键步骤，提交后与参考答案对照自评';
      ta.value = redoing ? (S.draft[q.qid] || '') : ((rec && rec.x) || S.draft[q.qid] || '');
      ta.disabled = revealed;
      ta.rows = 5;
      ta.addEventListener('input', function () { S.draft[q.qid] = ta.value; });
      area.appendChild(ta);
    }
    card.appendChild(area);

    var bar = el('div', 'q-bar');
    if (!revealed) {
      var sub = el('button', 'btn primary', '提交');
      sub.addEventListener('click', function () { submit(q, decl); });
      bar.appendChild(sub);
      if (decl.judge === 'rubric') {
        bar.appendChild(el('span', 'hint', '主观题：提交后对照参考答案自评'));
      }
      var peek = el('button', 'btn ghost', '看答案');
      peek.addEventListener('click', function () { S.shown[q.qid] = true; render(); });
      bar.appendChild(peek);
    } else {
      // 只点过「看答案」还没作答时 rec 为空，别显示成「待自评」
      var vClass = !rec ? 'mid' : (rec.ok === true ? 'ok' : (rec.ok === false ? 'bad' : 'mid'));
      var vText = !rec ? '未作答 · 仅看答案' : (rec.ok === true ? '✓ 答对' : (rec.ok === false ? '✗ 答错' : '待自评'));
      var verdict = el('div', 'verdict ' + vClass);
      verdict.textContent = vText;
      bar.appendChild(verdict);
      if (rec && rec.c != null && rec.ok === false) bar.appendChild(el('span', 'hint', '得分率 ' + Math.round(rec.c * 100) + '%'));
      var again = el('button', 'btn', '重做本题');
      again.addEventListener('click', function () { redoOne(q); });
      bar.appendChild(again);
    }
    var favBtn = el('button', 'btn ghost' + (fav ? ' on' : ''), fav ? '★ 已收藏' : '☆ 收藏');
    favBtn.addEventListener('click', function () {
      site.toggleFav(q._gid);
      render();
    });
    bar.appendChild(favBtn);
    if (rec && site.allWrong()[q._gid]) {
      var sup = el('button', 'btn ghost', '移出错题本');
      sup.addEventListener('click', function () { site.suppress(q._gid); render(); });
      bar.appendChild(sup);
    }
    card.appendChild(bar);

    if (revealed) {
      var exp = el('div', 'exp');
      exp.appendChild(el('div', 'exp-h', '答案与解析'));
      var ansText = answerText(q, decl);
      if (ansText) {
        var a = el('p', 'exp-a');
        a.innerHTML = '<b>答案：</b>' + ansText;
        exp.appendChild(a);
      }
      if (q.exp) {
        var p = el('p', 'exp-p');
        p.innerHTML = view(q, 'exp');
        exp.appendChild(p);
      }
      if (q.meta && q.meta.source) {
        exp.appendChild(el('p', 'exp-src', '来源：' + q.meta.source + (q.meta.paperNo ? ' 第 ' + q.meta.paperNo + ' 题' : '')));
      }
      if (decl.judge === 'rubric' && rec && rec.ok === null) {
        var self = el('div', 'self');
        self.appendChild(el('span', 'hint', '自评：'));
        [['达标', true, null], ['部分达标', false, 0.5], ['未达标', false, 0]].forEach(function (t) {
          var b = el('button', 'btn small', t[0]);
          b.addEventListener('click', function () { selfJudge(q, t[1], t[2]); });
          self.appendChild(b);
        });
        exp.appendChild(self);
      }
      card.appendChild(exp);
    }

    var nav = $('#nav');
    nav.innerHTML = '';
    var prev = el('button', 'btn', '← 上一题');
    prev.disabled = S.idx === 0;
    prev.addEventListener('click', function () { go(S.idx - 1); });
    var next = el('button', 'btn primary', '下一题 →');
    next.disabled = S.idx >= S.list.length - 1;
    next.addEventListener('click', function () { go(S.idx + 1); });
    nav.appendChild(prev);
    if (S.mode === 'wrong' && S.list.length) {
      var all = el('button', 'btn small', '全部重做');
      all.title = '清空本轮在错题本里的作答状态，从头再做一遍';
      all.addEventListener('click', function () {
        S.list.forEach(function (x) { delete S.shown[x.qid]; delete S.draft[x.qid]; S.redo[x.qid] = true; });
        S.idx = 0;
        render();
        flash('已清空本轮作答，从头开始');
      });
      nav.appendChild(all);
    }
    nav.appendChild(el('span', 'nav-mid', (S.idx + 1) + ' / ' + S.list.length));
    nav.appendChild(next);
  }

  function answerText(q, decl) {
    if (decl.answerShape === 'choice') {
      return (q.answer || []).map(function (i) {
        var t = (q.views && q.views.opts && q.views.opts[i] != null) ? q.views.opts[i] : esc(q.options[i]);
        return optionMark(q, i) + '. ' + t;
      }).join('；');
    }
    if (decl.answerShape === 'tokenList') {
      var list = (q.views && q.views.answers && q.views.answers.length) ? q.views.answers : (q.answers || []).map(esc);
      return list.join(' / ');
    }
    return (q.views && q.views.ref) ? q.views.ref : (q.ref ? esc(String(q.ref)) : '');
  }

  /* ------------------------------------------------------------ 交互 */

  // 重新作答一道题：清掉本次会话的揭晓标记与草稿，回到未作答状态
  function redoOne(q) {
    S.redo[q.qid] = true;
    delete S.shown[q.qid];
    delete S.draft[q.qid];
    render();
    flash('已清空，可以重做了');
  }

  function pick(q, decl, i) {
    var cur = (S.draft[q.qid] || []).slice();
    if (decl.judge === 'set') {
      var k = cur.indexOf(i);
      if (k >= 0) cur.splice(k, 1); else cur.push(i);
      S.draft[q.qid] = cur;
      renderCard();
    } else {
      S.draft[q.qid] = [i];
      submit(q, decl);
    }
  }

  function submit(q, decl) {
    var input = { picked: S.draft[q.qid] || [], text: S.draft[q.qid] || '' };
    if (decl.answerShape === 'choice') input = { picked: S.draft[q.qid] || [] };
    else input = { text: S.draft[q.qid] || '' };

    if (decl.answerShape === 'choice' && (!input.picked || !input.picked.length)) {
      flash('先选一个选项');
      return;
    }
    if (decl.answerShape !== 'choice' && !String(input.text).trim()) {
      flash('先写下答案');
      return;
    }

    var res = QB.judge(q, decl, input);
    var patch = { ok: res.ok, at: Date.now(), m: S.mode };
    if (decl.replay === 'mask' && input.picked) patch.p = input.picked;
    if (decl.replay === 'text' && input.text != null) patch.x = String(input.text);
    if (res.credit != null) patch.c = res.credit;
    if (res.ok === null) patch.self = false;

    site.put(q._gid, patch, S.mode);
    delete S.redo[q.qid];
    S.shown[q.qid] = true;
    if (S.mode === 'wrong' && res.ok === true) flash('答对了，已移出错题本');
    render();
  }

  function selfJudge(q, ok, credit) {
    var patch = { ok: ok, at: Date.now(), m: S.mode, self: true };
    if (credit != null) patch.c = credit;
    var rec = site.get(q._gid);
    if (rec && rec.x != null) patch.x = rec.x;
    site.put(q._gid, patch, S.mode);
    delete S.redo[q.qid];
    S.shown[q.qid] = true;
    if (S.mode === 'wrong' && ok === true) flash('答对了，已移出错题本');
    render();
  }

  /* 翻题后不把页面拉回顶部。
     只在题卡顶部已经滚出视野上方（rect.top < 8）时，把它瞬时拉回视野；
     卡片顶部还在视野里就完全不动。用瞬时滚动、不用 smooth——
     平滑滚动会和滑动翻题的滑出动画叠在一起，观感就是「回弹」。 */
  function keepCardInView() {
    var c = $('#card');
    if (!c) return;
    var top = c.getBoundingClientRect().top;
    if (top >= 8) return;
    var y = (window.scrollY || window.pageYOffset || 0) + top - 8;
    window.scrollTo(0, y > 0 ? y : 0);
  }

  function go(i) {
    if (i < 0 || i >= S.list.length) return;
    S.idx = i;
    render();
    keepCardInView();
  }

  var flashTimer = null;
  function flash(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { t.classList.remove('on'); }, 1600);
  }

  /* ------------------------------------------------------------ 掌握度 */

  function renderMastery() {
    var rows = site.masteryAll().filter(function (r) { return r.n > 0; });
    var box = $('#mastery');
    box.innerHTML = '';
    if (!rows.length) {
      box.appendChild(el('p', 'hint', '还没有作答记录，掌握度会在作答后出现。'));
      return;
    }
    var table = el('table', 'mt');
    var thead = el('thead');
    var tr = el('tr');
    ['知识点', '得分', '状态', '作答数'].forEach(function (h) { tr.appendChild(el('th', null, h)); });
    thead.appendChild(tr);
    table.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) {
      var tr2 = el('tr');
      tr2.appendChild(el('td', 'mt-t', r.topic));
      tr2.appendChild(el('td', 'mt-s', String(r.score)));
      var lv = el('td');
      lv.appendChild(el('span', 'lv ' + (r.level === '已掌握' ? 'lv-ok' : (r.level === '薄弱' ? 'lv-bad' : 'lv-mid')), r.level));
      tr2.appendChild(lv);
      tr2.appendChild(el('td', 'mt-n', String(r.n)));
      tb.appendChild(tr2);
    });
    table.appendChild(tb);
    box.appendChild(table);
  }

  /* ------------------------------------------------------------ 导出导入 */

  function initTransfer() {
    var sel = $('#x-scope');
    if (def.units.length === 1) {
      sel.innerHTML = '';
      var o = el('option', null, '本题库');
      o.value = 'unit:' + def.units[0].key;
      sel.appendChild(o);
    } else {
      var s1 = el('option', null, '全站');
      s1.value = 'site:';
      sel.appendChild(s1);
      def.units.forEach(function (u) {
        var o2 = el('option', null, u.label + ' ' + u.title);
        o2.value = 'unit:' + u.key;
        sel.appendChild(o2);
      });
    }

    $('#x-do').addEventListener('click', function () {
      var v = sel.value.split(':');
      try {
        var code = site.encode(v[0], v[1]);
        $('#x-code').value = code;
        $('#x-info').textContent = '已生成 ' + code.length + ' 字符（预算 ' + site.budget + '）'
          + (code.length > site.budget ? '，超出预算，建议改用题组作用域' : '');
      } catch (e) {
        $('#x-info').textContent = '生成失败：' + e.message;
      }
    });

    $('#x-copy').addEventListener('click', function () {
      var ta = $('#x-code');
      if (!ta.value) return flash('先生成导出码');
      ta.select();
      try { document.execCommand('copy'); flash('已复制'); } catch (e) { flash('请手动复制'); }
    });

    $('#x-import').addEventListener('click', function () {
      var code = $('#x-code').value.trim();
      if (!code) return flash('请粘贴导出码');
      try {
        var r = site.importCode(code);
        $('#x-info').textContent = '已导入 ' + r.count + ' 条（' + r.kind + ':' + (r.key || '全站') + '），作用域外记录未改动';
        reload();
      } catch (e) {
        $('#x-info').textContent = '导入失败：' + e.message;
      }
    });

    $('#x-undo').addEventListener('click', function () {
      if (site.undoImport()) { $('#x-info').textContent = '已撤销上次导入'; reload(); }
      else $('#x-info').textContent = '没有可撤销的导入';
    });

    $('#reset').addEventListener('click', function () {
      if (!confirm('清空本题库在本机的作答、错题与收藏记录？此操作不可撤销。')) return;
      site.resetScope(def.units.length === 1 ? 'unit' : 'site', def.units.length === 1 ? def.units[0].key : '');
      S.shown = {}; S.redo = {}; S.draft = {};
      reload();
      flash('已清空');
    });
  }

  /* ------------------------------------------------------------ 云同步 */

  function initCloud() {
    var wrap = $('#cloud-wrap');
    if (!wrap) return;
    var cfg = window.QB_SYNC_CFG;
    if (!cfg || !window.QBSync) return;
    wrap.style.display = '';

    var sync = window.QBSync.create(site, cfg);
    var codeInput = $('#s-code');
    var info = $('#s-info');
    var saved = sync.readSharedCode();
    if (saved) codeInput.value = saved;

    function say(msg) { info.textContent = msg; }

    $('#s-save').addEventListener('click', function () {
      var v = codeInput.value.trim();
      if (v.length < 10) return say('同步码至少 10 位（它是唯一凭证）');
      sync.setCode(v);
      codeInput.value = sync.code;
      say('已保存，本机所有题库共用这个同步码');
    });

    function run(fn, label) {
      var why = sync._guard();
      if (why) return say(why);
      say(label + '中…');
      fn().then(function (r) {
        say(label + '完成，云端共 ' + r.count + ' 条记录');
        render();
      }).catch(function (e) {
        say(label + '失败：' + e.message);
      });
    }

    $('#s-up').addEventListener('click', function () { run(function () { return sync.upload(); }, '上传'); });
    $('#s-down').addEventListener('click', function () { run(function () { return sync.download(); }, '下载'); });

    var pend = sync.pending();
    say(pend ? ('有 ' + pend + ' 条本机改动尚未上传') : '同步码与云端一致时即可手动上传 / 下载');
  }

  /* ------------------------------------------------------------ 手势翻题 */

  /* 左滑 → 下一题，右滑 → 上一题。所有题库共用这一份实现，页面不再各自绑定。
     翻页走 go()，与「上一题 / 下一题」按钮同一条路径，不另起一套状态。
     判定：水平位移 ≥ 56px、水平 ≥ 垂直 × 1.2、时长 ≤ 1.2s；
     起手点在输入控件 / 控制区 / 折叠面板 / 可横向滚动的公式块内不触发；
     纵向滑动超过阈值即判定为滚动并让位，全程 passive，不抢页面滚动。 */
  function initSwipe() {
    var MIN_X = 56;      // 触发所需最小水平位移
    var LOCK_X = 12;     // 锁定为横向手势的位移
    var LOCK_Y = 14;     // 纵向位移超过它且大于横向 → 判定为滚动
    var SLOPE = 1.2;
    var MAX_MS = 1200;
    var EDGE = 24;       // 避开 iOS Safari 的边缘侧滑返回
    var FOLLOW = 0.35;   // 拖动时卡片跟手系数
    var ANIM_MS = 150;

    var sx = 0, sy = 0, st = 0, tracking = false, locked = false, animating = false;
    var muteUntil = 0;   // 滑动后短暂屏蔽 click，避免顺带点掉选项

    function card() { return $('#card'); }

    var SKIP = '.top, .ctl, details, .foot, #toast, input, textarea, select, [contenteditable="true"]';

    // 起手点排除：交互控件、控制区，以及自身可横向滚动的容器（长公式、代码块）
    function skip(el) {
      if (!el || !el.closest) return true;
      if (el.closest(SKIP)) return true;
      var c = card();
      for (var n = el; n && n !== c && n.nodeType === 1; n = n.parentNode) {
        if (n.scrollWidth - n.clientWidth <= 2) continue;
        var ox = window.getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    }

    function reset() {
      if (animating) return;          // 动画中不打断，否则会停在半路又被 go() 换题
      var c = card();
      if (!c) return;
      c.style.transition = 'transform .18s ease, opacity .18s ease';
      c.style.transform = '';
      c.style.opacity = '';
    }

    function reduced() {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    // dir: 1 = 下一题，-1 = 上一题
    function flip(dir) {
      if (animating || !S.list.length) return;
      var to = S.idx + dir;
      if (to < 0 || to >= S.list.length) { reset(); return; }
      var c = card();
      if (!c) return;
      muteUntil = Date.now() + 300;   // 吞掉滑动末尾那一次 click（选项点选即判分）
      if (reduced()) { go(to); return; }
      animating = true;
      var out = dir > 0 ? -72 : 72;   // 下一题向左滑出，上一题向右滑出
      c.style.transition = 'transform ' + ANIM_MS + 'ms ease, opacity ' + ANIM_MS + 'ms ease';
      void c.offsetWidth;
      c.style.transform = 'translateX(' + out + 'px)';
      c.style.opacity = '0';
      setTimeout(function () {
        go(to);
        c.style.transition = 'none';
        c.style.transform = 'translateX(' + (-out) + 'px)';
        c.style.opacity = '0';
        requestAnimationFrame(function () {
          c.style.transition = 'transform .2s ease, opacity .2s ease';
          c.style.transform = '';
          c.style.opacity = '';
          animating = false;
        });
      }, ANIM_MS);
    }

    document.addEventListener('click', function (e) {
      if (Date.now() >= muteUntil) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    document.addEventListener('touchstart', function (e) {
      if (animating || e.touches.length !== 1) return;
      var t = e.touches[0];
      if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;
      if (skip(e.target)) return;
      sx = t.clientX; sy = t.clientY; st = Date.now();
      tracking = true; locked = false;
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (!tracking) return;
      if (e.touches.length !== 1) { tracking = false; reset(); return; }
      var t = e.touches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (!locked) {
        if (Math.abs(dy) > LOCK_Y && Math.abs(dy) > Math.abs(dx)) { tracking = false; return; }
        if (Math.abs(dx) > LOCK_X) {
          locked = true;
          var c0 = card();
          if (c0) c0.style.transition = 'none';
        }
      }
      if (!locked) return;
      var c = card();
      if (!c) return;
      c.style.transform = 'translateX(' + (dx * FOLLOW) + 'px)';
      c.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx) / 480));
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      var was = locked; locked = false;
      if (!was) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st;
      if (Math.abs(dx) < MIN_X || Math.abs(dx) < Math.abs(dy) * SLOPE || dt > MAX_MS) { reset(); return; }
      flip(dx < 0 ? 1 : -1);   // 左滑 → 下一题；右滑 → 上一题
    }, { passive: true });

    document.addEventListener('touchcancel', function () {
      tracking = false; locked = false;
      reset();
    }, { passive: true });
  }

  /* ------------------------------------------------------------ 入口 */

  // 只重画当前这一屏：题号、列表都保持不变。
  // 在错题本里答对后题目会移出错题集合，若这里重组卷，卡片会当场跳到下一题，
  // 用户看不到自己刚做对的结果。列表只在换模式 / 换筛选 / 导入时重建。
  function render() {
    renderStats();
    renderFilters();
    renderCard();
    renderMastery();
    writeRoute();
  }

  function reload() {
    buildList();
    render();
  }

  function init() {
    readRoute();
    // 旧版记录迁移：csg_* / csunitN_* 等命名空间并进全站三表，幂等，旧键不删
    try {
      var mig = site.migrateLegacy();
      if (mig && !mig.skipped && (mig.ans || mig.wrong || mig.fav)) {
        setTimeout(function () { flash('已迁移旧版记录：作答 ' + mig.ans + '、错题 ' + mig.wrong + '、收藏 ' + mig.fav); }, 400);
      }
    } catch (e) { /* 迁移失败不阻塞作答 */ }
    $('#site-title').textContent = def.title || meta.title || '题库';
    $('#bank-name').textContent = def.units.length === 1
      ? (def.units[0].label + ' · ' + def.units[0].title)
      : (def.subjectName || '');
    if (def.units.length === 1 && def.units[0].desc) $('#bank-desc').textContent = def.units[0].desc;
    if (meta.home) $('#home').href = meta.home;
    else $('#home').style.display = 'none';

    $$('#modes button').forEach(function (b) {
      b.addEventListener('click', function () { S.mode = b.dataset.mode; S.idx = 0; reload(); });
    });
    $('#f-type').addEventListener('change', function (e) { S.type = e.target.value; S.idx = 0; reload(); });
    $('#f-diff').addEventListener('change', function (e) { S.diff = e.target.value; S.idx = 0; reload(); });
    var kwTimer = null;
    $('#f-kw').addEventListener('input', function (e) {
      clearTimeout(kwTimer);
      var v = e.target.value;
      kwTimer = setTimeout(function () { S.kw = v; S.idx = 0; reload(); }, 220);
    });

    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') go(S.idx - 1);
      if (e.key === 'ArrowRight') go(S.idx + 1);
      if (/^[1-9]$/.test(e.key)) {
        var q = S.list[S.idx];
        if (q && def.types[q.type].answerShape === 'choice' && q.options[Number(e.key) - 1] != null) {
          pick(q, def.types[q.type], Number(e.key) - 1);
        }
      }
    });

    initSwipe();
    initTransfer();
    initCloud();
    reload();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
