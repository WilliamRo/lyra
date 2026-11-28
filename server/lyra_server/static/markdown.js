// Lyra markdown.js: DOM-safe Markdown subset for chat bubbles (zero dependencies).
//
// Two stages, as in UI_SPEC_AND_QA section 4.7:
//   parse(text)  -> block AST (pure data, no DOM; testable in any JS engine)
//   render(text) -> DocumentFragment built only with createElement / createTextNode /
//                   setAttribute / classList. No HTML string is ever parsed.
// Math goes through the vendored KaTeX (window.katex) when it is loaded; otherwise the
// TeX source is shown as text. Semantic colour tokens (==red:text==) map to fixed CSS
// classes from an allow-list, never to user-supplied styles.
(function (root) {
  'use strict';

  var COLORS = ['red', 'orange', 'amber', 'green', 'blue', 'purple', 'gray'];
  var MAX_INPUT = 64000;      // characters; the server caps messages well below this
  var MAX_NEST = 2;           // quotes, nested lists and colour spans
  var MAX_INLINE_DEPTH = 4;   // emphasis inside emphasis
  var MAX_TEX = 4000;         // longer formulas are shown as source, not rendered
  var ESCAPABLE = '\\`*_~$=|[]()#>-+.!{}';

  // ===========================================================================
  // Stage 1: blocks
  // ===========================================================================

  var FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
  var HEADING_RE = /^ {0,3}(#{1,4})\s+(.*?)\s*#*\s*$/;
  var HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE_RE = /^ {0,3}>\s?(.*)$/;
  var ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var TASK_RE = /^\[( |x|X)\]\s+(.*)$/;
  var DELIM_RE = /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/;
  var DELIM_ONE_RE = /^\|\s*:?-{3,}:?\s*\|$/;

  function parse(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (src.length > MAX_INPUT) src = src.slice(0, MAX_INPUT);
    return parseBlocks(src.split('\n'), 0);
  }

  function indentOf(line) {
    var n = 0;
    for (var i = 0; i < line.length; i++) {
      if (line[i] === ' ') n += 1;
      else if (line[i] === '\t') n += 2;
      else break;
    }
    return n;
  }

  function isDelimRow(line) {
    var t = line.trim();
    return DELIM_RE.test(t) || DELIM_ONE_RE.test(t);
  }

  function startsTable(lines, i) {
    return lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isDelimRow(lines[i + 1]);
  }

  // Display math: "$$ x $$" on one line, or "$$" ... "$$" across lines.
  function matchDisplayMath(lines, i) {
    var t = lines[i].trim();
    if (t.slice(0, 2) !== '$$') return null;
    if (t.length > 4 && t.slice(-2) === '$$') {
      var one = t.slice(2, -2).trim();
      return one ? { tex: one, next: i + 1 } : null;
    }
    var parts = [t.slice(2)];
    for (var j = i + 1; j < lines.length; j++) {
      var tj = lines[j].trim();
      if (tj.slice(-2) === '$$') {
        parts.push(tj.slice(0, -2));
        var tex = parts.join('\n').trim();
        return tex ? { tex: tex, next: j + 1 } : null;
      }
      parts.push(lines[j]);
    }
    return null;
  }

  function startsBlock(lines, i) {
    var line = lines[i];
    return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) ||
      QUOTE_RE.test(line) || ITEM_RE.test(line) || startsTable(lines, i) ||
      matchDisplayMath(lines, i) !== null;
  }

  function parseBlocks(lines, depth) {
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      var m;

      // i. Fenced code: highest precedence, contents are literal.
      if ((m = FENCE_RE.exec(line))) {
        var fence = m[1];
        var closeRe = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
        var body = [];
        i += 1;
        while (i < lines.length && !closeRe.test(lines[i])) { body.push(lines[i]); i += 1; }
        i += 1;
        out.push({ type: 'code', lang: (m[2] || '').slice(0, 32), text: body.join('\n') });
        continue;
      }

      // ii. Display math.
      var dm = matchDisplayMath(lines, i);
      if (dm) {
        out.push({ type: 'math', display: true, tex: dm.tex });
        i = dm.next;
        continue;
      }

      // iii. GFM table: header row, delimiter row, body rows.
      if (startsTable(lines, i)) {
        var head = splitRow(line);
        var align = splitRow(lines[i + 1]).map(alignOf);
        if (head.length === align.length) {
          i += 2;
          var rows = [];
          while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
            rows.push(padRow(splitRow(lines[i]), head.length));
            i += 1;
          }
          out.push({
            type: 'table', align: align,
            head: head.map(function (c) { return parseInline(c); }),
            rows: rows.map(function (r) { return r.map(function (c) { return parseInline(c); }); }),
          });
          continue;
        }
      }

      // iv. Headings (# to ####), rendered one level down inside bubbles.
      if ((m = HEADING_RE.exec(line)) && m[2]) {
        out.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]) });
        i += 1;
        continue;
      }

      // v. Horizontal rule (checked before lists so "- - -" and "***" are rules).
      if (HR_RE.test(line)) {
        out.push({ type: 'hr' });
        i += 1;
        continue;
      }

      // vi. Blockquote: consecutive "> " lines, parsed recursively up to MAX_NEST.
      if (QUOTE_RE.test(line)) {
        var inner = [];
        while (i < lines.length && (m = QUOTE_RE.exec(lines[i]))) { inner.push(m[1]); i += 1; }
        out.push({
          type: 'quote',
          children: depth < MAX_NEST ? parseBlocks(inner, depth + 1)
            : [{ type: 'paragraph', children: parseInline(inner.join('\n')) }],
        });
        continue;
      }

      // vii. Lists.
      if (ITEM_RE.test(line)) {
        var res = parseList(lines, i, indentOf(line), 0);
        out.push(res.list);
        i = res.next;
        continue;
      }

      // viii. Paragraph: lines joined with line breaks until a blank line or a new block.
      var para = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) { para.push(lines[i]); i += 1; }
      out.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
    }
    return out;
  }

  function markerKind(marker) {
    return /\d/.test(marker) ? 'ol' : 'ul';
  }

  function makeItem(text) {
    var task = TASK_RE.exec(text);
    if (task) return { task: true, checked: task[1] !== ' ', text: task[2], sub: null };
    return { task: false, checked: false, text: text, sub: null };
  }

  // Items at `base` indent; deeper items (2+ spaces) nest up to two levels.
  function parseList(lines, start, base, level) {
    var first = ITEM_RE.exec(lines[start]);
    var kind = markerKind(first[2]);
    var list = { type: 'list', ordered: kind === 'ol', start: kind === 'ol' ? parseInt(first[2], 10) : 1,
                 items: [] };
    var i = start;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) break;
      var m = ITEM_RE.exec(line);
      var ind = indentOf(line);
      if (m && ind < base + 2) {
        if (ind < base || markerKind(m[2]) !== kind) break;
        list.items.push(makeItem(m[3]));
        i += 1;
        continue;
      }
      var last = list.items[list.items.length - 1];
      if (m && ind >= base + 2 && last) {
        // Nested list under the previous item (top level plus up to MAX_NEST levels).
        if (!last.sub && level < MAX_NEST) {
          var res = parseList(lines, i, ind, level + 1);
          last.sub = res.list;
          i = res.next;
          continue;
        }
        last.text += '\n' + m[2] + ' ' + m[3];
        i += 1;
        continue;
      }
      // Continuation line: indented text belongs to the previous item.
      if (last && ind >= base + 1 && !startsBlock(lines, i)) {
        last.text += '\n' + line.trim();
        i += 1;
        continue;
      }
      break;
    }
    list.items.forEach(function (it) { it.children = parseInline(it.text); delete it.text; });
    return { list: list, next: i };
  }

  // Split a table row on unescaped pipes, keeping pipes inside `code` and $math$.
  function splitRow(line) {
    var s = line.trim();
    if (s[0] === '|') s = s.slice(1);
    if (s.length && s[s.length - 1] === '|' && s[s.length - 2] !== '\\') s = s.slice(0, -1);
    var cells = [];
    var cur = '';
    var i = 0;
    while (i < s.length) {
      var ch = s[i];
      if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
      if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i += 2; continue; }
      if (ch === '`') {
        var run = countRun(s, i, '`');
        var close = findBacktickClose(s, i + run, run);
        if (close !== -1) { cur += s.slice(i, close + run); i = close + run; continue; }
        cur += s.slice(i, i + run);
        i += run;
        continue;
      }
      if (ch === '$' && s[i + 1] !== '$') {
        var end = findMathClose(s, i);
        if (end !== -1) { cur += s.slice(i, end + 1); i = end + 1; continue; }
      }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; i += 1; continue; }
      cur += ch;
      i += 1;
    }
    cells.push(cur.trim());
    return cells;
  }

  function padRow(row, n) {
    var out = row.slice(0, n);
    while (out.length < n) out.push('');
    return out;
  }

  function alignOf(cell) {
    var c = cell.trim();
    var left = c[0] === ':';
    var right = c[c.length - 1] === ':';
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  // ===========================================================================
  // Stage 2: inline tokens (single line per token; "\n" becomes a line break)
  // ===========================================================================

  function countRun(s, i, ch) {
    var n = 0;
    while (s[i + n] === ch) n += 1;
    return n;
  }

  function lineEnd(s, i) {
    var e = s.indexOf('\n', i);
    return e === -1 ? s.length : e;
  }

  function findBacktickClose(s, from, run) {
    var end = lineEnd(s, from);
    var j = from;
    while (j < end) {
      var k = s.indexOf('`', j);
      if (k === -1 || k >= end) return -1;
      var n = countRun(s, k, '`');
      if (n === run) return k;
      j = k + n;
    }
    return -1;
  }

  // Inline math guard (currency-safe): opener not followed by whitespace; the first
  // later "$" on the line must not follow whitespace or a backslash and must not be
  // followed by a digit. "$5 to $10" therefore stays text.
  function findMathClose(s, i) {
    var next = s[i + 1];
    if (next === undefined || /\s/.test(next) || next === '$') return -1;
    var end = lineEnd(s, i + 1);
    var j = s.indexOf('$', i + 1);
    while (j !== -1 && j < end && s[j - 1] === '\\') j = s.indexOf('$', j + 1);
    if (j === -1 || j >= end) return -1;
    if (/\s/.test(s[j - 1]) || /[0-9]/.test(s[j + 1] || '')) return -1;
    if (j === i + 1) return -1;
    return j;
  }

  var COLOR_RE = /^==([a-z]+):((?:[^=\n]|=(?!=))+)==/;
  var LINK_RE = /^\[([^\]\n]{1,500})\]\((https?:\/\/[^\s()<>"'`]+(?:\([^\s()<>"'`]*\)[^\s()<>"'`]*)*)\)/;
  var URL_RE = /^https?:\/\/[^\s<>"'`]+/;

  function isAlnum(ch) {
    return !!ch && /[A-Za-z0-9]/.test(ch);
  }

  function trimUrl(url) {
    var u = url;
    while (/[.,;:!?'"*_~]$/.test(u)) u = u.slice(0, -1);
    // Drop an unbalanced trailing ")" (common when a URL sits inside parentheses).
    while (u[u.length - 1] === ')' && (u.split('(').length - 1) < (u.split(')').length - 1)) u = u.slice(0, -1);
    return u;
  }

  function parseInline(text, depth) {
    return inline(String(text == null ? '' : text), depth || 0, 0);
  }

  // colorDepth counts nested colour spans; depth counts emphasis nesting.
  function inline(s, colorDepth, depth) {
    var out = [];
    var buf = '';
    var noClose = {};           // delimiter -> true once no closer exists later on this line
    var lineStart = 0;
    function flush() { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } }
    function push(tok) { flush(); out.push(tok); }

    var i = 0;
    while (i < s.length) {
      var ch = s[i];

      if (ch === '\n') { push({ t: 'br' }); i += 1; noClose = {}; lineStart = i; continue; }

      if (ch === '\\' && i + 1 < s.length && ESCAPABLE.indexOf(s[i + 1]) !== -1) {
        buf += s[i + 1];
        i += 2;
        continue;
      }

      // i. Inline code: literal, so math and colour tokens inside it are not evaluated.
      if (ch === '`') {
        var run = countRun(s, i, '`');
        var close = noClose['`' + run] ? -1 : findBacktickClose(s, i + run, run);
        if (close === -1) { noClose['`' + run] = true; buf += s.slice(i, i + run); i += run; continue; }
        var code = s.slice(i + run, close);
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) {
          code = code.slice(1, -1);
        }
        push({ t: 'code', v: code });
        i = close + run;
        continue;
      }

      // ii. Inline math.
      if (ch === '$') {
        if (s[i + 1] === '$') { buf += '$$'; i += 2; continue; }
        var mEnd = findMathClose(s, i);
        if (mEnd !== -1) { push({ t: 'math', v: s.slice(i + 1, mEnd) }); i = mEnd + 1; continue; }
        buf += '$';
        i += 1;
        continue;
      }

      // iii. Semantic colour token from the allow-list; anything else stays literal.
      if (ch === '=' && s[i + 1] === '=') {
        var cm = COLOR_RE.exec(s.slice(i, lineEnd(s, i)));
        if (cm) {
          if (COLORS.indexOf(cm[1]) !== -1) {
            push({
              t: 'color', c: cm[1],
              children: colorDepth < MAX_NEST ? inline(cm[2], colorDepth + 1, depth) : [{ t: 'text', v: cm[2] }],
            });
          } else {
            buf += cm[0];
          }
          i += cm[0].length;
          continue;
        }
      }

      // iv. Bold, strikethrough, italic.
      if ((ch === '*' || ch === '_' || ch === '~') && depth < MAX_INLINE_DEPTH) {
        var em = matchEmphasis(s, i, noClose);
        if (em) {
          push({ t: em.tag, children: inline(s.slice(i + em.len, em.close), colorDepth, depth + 1) });
          i = em.close + em.len;
          continue;
        }
      }

      // v. Links: [label](https://...) and bare http(s) URLs only.
      if (ch === '[') {
        var lm = LINK_RE.exec(s.slice(i, lineEnd(s, i)));
        if (lm) { push({ t: 'link', href: lm[2], v: lm[1] }); i += lm[0].length; continue; }
      }
      if ((ch === 'h' || ch === 'H') && !isAlnum(s[i - 1]) && i >= lineStart) {
        var um = URL_RE.exec(s.slice(i, lineEnd(s, i)));
        if (um && /^https?:\/\//i.test(um[0])) {
          var url = trimUrl(um[0]);
          if (url.length > 'https://'.length - 1) {
            push({ t: 'link', href: url, v: url });
            i += url.length;
            continue;
          }
        }
      }

      buf += ch;
      i += 1;
    }
    flush();
    return out;
  }

  function matchEmphasis(s, i, noClose) {
    var ch = s[i];
    var dbl = s[i + 1] === ch;
    var delim = dbl ? ch + ch : ch;
    if (ch === '~' && !dbl) return null;
    var len = delim.length;
    var after = s[i + len];
    if (after === undefined || /\s/.test(after)) return null;
    if (ch === '_' && isAlnum(s[i - 1])) return null;     // snake_case stays text
    if (noClose[delim]) return null;
    var end = lineEnd(s, i);
    var j = i + len;
    while (j < end) {
      var k = s.indexOf(delim, j + (j === i + len ? 1 : 0));
      if (k === -1 || k >= end) break;
      var before = s[k - 1];
      var tail = s[k + len];
      var valid = !/\s/.test(before) && before !== '\\';
      if (valid && !dbl && tail === ch) { j = k + 2; continue; }     // part of ** or __
      if (valid && ch === '_' && isAlnum(tail)) { j = k + 1; continue; }
      if (valid) return { tag: ch === '~' ? 'del' : dbl ? 'strong' : 'em', len: len, close: k };
      j = k + 1;
    }
    noClose[delim] = true;
    return null;
  }

  // ===========================================================================
  // Stage 3: DOM construction (no HTML parsing anywhere)
  // ===========================================================================

  function el(doc, tag, cls) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function safeLang(lang) {
    return String(lang || '').toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 24);
  }

  function renderKatex(tex, target, displayMode, katex) {
    var k = katex || (typeof root.katex !== 'undefined' ? root.katex : null);
    if (k && typeof k.render === 'function' && tex.length <= MAX_TEX) {
      try {
        k.render(tex, target, {
          displayMode: !!displayMode, throwOnError: false, strict: false, trust: false,
          maxSize: 40, maxExpand: 500,
        });
        return true;
      } catch (_e) {
        while (target.firstChild) target.removeChild(target.firstChild);
      }
    }
    target.textContent = displayMode ? '$$' + tex + '$$' : '$' + tex + '$';
    target.classList.add('md-math-fallback');
    return false;
  }

  function copyText(btn, status, text, doc) {
    var win = doc.defaultView || root;
    var done = function (label) {
      btn.textContent = label;
      status.textContent = label === 'Copied' ? 'Code copied to clipboard' : 'Copy failed';
      win.setTimeout(function () { btn.textContent = 'Copy'; status.textContent = ''; }, 1600);
    };
    try {
      if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
        win.navigator.clipboard.writeText(text).then(function () { done('Copied'); },
          function () { done('Copy failed'); });
        return;
      }
    } catch (_e) { /* fall through */ }
    done('Copy failed');
  }

  function renderInlineInto(tokens, parent, ctx) {
    var doc = ctx.doc;
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      var n;
      switch (tok.t) {
        case 'text': parent.appendChild(doc.createTextNode(tok.v)); break;
        case 'br': parent.appendChild(doc.createElement('br')); break;
        case 'code':
          n = el(doc, 'code', 'md-code');
          n.textContent = tok.v;
          parent.appendChild(n);
          break;
        case 'math':
          n = el(doc, 'span', 'md-math-inline');
          renderKatex(tok.v, n, false, ctx.katex);
          parent.appendChild(n);
          break;
        case 'color':
          n = el(doc, 'span', 'md-color md-color-' + tok.c);
          renderInlineInto(tok.children, n, ctx);
          parent.appendChild(n);
          break;
        case 'strong': case 'em': case 'del':
          n = doc.createElement(tok.t);
          renderInlineInto(tok.children, n, ctx);
          parent.appendChild(n);
          break;
        case 'link':
          n = el(doc, 'a', 'md-link');
          n.setAttribute('href', tok.href);
          n.setAttribute('target', '_blank');
          n.setAttribute('rel', 'noopener noreferrer');
          n.textContent = tok.v;
          parent.appendChild(n);
          break;
        default: break;
      }
    }
  }

  function renderList(block, ctx) {
    var doc = ctx.doc;
    var list = el(doc, block.ordered ? 'ol' : 'ul', 'md-list');
    if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start));
    block.items.forEach(function (it) {
      var li = doc.createElement('li');
      if (it.task) {
        li.className = 'md-task' + (it.checked ? ' is-done' : '');
        var box = el(doc, 'span', 'md-task-box');
        box.setAttribute('role', 'img');
        box.setAttribute('aria-label', it.checked ? 'Done' : 'Not done');
        li.appendChild(box);
      }
      var body = el(doc, 'span', 'md-li-body');
      renderInlineInto(it.children, body, ctx);
      li.appendChild(body);
      if (it.sub) li.appendChild(renderList(it.sub, ctx));
      list.appendChild(li);
    });
    return list;
  }

  function renderBlocksInto(blocks, parent, ctx) {
    var doc = ctx.doc;
    blocks.forEach(function (b) {
      var n;
      switch (b.type) {
        case 'paragraph':
          n = el(doc, 'p', 'md-p');
          renderInlineInto(b.children, n, ctx);
          break;
        case 'heading':
          n = el(doc, 'h' + (b.level + 2), 'md-h md-h' + b.level);
          renderInlineInto(b.children, n, ctx);
          break;
        case 'hr':
          n = el(doc, 'hr', 'md-hr');
          break;
        case 'quote':
          n = el(doc, 'blockquote', 'md-quote');
          renderBlocksInto(b.children, n, ctx);
          break;
        case 'list':
          n = renderList(b, ctx);
          break;
        case 'math':
          n = el(doc, 'div', 'md-math-block');
          renderKatex(b.tex, n, true, ctx.katex);
          break;
        case 'code': {
          n = el(doc, 'div', 'md-code-wrap');
          var head = el(doc, 'div', 'md-code-head');
          var lang = safeLang(b.lang);
          var tag = el(doc, 'span', 'md-code-lang');
          tag.textContent = lang || 'text';
          var btn = el(doc, 'button', 'md-code-copy');
          btn.setAttribute('type', 'button');
          btn.setAttribute('aria-label', 'Copy code' + (lang ? ' (' + lang + ')' : ''));
          btn.textContent = 'Copy';
          var text = b.text;
          var status = el(doc, 'span', 'md-sr');
          status.setAttribute('aria-live', 'polite');
          btn.addEventListener('click', function () { copyText(btn, status, text, doc); });
          head.appendChild(tag);
          head.appendChild(btn);
          head.appendChild(status);
          var pre = el(doc, 'pre', 'md-pre');
          var code = doc.createElement('code');
          if (lang) code.className = 'language-' + lang;
          code.textContent = text;
          pre.appendChild(code);
          n.appendChild(head);
          n.appendChild(pre);
          break;
        }
        case 'table': {
          n = el(doc, 'div', 'md-table-wrap');
          n.setAttribute('role', 'region');
          n.setAttribute('aria-label', 'Table');
          n.setAttribute('tabindex', '0');
          var table = el(doc, 'table', 'md-table');
          var thead = doc.createElement('thead');
          var hr = doc.createElement('tr');
          b.head.forEach(function (cell, ci) {
            var th = doc.createElement('th');
            th.setAttribute('scope', 'col');
            if (b.align[ci]) th.className = 'ta-' + b.align[ci][0];
            renderInlineInto(cell, th, ctx);
            hr.appendChild(th);
          });
          thead.appendChild(hr);
          table.appendChild(thead);
          var tbody = doc.createElement('tbody');
          b.rows.forEach(function (row) {
            var tr = doc.createElement('tr');
            row.forEach(function (cell, ci) {
              var td = doc.createElement('td');
              if (b.align[ci]) td.className = 'ta-' + b.align[ci][0];
              renderInlineInto(cell, td, ctx);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          n.appendChild(table);
          break;
        }
        default: return;
      }
      parent.appendChild(n);
    });
  }

  function context(opts) {
    var o = opts || {};
    var doc = o.document || root.document;
    if (!doc) throw new Error('LyraMarkdown.render needs a document');
    return { doc: doc, katex: o.katex || null };
  }

  function render(text, opts) {
    var ctx = context(opts);
    var frag = ctx.doc.createDocumentFragment();
    renderBlocksInto(parse(text), frag, ctx);
    return frag;
  }

  function renderInline(text, opts) {
    var ctx = context(opts);
    var frag = ctx.doc.createDocumentFragment();
    renderInlineInto(parseInline(text), frag, ctx);
    return frag;
  }

  function renderInto(target, text, opts) {
    while (target.firstChild) target.removeChild(target.firstChild);
    target.appendChild(render(text, Object.assign({ document: target.ownerDocument }, opts || {})));
    return target;
  }

  root.LyraMarkdown = {
    version: '2.0.0',
    COLORS: COLORS.slice(),
    parse: parse,
    parseInline: parseInline,
    render: render,
    renderInline: renderInline,
    renderInto: renderInto,
    renderKatex: renderKatex,
  };
})(typeof window !== 'undefined' ? window : globalThis);
