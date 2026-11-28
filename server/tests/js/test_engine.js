// Pure-logic tests: no DOM required (jsc, node or a browser).
(function (g) {
  'use strict';
  var M = g.LyraMarkdown;
  var P = g.LyraImgPop && g.LyraImgPop.math;
  var S = g.LyraStore;
  var A = g.LyraAvatar;
  var L = g.LyraLifecycle;
  var B = g.LyraBrand;

  function types(blocks) { return blocks.map(function (b) { return b.type; }); }
  function inl(s) { return M.parseInline(s); }
  function flat(tokens) {
    return tokens.map(function (t) {
      if (t.t === 'text') return t.v;
      if (t.t === 'br') return '\\n';
      if (t.children) return '<' + t.t + (t.c ? ':' + t.c : '') + '>' + flat(t.children) + '</' + t.t + '>';
      return '<' + t.t + (t.href ? ' ' + t.href : '') + '>' + t.v + '</' + t.t + '>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // markdown.js parse stage
  // ---------------------------------------------------------------------------

  test('markdown: block precedence and order', function () {
    var b = M.parse('# Title\n\npara one\nline two\n\n```python\nx = "|"\n```\n$$\n\\sum_i x_i\n$$\n> q\n- a\n---');
    assert.deep(types(b), ['heading', 'paragraph', 'code', 'math', 'quote', 'list', 'hr']);
    assert.eq(b[0].level, 1);
    assert.eq(flat(b[1].children), 'para one\\nline two');
    assert.eq(b[2].lang, 'python');
    assert.eq(b[2].text, 'x = "|"');
    assert.eq(b[3].tex, '\\sum_i x_i');
  });

  test('markdown: single-line display math and unterminated fence', function () {
    assert.eq(M.parse('$$ E = mc^2 $$')[0].tex, 'E = mc^2');
    var b = M.parse('```\nno close');
    assert.eq(b[0].type, 'code');
    assert.eq(b[0].text, 'no close');
    assert.eq(M.parse('$$ not closed')[0].type, 'paragraph');
  });

  test('markdown: GFM table with alignment, pipes in code and math, ragged rows', function () {
    var t = M.parse('| a | b | c |\n| :--- | :---: | ---: |\n| `x|y` | $a|b$ | \\| |\n| 1 |')[0];
    assert.eq(t.type, 'table');
    assert.deep(t.align, ['left', 'center', 'right']);
    assert.eq(t.rows.length, 2);
    assert.eq(t.rows[0][0][0].t, 'code');
    assert.eq(t.rows[0][0][0].v, 'x|y');
    assert.eq(t.rows[0][1][0].t, 'math');
    assert.eq(t.rows[0][1][0].v, 'a|b');
    assert.eq(flat(t.rows[0][2]), '|');
    assert.eq(t.rows[1].length, 3, 'short rows are padded');
  });

  test('markdown: lists, nesting, ordered start and task items', function () {
    var b = M.parse('- one\n  - nested\n    - deeper\n- [x] done\n- [ ] todo\n\n3. three\n4. four');
    assert.deep(types(b), ['list', 'list']);
    var ul = b[0];
    assert.eq(ul.items.length, 3);
    assert.ok(ul.items[0].sub && ul.items[0].sub.items[0].sub, 'two nested levels');
    assert.eq(ul.items[1].task, true);
    assert.eq(ul.items[1].checked, true);
    assert.eq(ul.items[2].checked, false);
    assert.eq(b[1].ordered, true);
    assert.eq(b[1].start, 3);
  });

  test('markdown: horizontal rules are not list items', function () {
    assert.deep(types(M.parse('- - -\n***\n___')), ['hr', 'hr', 'hr']);
  });

  test('markdown: blockquote nests and stops at depth limit', function () {
    var b = M.parse('> outer\n> > inner\n> > > deepest');
    assert.eq(b[0].type, 'quote');
    assert.eq(b[0].children[1].type, 'quote');
  });

  test('markdown: inline code shields math and colour tokens', function () {
    assert.eq(flat(inl('`==red:x== and $y$`')), '<code>==red:x== and $y$</code>');
    assert.eq(flat(inl('``a ` b``')), '<code>a ` b</code>');
  });

  test('markdown: inline math and the currency guard', function () {
    assert.eq(flat(inl('Price is $5 to $10')), 'Price is $5 to $10');
    assert.eq(flat(inl('$x_t = \\alpha + \\beta_i$')), '<math>x_t = \\alpha + \\beta_i</math>');
    assert.eq(flat(inl('costs $5 and $x$')), 'costs $5 and <math>x</math>');
    assert.eq(flat(inl('$ x$ and $x $')), '$ x$ and $x $');
    assert.eq(flat(inl('$x$5')), '$x$5');
    assert.eq(flat(inl('\\$x$')), '$x$');
    assert.eq(flat(inl('a $$ b')), 'a $$ b');
  });

  test('markdown: semantic colours use the allow-list only', function () {
    assert.eq(flat(inl('==green:PASS== ==red:FAIL==')), '<color:green>PASS</color> <color:red>FAIL</color>');
    assert.eq(flat(inl('==badtoken:noop==')), '==badtoken:noop==');
    assert.eq(flat(inl('==red:<svg onload=alert(1)>==')), '<color:red><svg onload=alert(1)></color>');
    assert.eq(flat(inl('==blue:**bold** `c`==')), '<color:blue><strong>bold</strong> <code>c</code></color>');
    assert.eq(flat(inl('==green:x = 1==')), '<color:green>x = 1</color>');
  });

  test('markdown: emphasis rules', function () {
    assert.eq(flat(inl('**b** *i* ~~d~~ __u__ _e_')),
      '<strong>b</strong> <em>i</em> <del>d</del> <strong>u</strong> <em>e</em>');
    assert.eq(flat(inl('snake_case_name')), 'snake_case_name');
    assert.eq(flat(inl('2 * 3 * 4')), '2 * 3 * 4');
    assert.eq(flat(inl('**unclosed')), '**unclosed');
    assert.eq(flat(inl('\\*literal\\*')), '*literal*');
  });

  test('markdown: links accept http(s) only', function () {
    assert.eq(flat(inl('[ok](https://a.example/x)')), '<link https://a.example/x>ok</link>');
    assert.eq(flat(inl('[x](javascript:alert(1))')), '[x](javascript:alert(1))');
    assert.eq(flat(inl('[x](data:text/html,hi)')), '[x](data:text/html,hi)');
    assert.eq(flat(inl('see https://a.example/p_(q)). end')),
      'see <link https://a.example/p_(q)>https://a.example/p_(q)</link>). end');
    assert.eq(flat(inl('xhttps://no.example')), 'xhttps://no.example');
  });

  test('markdown: raw HTML stays text', function () {
    var b = M.parse('<img src=x onerror=alert(1)>\n<script>alert(1)</script>');
    assert.eq(flat(b[0].children), '<img src=x onerror=alert(1)>\\n<script>alert(1)</script>');
  });

  test('markdown: pathological input stays fast', function () {
    var t0 = Date.now();
    M.parse(new Array(16001).join('*'));
    M.parse(new Array(8001).join('$a'));
    M.parse(new Array(8001).join('`*'));
    M.parse(new Array(4001).join('[a](') );
    M.parse(new Array(4001).join('==red:'));
    assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0) + ' ms');
  });

  // ---------------------------------------------------------------------------
  // imgpop.js geometry
  // ---------------------------------------------------------------------------

  test('imgpop: fit fills one axis', function () {
    var f = P.fit(2000, 1000, 1000, 800);
    assert.near(f.w, 1000);
    assert.near(f.h, 500);
    var g2 = P.fit(100, 400, 1000, 800);
    assert.near(g2.h, 800, 1e-9, 'small images scale up to fill');
    assert.eq(P.fit(0, 0, 10, 10).w, 0);
  });

  test('imgpop: zoom anchors the point under the cursor', function () {
    var st = { zoom: 1, panX: 0, panY: 0, baseW: 1000, baseH: 500, vpW: 1000, vpH: 800 };
    var px = 200; var py = 100;
    var before = { x: (px - st.panX) / st.zoom, y: (py - st.panY) / st.zoom };
    var next = P.zoomAt(st, 3, px, py);
    var after = { x: (px - next.panX) / next.zoom, y: (py - next.panY) / next.zoom };
    assert.near(after.x, before.x, 1e-9);
    assert.near(after.y, before.y, 1e-9);
    assert.eq(next.zoom, 3);
  });

  test('imgpop: zoom and pan clamp to 100% to 800% and to the image edges', function () {
    var st = { zoom: 1, panX: 0, panY: 0, baseW: 1000, baseH: 500, vpW: 1000, vpH: 800 };
    assert.eq(P.zoomAt(st, 20, 0, 0).zoom, 8);
    assert.eq(P.zoomAt(st, 0.1, 0, 0).zoom, 1);
    var z = P.zoomAt(st, 2, 0, 0);
    var far = P.panBy(z, 99999, 99999);
    assert.near(far.panX, (1000 * 2 - 1000) / 2);
    assert.near(far.panY, 100, 1e-9, 'height 1000 exceeds the 800 viewport by 200, so max 100');
    var tall = P.panBy(P.zoomAt(st, 4, 0, 0), 0, 99999);
    assert.near(tall.panY, (500 * 4 - 800) / 2);
    assert.near(P.zoomAt(z, 1, 300, 300).panX, 0, 1e-9, 'back at 100% the pan recentres');
  });

  test('imgpop: wheel normalization and double-click toggle', function () {
    assert.eq(P.wheelDelta({ deltaY: 3, deltaMode: 1 }), 48);
    assert.eq(P.wheelDelta({ deltaY: 1, deltaMode: 2 }), 240);
    assert.ok(P.wheelZoom(1, -100) > 1);
    assert.eq(P.wheelZoom(1, 500), 1);
    assert.eq(P.toggleTarget(1), 2.5);
    assert.eq(P.toggleTarget(3), 1);
  });

  // ---------------------------------------------------------------------------
  // store.js
  // ---------------------------------------------------------------------------

  test('store: view state sanitizing and legacy tab mapping', function () {
    var v = S.sanitizeView({ activeTab: 'usage', agentGroupMode: 'bogus', expandedAgentIds: [1, 2, 2, 'x', {}] },
                           { agentIds: [2] });
    assert.eq(v.activeTab, 'chats');
    assert.eq(v.agentGroupMode, 'machine');
    assert.deep(v.expandedAgentIds, [2]);
    assert.eq(S.sanitizeView({ activeTab: 'admin-senate' }).activeTab, 'senate', 'Stage 2 tab name maps to Senate');
    assert.eq(S.sanitizeView({ activeTab: 'admin' }).activeTab, 'senate');
    assert.eq(S.sanitizeView({ activeTab: 'senate' }).activeTab, 'senate');
    assert.eq(S.sanitizeView({ activeTab: 'agents' }, { desktop: true }).activeTab, 'chats');
    assert.eq(S.sanitizeView({ activeTab: 'agents' }, { desktop: false }).activeTab, 'agents');
    var sel = S.sanitizeView({ selectedConvId: 9, pendingAgentId: 3, mobileChatView: 'thread' },
                             { convIds: [4], agentIds: [3] });
    assert.eq(sel.selectedConvId, null);
    assert.eq(sel.pendingAgentId, 3);
    assert.eq(sel.mobileChatView, 'thread');
  });

  test('store: round trip and soft retention without a snapshot', function () {
    var s = S.create(S.memoryStorage());
    s.view.save({ activeTab: 'projects', expandedPoolIds: [1, 5], projectStatusFilter: 'archived' });
    var v = s.view.load();
    assert.eq(v.activeTab, 'projects');
    assert.deep(v.expandedPoolIds, [1, 5]);
    assert.eq(v.projectStatusFilter, 'archived');
    assert.deep(s.view.load({ poolIds: [5] }).expandedPoolIds, [5]);
  });

  test('store: drafts save, delete when empty, migrate and survive bad JSON', function () {
    var mem = S.memoryStorage();
    var s = S.create(mem, { now: function () { return 1795868193; } });
    var a = s.drafts.key({ convId: 4 });
    var p = s.drafts.key({ agentId: 7 });
    assert.eq(a, 'lyra.ui.v2.draft.conv:4');
    assert.eq(p, 'lyra.ui.v2.draft.pending:7');
    s.drafts.save(a, { text: 'line 1\nline 2', replyToId: 42, mode: 'jump' });
    assert.deep(s.drafts.load(a), { text: 'line 1\nline 2', replyToId: 42, mode: 'jump', attachments: [], updatedAt: 1795868193 });
    s.drafts.save(a, { text: '', replyToId: 42 });
    assert.eq(s.drafts.load(a).replyToId, 42, 'a reply target alone keeps the draft');
    s.drafts.save(a, { text: '' });
    assert.eq(s.drafts.load(a), null);
    s.drafts.save(p, { text: 'first message' });
    s.drafts.migrate(p, s.drafts.key({ convId: 9 }));
    assert.eq(s.drafts.load(p), null);
    mem.setItem('lyra.ui.v2.draft.conv:5', '{not json');
    assert.eq(s.drafts.load('lyra.ui.v2.draft.conv:5'), null);
  });

  test('store: theme, sidebar, notifications and mutes', function () {
    var v = S.sanitizeView({ theme: 'dark', sidebarCollapsed: true, sidebarWidth: 9999, notify: true,
                             mutedAgentIds: [3, 4, 4] }, { agentIds: [3] });
    assert.eq(v.theme, 'dark'); assert.eq(v.sidebarCollapsed, true); assert.eq(v.sidebarWidth, S.SIDEBAR.max);
    assert.eq(v.notify, true); assert.deep(v.mutedAgentIds, [3]);
    var d = S.sanitizeView({ theme: 'sepia', sidebarCollapsed: 'yes', sidebarWidth: 10, notify: 1 });
    assert.eq(d.theme, null); assert.eq(d.sidebarCollapsed, false); assert.eq(d.sidebarWidth, S.SIDEBAR.min);
    assert.eq(d.notify, false);
    assert.eq(S.sanitizeView({}).sidebarWidth, S.SIDEBAR.initial);
    assert.eq(S.sanitizeView({ taskStatusFilter: 'cancelled' }).taskStatusFilter, 'cancelled');
  });

  test('store: draft images survive, with safe metadata only', function () {
    var s = S.create(S.memoryStorage(), { now: function () { return 5; } });
    var k = s.drafts.key({ convId: 3 });
    s.drafts.save(k, { text: '', attachments: [{ id: 7, filename: 'plot.png', mime_type: 'image/png', size_bytes: 900, x: 1 },
                                              { id: 7 }, { id: -1 }, { id: '8' }, { id: 9, mime_type: 'text/html' }] });
    var d = s.drafts.load(k);
    assert.deep(d.attachments, [{ id: 7, filename: 'plot.png', mime_type: 'image/png', size_bytes: 900 },
                                { id: 9, filename: 'image', mime_type: null, size_bytes: null }]);
    s.drafts.save(k, { text: '', attachments: [] });
    assert.eq(s.drafts.load(k), null, 'empty text with no images deletes the draft');
  });

  test('store: storage errors never throw', function () {
    var broken = { getItem: function () { throw new Error('SecurityError'); },
                   setItem: function () { throw new Error('QuotaExceededError'); },
                   removeItem: function () { throw new Error('x'); }, key: function () { return null; }, length: 0 };
    var s = S.create(broken);
    assert.eq(s.safe.set('k', 1), false);
    assert.eq(s.safe.get('k', 'fb'), 'fb');
    assert.eq(s.drafts.save(s.drafts.key({ convId: 1 }), { text: 'x' }), false);
    assert.eq(s.view.load().activeTab, 'chats');
  });

  // ---------------------------------------------------------------------------
  // avatar.js
  // ---------------------------------------------------------------------------

  test('avatar: palette keeps 4.5:1 against white', function () {
    A.PALETTE.forEach(function (p) {
      assert.ok(A.contrast('#ffffff', p.bg) >= 4.5, p.name + ' ' + A.contrast('#ffffff', p.bg).toFixed(2));
    });
  });

  test('avatar: deterministic hue, initials, custom colours and icons', function () {
    var a = A.spec({ handle: 'dario', display_name: 'Dario' });
    assert.deep(A.spec({ handle: 'dario', display_name: 'Other' }).bg, a.bg);
    assert.eq(a.text, 'D');
    assert.eq(A.initials('Echo test agent', 'echo'), 'EA');
    assert.eq(A.initials('', '@claude'), 'C');
    assert.eq(A.initials('\u674e\u767d', null), '\u674e');
    var c = A.spec({ handle: 'x', avatar: { bg: '#FFD60A', fg: '#ffffff', icon: 'star' } });
    assert.eq(c.bg, '#ffd60a');
    assert.eq(c.fg, '#0f1626', 'low-contrast custom fg is replaced');
    assert.eq(c.text, '\u2605');
    var bad = A.spec({ handle: 'x', avatar: { bg: 'red;background:url(x)', icon: '<b>' } });
    assert.eq(bad.custom, false);
    assert.eq(bad.text, 'X');
  });

  test('brand: provider keys, aliases and names', function () {
    assert.eq(B.key('Anthropic'), 'anthropic');
    assert.eq(B.key('kimi'), 'moonshot');
    assert.eq(B.key('codex'), 'openai');
    assert.eq(B.key(''), 'other');
    assert.eq(B.providerName('openai'), 'OpenAI');
    assert.eq(B.providerName('google'), 'Google');
    assert.eq(B.providerName('deepseek'), 'DeepSeek');
    assert.eq(B.providerName('acme'), 'Acme');
    assert.deep(B.PROVIDERS, ['anthropic', 'openai', 'google', 'gemini', 'moonshot']);
  });

  test('avatar: Feishu image avatars use safe paths only', function () {
    assert.eq(A.spec({ handle: 'gem', avatar: { image: '/static/avatars/gem.png', icon: 'gem' } }).image, '/static/avatars/gem.png');
    assert.eq(A.spec({ handle: 'x', avatar: { image: '/static/avatars/../app.js' } }).image, null);
    assert.eq(A.spec({ handle: 'x', avatar: { image: 'https://evil.example/a.png' } }).image, null);
    assert.eq(A.spec({ handle: 'x', avatar: { image: '/static/vendor/katex/x.png' } }).image, null);
    assert.eq(A.imagePath('/static/avatars/kimi.png'), '/static/avatars/kimi.png');
  });

  test('avatar: server formats (preset string, icon and colour, emoji, short text)', function () {
    var preset = A.spec({ handle: 'g', avatar: 'gem' });
    assert.eq(preset.text, '\u25c6');
    assert.eq(preset.custom, true);
    var named = A.spec({ handle: 'g', avatar: { icon: 'moon', color: 'navy' } });
    assert.eq(named.bg, '#1e2f6b');
    assert.eq(named.fg, '#ffffff');
    assert.eq(A.spec({ handle: 'g', avatar: { color: '#0a0' } }).bg, '#00aa00', '#rgb expands');
    assert.eq(A.spec({ handle: 'g', avatar: { icon: 'ab' } }).text, 'AB');
    assert.eq(A.spec({ handle: 'g', avatar: { icon: '\ud83e\udd16' } }).text, '\ud83e\udd16');
    assert.eq(A.spec({ handle: 'g', avatar: { icon: 'toolongtext' } }).text, 'G', 'unknown long text falls back');
    assert.eq(A.spec({ handle: 'g', avatar: { color: 'url(x)' } }).custom, false);
  });

  // ---------------------------------------------------------------------------
  // lifecycle.js
  // ---------------------------------------------------------------------------

  test('lifecycle: compact receipts follow the delivery state', function () {
    var base = { id: 10, conversation_id: 1, recipient: { id: 2 }, state: 'waiting', queue_position: 2 };
    var r = L.receipt({ local: 'sending' });
    assert.eq(r.kind, 'sending'); assert.eq(r.checks, 0); assert.eq(r.label, 'Sending\u2026');
    assert.eq(L.receipt({ local: 'send_failed', local_error: 'offline' }).label, 'Not sent: offline');
    r = L.receipt(base);
    assert.eq(r.kind, 'server'); assert.eq(r.checks, 1); assert.eq(r.label, 'Server, #2 in queue');
    assert.deep(r.actions, ['cancel']);
    assert.eq(L.receipt(Object.assign({}, base, { queue_position: 1 })).label, 'Server');
    var d = Object.assign({}, base, { state: 'delivered', delivered_at: 1000 });
    r = L.receipt(d);
    assert.eq(r.kind, 'read'); assert.eq(r.checks, 2); assert.eq(r.label, 'Agent read'); assert.deep(r.actions, ['details']);
    assert.eq(L.receipt(d, { replied: true }).kind, 'replied');
    r = L.receipt(Object.assign({}, base, { state: 'unconfirmed' }));
    assert.eq(r.tone, 'warn'); assert.deep(r.actions, ['retry', 'details']);
    assert.eq(L.receipt(Object.assign({}, base, { state: 'failed', state_reason: 'timeout' })).label, 'Failed: timeout');
    r = L.receipt(Object.assign({}, base, { state: 'cancelled' }));
    assert.eq(r.label, 'Cancelled'); assert.eq(r.checks, 0);
  });

  test('lifecycle: live bubble only while the agent is on it', function () {
    var d = { id: 10, conversation_id: 1, recipient: { id: 2 }, state: 'delivered', delivered_at: 1000 };
    assert.eq(L.live(d, { now: 1010 }), null, 'no progress, no live bubble');
    var think = Object.assign({}, d, { progress: { phase: 'thinking' } });
    var info = L.live(think, { now: 1065 });
    assert.eq(info.phase, 'thinking'); assert.eq(info.label, 'Thinking'); assert.eq(info.elapsed, 65);
    assert.eq(L.clock(65), '1:05'); assert.eq(L.clock(3725), '1:02:05');
    var work = Object.assign({}, d, { progress: { phase: 'working', summary: 'Auditing', bullets: [{ text: 'a', state: 'done' }] } });
    assert.eq(L.live(work).label, 'Auditing');
    assert.eq(L.live(work, { replied: true }), null, 'the reply replaces the live bubble');
    assert.eq(L.live(Object.assign({}, work, { state: 'waiting' })), null);
    var ask = Object.assign({}, d, { progress: { phase: 'input_required', summary: 'Which branch?' } });
    assert.eq(L.live(ask).label, 'Needs your input: Which branch?');
    assert.eq(L.live(work, { agentStatus: 'stalled', now: 1000 }).stalled, true);
  });

  test('lifecycle: reply detection and progress cleaning', function () {
    var sent = { id: 10, conversation_id: 1, recipient: { id: 2 }, sender: { id: 1 } };
    assert.eq(L.replied(sent, [sent]), false);
    assert.eq(L.replied(sent, [sent, { id: 11, conversation_id: 1, sender: { id: 2 } }]), true);
    assert.eq(L.replied(sent, [sent, { id: 12, conversation_id: 1, sender: { id: 1 }, reply_to: { id: 10 } }]), true);
    assert.eq(L.replied(sent, [{ id: 9, conversation_id: 1, sender: { id: 2 } }, sent]), false);
    var c = L.cleanProgress({ phase: 'working', summary: 's', bullets: [{ text: 'x', status: 'weird' }, { text: '' }, 3] });
    assert.deep(c.bullets, [{ text: 'x', status: 'pending' }]);
    assert.eq(L.cleanProgress({ phase: 'hacking' }), null);
  });

  test('lifecycle: server progress (bullet state, stale flag)', function () {
    var p = L.cleanProgress({ phase: 'working', summary: 'Auditing', updated_at: 1000, stale: true,
                              bullets: [{ text: 'a', state: 'done' }, { text: 'b', state: 'active' }, { text: 'c', state: 'pending' }] });
    assert.deep(p.bullets.map(function (b) { return b.status; }), ['done', 'active', 'pending']);
    assert.eq(p.stale, true);
    assert.eq(L.cleanProgress({ phase: 'working', stale: 'yes' }).stale, false, 'only a real true counts');
    assert.eq(L.cleanProgress({ phase: 'input_required' }).phase, 'input_required');
    var m = { id: 10, conversation_id: 1, recipient: { id: 2 }, state: 'delivered', delivered_at: 900,
              progress: { phase: 'working', summary: 'Auditing', updated_at: 1000, stale: true } };
    var info = L.live(m, { now: 1000 + 300 });
    assert.eq(info.phase, 'working');
    assert.eq(info.stale, true);
    assert.eq(info.label, 'No update for 5 min: Auditing');
    var fresh = L.live(Object.assign({}, m, { progress: { phase: 'thinking', updated_at: 1290 } }), { now: 1300 });
    assert.ok(!fresh.stale, 'fresh progress is not stale');
    assert.eq(fresh.label, 'Thinking');
  });
})(typeof window !== 'undefined' ? window : globalThis);
