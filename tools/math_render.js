/* math_render.js — 把带 $…$ / $$…$$ 的文本渲染成内联 SVG
 *
 * 用 MathJax 的 SVG 输出（fontCache: global），每个公式只留 <use> 引用，
 * 字形路径集中在页面顶部一份隐藏的 <defs> 里。不依赖任何字体文件，
 * 所以离线单文件包拷走即可显示，缩放也不失真。
 *
 * 用法：node math_render.js <input.json> <output.json>
 *   input  : { "texts": { "<key>": "文本，含 $x^2$ 与 $$\\int_0^1$$", … } }
 *   output : { "html": { "<key>": "…" }, "cache": "<svg>…</svg>", "errors": [...] }
 */
const fs = require('fs');

const { mathjax } = require('mathjax-full/js/mathjax.js');
const { TeX } = require('mathjax-full/js/input/tex.js');
const { SVG } = require('mathjax-full/js/output/svg.js');
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const svgJax = new SVG({ fontCache: 'global' });
const doc = mathjax.document('', {
  InputJax: new TeX({ packages: AllPackages, inlineMath: [['$', '$']] }),
  OutputJax: svgJax
});

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(s) { return String(s).replace(/[&<>"]/g, c => ESC[c]); }

const errors = [];

/* MathJax 的语义标记（data-mml-node / data-c / role / focusable）只服务无障碍与二次开发，
   渲染用不到，但每个字形要多吃几十字节。题库页面动辄上百条公式，这里统一削掉。
   只删属性，不动 <g> 结构与 transform，渲染结果完全一致。 */
function slim(html) {
  return html
    .replace(/ data-mml-node="[^"]*"/g, '')
    .replace(/ data-c="[^"]*"/g, '')
    .replace(/ role="img" focusable="false"/g, '')
    .replace(/ jax="SVG"/g, '')
    .replace(/ class="MathJax MathJax_Display"/g, ' class="MathJax MathJax_Display"')
    .replace(/ class="MathJax"/g, '');
}

/* MathJax 的语义标记（data-mml-node / data-c / role / focusable）只服务无障碍与二次开发，
   渲染用不到，但每个字形要多吃几十字节。题库页面动辄上百条公式，这里统一削掉。
   只删属性，不动 <g> 结构与 transform，渲染结果完全一致。 */
function slim(html) {
  return html
    .replace(/ data-mml-node="[^"]*"/g, '')
    .replace(/ data-c="[^"]*"/g, '')
    .replace(/ role="img" focusable="false"/g, '')
    .replace(/ jax="SVG"/g, '')
    .replace(/ class="MathJax MathJax_Display"/g, ' class="MathJax MathJax_Display"')
    .replace(/ class="MathJax"/g, '');
}

function renderMath(tex, display) {
  try {
    const node = doc.convert(tex, { display: !!display, em: 16, ex: 8, containerWidth: 1200 });
    let html = adaptor.outerHTML(node);
    if (html.indexOf('merror') >= 0) {
      errors.push({ tex, display: !!display, reason: 'MathJax 报错（merror）' });
    }
    if (display) {
      html = html.replace('class="MathJax"', 'class="MathJax MathJax_Display"');
    }
    return slim(html);
  } catch (e) {
    errors.push({ tex, display: !!display, reason: e.message });
    return '<span class="math-err">' + esc(tex) + '</span>';
  }
}

/* 把一段混合文本切成「普通文字 / 行内公式 / 行间公式」 */
function renderText(src) {
  let out = '';
  let i = 0;
  const s = String(src == null ? '' : src);
  while (i < s.length) {
    if (s.startsWith('$$', i)) {
      const end = s.indexOf('$$', i + 2);
      if (end < 0) { out += esc(s.slice(i)); break; }
      out += renderMath(s.slice(i + 2, end), true);
      i = end + 2;
    } else if (s[i] === '$') {
      // 行内公式：找下一个不转义的 $
      let j = i + 1, found = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$') { found = j; break; }
        j++;
      }
      if (found < 0) { out += esc(s.slice(i)); break; }
      out += renderMath(s.slice(i + 1, found), false);
      i = found + 1;
    } else {
      // 普通文字：保留换行语义，其余转义
      let j = i;
      while (j < s.length && s[j] !== '$') j++;
      const chunk = s.slice(i, j);
      out += esc(chunk).replace(/\n/g, '<br>');
      i = j;
    }
  }
  return out;
}

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const html = {};
Object.keys(input.texts || {}).forEach(k => { html[k] = renderText(input.texts[k]); });

let cache = '';
try {
  const node = svgJax.fontCache.getCache();
  let inner = adaptor.outerHTML(node);
  // getCache() 返回的是 <defs>，单独放进 HTML 不构成 SVG 上下文，<use> 引用不到字形。
  // 必须套一层 <svg>，否则所有公式都会渲染成空白。
  cache = /^<svg[\s>]/.test(inner)
    ? inner
    : '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
      + 'style="display:none" aria-hidden="true">' + inner + '</svg>';
} catch (e) {
  errors.push({ tex: '(font cache)', reason: e.message });
}

fs.writeFileSync(process.argv[3], JSON.stringify({ html, cache, errors }), 'utf8');
if (errors.length) {
  console.error('渲染告警 ' + errors.length + ' 条：' + JSON.stringify(errors.slice(0, 3)));
}
