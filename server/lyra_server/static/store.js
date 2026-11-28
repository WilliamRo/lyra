// Lyra store.js: fault-tolerant localStorage for board view state and composer drafts.
// UI_SPEC_AND_QA section 3. Zero dependencies; storage can be injected for tests.
//
//   var s = LyraStore.create();                 // window.localStorage, or memory if blocked
//   s.view.load({ desktop, convIds, agentIds }) // sanitized view state
//   s.view.save(state)
//   s.drafts.key({ convId }) / key({ agentId }) // "lyra.ui.v2.draft.conv:4" / ".pending:7"
//   s.drafts.save(key, { text, replyToId, mode }) // deletes the entry when it is empty
//   s.drafts.load(key) / clear(key) / migrate(pendingKey, convKey)
(function (root) {
  'use strict';

  var VIEW_KEY = 'lyra.ui.v2.state';
  var DRAFT_PREFIX = 'lyra.ui.v2.draft.';
  var TABS = ['chats', 'projects', 'admin-senate', 'agents'];
  var LEGACY_TABS = { board: 'chats', usage: 'chats', admin: 'admin-senate', senate: 'admin-senate' };
  var GROUPS = ['machine', 'provider'];
  var PROJECT_FILTERS = ['all', 'active', 'paused', 'archived'];
  var MAX_DRAFT = 20000;
  var MAX_IDS = 200;

  function memoryStorage() {
    var data = new Map();
    return {
      getItem: function (k) { return data.has(k) ? data.get(k) : null; },
      setItem: function (k, v) { data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(k); },
      key: function (i) { return Array.from(data.keys())[i] || null; },
      get length() { return data.size; },
    };
  }

  function defaultStorage() {
    try {
      var s = root.localStorage;           // Safari private mode can throw on access
      var probe = '__lyra_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_e) {
      return memoryStorage();
    }
  }

  function safeStore(storage) {
    return {
      get: function (k, fallback) {
        try {
          var raw = storage.getItem(k);
          return raw == null ? fallback : JSON.parse(raw);
        } catch (_e) { return fallback; }
      },
      set: function (k, v) {
        try { storage.setItem(k, JSON.stringify(v)); return true; }
        catch (_e) { return false; }      // QuotaExceededError, SecurityError
      },
      remove: function (k) {
        try { storage.removeItem(k); return true; } catch (_e) { return false; }
      },
      keys: function (prefix) {
        var out = [];
        try {
          for (var i = 0; i < storage.length; i++) {
            var k = storage.key(i);
            if (k && (!prefix || k.indexOf(prefix) === 0)) out.push(k);
          }
        } catch (_e) { /* ignore */ }
        return out;
      },
    };
  }

  function idList(v, keep) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length && out.length < MAX_IDS; i++) {
      var id = v[i];
      if (typeof id !== 'number' && typeof id !== 'string') continue;
      if (keep && !keep(id)) continue;
      if (out.indexOf(id) === -1) out.push(id);
    }
    return out;
  }

  function has(list) {
    if (!list) return null;
    var set = new Set(list.map(String));
    return function (id) { return set.has(String(id)); };
  }

  function defaults() {
    return {
      activeTab: 'chats', selectedConvId: null, pendingAgentId: null, agentGroupMode: 'machine',
      expandedAgentIds: [], expandedMachineIds: [], expandedProviderIds: [], expandedPoolIds: [],
      activeProjectId: null, projectStatusFilter: 'all', mobileChatView: 'list',
    };
  }

  // Restore rules from spec section 3.1. ctx lists what the current snapshot knows about;
  // unknown expanded IDs are kept only when no snapshot list is supplied (soft retention).
  function sanitizeView(raw, ctx) {
    var c = ctx || {};
    var r = raw && typeof raw === 'object' ? raw : {};
    var out = defaults();
    var tab = LEGACY_TABS[r.activeTab] || r.activeTab;
    if (TABS.indexOf(tab) !== -1) out.activeTab = tab;
    if (out.activeTab === 'agents' && c.desktop) out.activeTab = 'chats';
    if (GROUPS.indexOf(r.agentGroupMode) !== -1) out.agentGroupMode = r.agentGroupMode;
    out.expandedAgentIds = idList(r.expandedAgentIds, has(c.agentIds));
    out.expandedMachineIds = idList(r.expandedMachineIds, has(c.machineIds));
    out.expandedProviderIds = idList(r.expandedProviderIds, has(c.providerIds));
    out.expandedPoolIds = idList(r.expandedPoolIds, has(c.poolIds));
    var convOk = has(c.convIds);
    if (r.selectedConvId != null && (!convOk || convOk(r.selectedConvId))) out.selectedConvId = r.selectedConvId;
    var agentOk = has(c.agentIds);
    if (out.selectedConvId == null && r.pendingAgentId != null && (!agentOk || agentOk(r.pendingAgentId))) {
      out.pendingAgentId = r.pendingAgentId;
    }
    var projOk = has(c.projectIds);
    if (r.activeProjectId != null && (!projOk || projOk(r.activeProjectId))) out.activeProjectId = r.activeProjectId;
    if (PROJECT_FILTERS.indexOf(r.projectStatusFilter) !== -1) out.projectStatusFilter = r.projectStatusFilter;
    if (r.mobileChatView === 'thread' && (out.selectedConvId != null || out.pendingAgentId != null)) {
      out.mobileChatView = 'thread';
    }
    return out;
  }

  function sanitizeDraft(d) {
    if (!d || typeof d !== 'object' || typeof d.text !== 'string') return null;
    return {
      text: d.text.slice(0, MAX_DRAFT),
      replyToId: Number.isInteger(d.replyToId) ? d.replyToId : null,
      mode: d.mode === 'jump' ? 'jump' : 'queue',
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
    };
  }

  function create(storage, options) {
    var o = options || {};
    var s = safeStore(storage || defaultStorage());
    var ns = o.namespace ? ':' + o.namespace : '';
    var viewKey = VIEW_KEY + ns;
    var now = o.now || function () { return Math.floor(Date.now() / 1000); };

    var view = {
      key: viewKey,
      load: function (ctx) { return sanitizeView(s.get(viewKey, null), ctx); },
      save: function (state) { return s.set(viewKey, sanitizeView(state, null)); },
      patch: function (changes, ctx) {
        var next = sanitizeView(Object.assign(sanitizeView(s.get(viewKey, null), ctx), changes || {}), null);
        s.set(viewKey, next);
        return next;
      },
    };

    var drafts = {
      key: function (ref) {
        var r = ref || {};
        if (r.convId != null) return DRAFT_PREFIX + 'conv:' + r.convId + ns;
        if (r.agentId != null) return DRAFT_PREFIX + 'pending:' + r.agentId + ns;
        return null;
      },
      load: function (key) {
        if (!key) return null;
        return sanitizeDraft(s.get(key, null));
      },
      save: function (key, draft) {
        if (!key) return false;
        var d = sanitizeDraft(Object.assign({ text: '' }, draft || {}));
        if (!d || (d.text === '' && d.replyToId == null)) { s.remove(key); return true; }
        d.updatedAt = now();
        return s.set(key, d);
      },
      clear: function (key) { return key ? s.remove(key) : false; },
      // After the first message to an agent creates a conversation, both keys are cleared.
      migrate: function (pendingKey, convKey) {
        s.remove(pendingKey);
        s.remove(convKey);
      },
      list: function () { return s.keys(DRAFT_PREFIX); },
    };

    return { safe: s, view: view, drafts: drafts };
  }

  root.LyraStore = {
    version: '2.0.0',
    VIEW_KEY: VIEW_KEY,
    DRAFT_PREFIX: DRAFT_PREFIX,
    create: create,
    memoryStorage: memoryStorage,
    sanitizeView: sanitizeView,
    sanitizeDraft: sanitizeDraft,
  };
})(typeof window !== 'undefined' ? window : globalThis);
