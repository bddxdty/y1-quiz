/* qb-index.js — 入口页（题库集首页 / 大一题库首页共用）
 * 只读 window.QB_INDEX，进度直接从状态层读，不依赖各练习页写入的汇总值（规范 6.6）。
 */
(function () {
  'use strict';

  var data = window.QB_INDEX;
  if (!data) return;
  var $ = function (s) { return document.querySelector(s); };

  function readTable(name) {
    try {
      var raw = localStorage.getItem('qb.site.' + name + '.v1');
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    var ans = readTable('ans'), wrong = readTable('wrong'), fav = readTable('fav');
    var host = $('#groups');
    host.innerHTML = '';

    var totalAll = 0, seen = {}, doneAll = 0, wrongAll = 0, correctAll = 0;

    data.groups.forEach(function (g) {
      var total = 0, done = 0, correct = 0, bad = 0, f = 0;
      g.gids.forEach(function (gid) {
        if (seen[gid]) return;          // 跨题组副本只算一次（规范 5.7 口径去重）
        seen[gid] = 1;
        total++;
        var r = ans[gid];
        if (r) { done++; if (r.ok === true) correct++; }
        if (wrong[gid]) bad++;
        if (fav[gid]) f++;
      });
      totalAll += total; doneAll += done; wrongAll += bad; correctAll += correct;

      var card = el('a', 'card');
      card.href = g.href;
      var head = el('div', 'card-head');
      head.appendChild(el('span', 'card-kind k-' + (g.kind || 'unit'), g.kindLabel || '题库'));
      head.appendChild(el('span', 'card-title', g.label));
      card.appendChild(head);
      if (g.title) card.appendChild(el('div', 'card-sub', g.title));
      if (g.desc) card.appendChild(el('p', 'card-desc', g.desc));

      var row = el('div', 'card-nums');
      row.appendChild(el('span', null, total + ' 题'));
      row.appendChild(el('span', null, done ? Math.round(100 * done / total) + '% 已答' : '未开始'));
      if (bad) row.appendChild(el('span', 'n-bad', bad + ' 错题'));
      if (f) row.appendChild(el('span', 'n-fav', f + ' 收藏'));
      card.appendChild(row);

      var bar = el('div', 'card-bar');
      var fill = el('i');
      fill.style.width = (total ? Math.round(100 * done / total) : 0) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);

      host.appendChild(card);
    });

    var sum = $('#sum');
    if (sum) {
      sum.innerHTML = '';
      [['题量', totalAll], ['已答', doneAll],
       ['正确率', doneAll ? Math.round(100 * correctAll / doneAll) + '%' : '—'],
       ['错题', wrongAll]].forEach(function (it) {
        var c = el('div', 'stat');
        c.appendChild(el('div', 'stat-k', it[0]));
        c.appendChild(el('div', 'stat-v', String(it[1])));
        sum.appendChild(c);
      });
    }
  }

  function init() {
    $('#site-title').textContent = data.title || '题库';
    if (data.subtitle) $('#site-sub').textContent = data.subtitle;
    var back = $('#back');
    if (data.back) { back.href = data.back.href; back.textContent = data.back.label; }
    else back.style.display = 'none';
    render();
    window.addEventListener('storage', render);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) render(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
