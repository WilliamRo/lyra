# Lyra v2 UI Design: Visual System and Responsive Desktop + Mobile

Status: design for review, 2026-11-28, branch `feat/lyra-v2-ui`. Baseline: `UI_SPEC_AND_QA.md` (owner research spec, referenced below as "spec"). This document adds the visual system, layouts, component designs and the interaction details the spec leaves open, and it records which parts are already implemented as standalone modules on this branch (section 9).

Constraints kept on this branch:

- Server Python (`server/lyra_server/*.py`) is untouched. Server prerequisites are listed in section 10 for the backend work.
- Zero build step, zero runtime dependencies beyond the vendored KaTeX in `static/vendor/katex/`.
- No HTML string is ever parsed: every node is built with `createElement`, `createTextNode`, `setAttribute` and `classList`.

## 1. Inputs

- **Spec:** the v2 contract for layout, state, chat features, agent grouping, Admin & Senate, Projects and QA-01 to QA-28.
- **Design guidance:** the workspace `frontend-design` skill (two-pass plan and self-critique, avoid templated defaults) and Vercel's `web-design-guidelines` checklist (accessibility, focus, forms, motion, typography, content handling).
- **Survey of agent-orchestration UIs** (2026-11-28; sources in section 13): Vibe Kanban, Paperclip, Mission Control (builderz-labs), Linear (agent sessions and the March 2026 UI refresh) and the OpenAI Codex app (now documented as part of the ChatGPT desktop app).
- **Rendering checks:** headless Chrome screenshots of the implemented modules at 1280 px, in dark mode, and at a true 390 x 844 viewport.

## 2. Design Direction

### 2.1 Subject, audience, job

- **Subject:** a small human-steered team of AI agents from several providers, run by one owner, with Roman civic roles (Owner, Consul, Senate). The owner's clients are university teachers and researchers, so the content often contains math, tables and code.
- **Audience:** one technical owner, at a desk for long sessions and on a phone between meetings.
- **Primary job:** see at a glance who is online, busy or stuck; talk to an agent and watch the request travel to a reply; govern who is admitted and who leads.

### 2.2 Principles

- **Status is the only loud color.** One restrained accent (Vega blue) for selection and primary actions; green, amber and red appear only when they mean ok, attention or failure. Consul gold is the single identity color and is reserved for the Consul.
- **Summary first, details on request.** Every agent, host, pool and long task shows one dense summary line; the rest sits behind a disclosure (spec 6.3).
- **The conversation never moves under the reader.** Fixed header, bottom-anchored composer, independent scroll areas, no auto-scroll while reading history (spec 2.4).
- **Research-grade content.** Tables, math and code render as first-class content, not as escaped text.
- **One memorable thing.** The academic serif for titles (section 3.2) is the signature; everything else stays quiet.

### 2.3 Plan review against generic defaults

Following the frontend-design two-pass process, the first plan was reviewed for templated choices and revised:

| First draft | Why it read as a default | Revision |
| --- | --- | --- |
| Identical rounded cards for every agent, host and pool, each with the same soft shadow | The SaaS-card kit | Rows with hairline dividers inside a group; cards only for groups (host, pool, provider); shadows only on floating layers |
| Uppercase tracked group labels ("ONLINE (3)") as in v1 | Template eyebrow chrome | Sentence-case group titles in the muted color with a tabular count |
| Neutral system sans for everything | Default family on any project | System UI for text (legible, offline, native on phones) plus the vendored KaTeX_Main serif for titles, already shipped for math |
| Status as colored text in many places | Colour competing with colour | Status lives in one pill and one avatar dot; text stays ink or muted |
| Labelled five-step rail under each sent message | Truncated labels in narrow bubbles ("Queu...") seen in the first screenshot | Five-segment meter plus one status line; step names kept for screen readers |

## 3. Visual System

### 3.1 Color tokens

Light theme by default with an automatic dark theme (`prefers-color-scheme`) and an optional manual override (`:root[data-theme="dark"|"light"]`, stored in view state).

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` Paper / Night | `#f3f5f9` | `#0e1524` | App background |
| `--card` | `#ffffff` | `#151e31` | Panes, bubbles from agents, dialogs |
| `--text` Ink | `#18233a` | `#e6eaf2` | Body text |
| `--muted` | `#5b6578` | `#98a2b6` | Meta text (5.9:1 on white) |
| `--line` / `--line-strong` | `#dfe3ea` / `#c9d0db` | `#26314a` / `#34405c` | Dividers, borders |
| `--accent` Vega | `#2d5bd2` | `#8aa8ff` | Selection, primary buttons, links, focus ring |
| `--ok` | `#1f7a45` | `#5ccb92` | Online, delivered, done |
| `--warn` | `#8a5300` | `#e8b04e` | Busy, queued long, unconfirmed, quota 10 to 29% |
| `--bad` | `#c2352b` | `#f07b70` | Failed, revoked, quota below 10% |
| `--consul-gold` / `--consul-ink` / `--consul-wash` | `#c98a12` / `#8f5e06` / gold at 12% | `#eab308` / `#f2c94c` / gold at 16% | Consul border, badge text, badge fill |
| `--bubble-me` / `--bubble-them` | `#e8eefc` / `#ffffff` | `#1e2b4a` / `#172238` | Owner and agent bubbles |
| `--code` | `#eef1f5` | `#1b2539` | Code, table header, image stage |

Rules: gold `#c98a12` is used for borders and rings only (2.9:1 on white); gold text uses `--consul-ink` (5.0:1). Every text and background pair above meets 4.5:1; semantic highlight tokens in Markdown use their own pairs (section 6.6). `<meta name="theme-color">` follows `--bg`; `color-scheme` is set on `:root`.

### 3.2 Typography

- **Text:** `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` at 15 px, line height 1.45. Native on every phone, offline, and legible in dense lists.
- **Titles:** `KaTeX_Main` (the Computer Modern face already vendored for math), falling back to `"Iowan Old Style", Georgia, serif`. Used only for the wordmark, pane titles, the empty-state heading and the Consul's name on the governance card. It ties the board to the researchers' own documents at zero extra download.
- **Code and identifiers:** `ui-monospace, "SF Mono", Menlo, Consolas, monospace` for code blocks, inline code and `/lyra-link join` hints only; not for small labels.
- **Scale (px):** 12 meta, 13 secondary, 14 list rows, 15 body, 17 thread title, 20 pane title (serif), 26 wordmark (serif). Weights 400, 600 and 650 for emphasis; no all-caps labels.
- **Numbers:** `font-variant-numeric: tabular-nums` for counts, times, quotas, queue positions and table columns. Loading text ends with an ellipsis character ("Sending…").
- **Copy:** sentence case for headings and buttons (frontend-design; this deliberately differs from the Vercel checklist's Title Case), active verbs ("Send", "Retry delivery", "Appoint Consul"), errors that say what to do next.

### 3.3 Space, shape, elevation

- **Spacing:** 4 px base: 4, 8, 12, 16, 24, 32.
- **Radius by role:** 6 px controls and inline chips, 10 px bubbles and group cards, 14 px dialogs (12 px on mobile), 999 px pills and avatars.
- **Elevation:** panes and lists are flat with hairline borders. Shadows exist only on floating layers: dialogs, the quick switcher, the "New messages" pill and toasts.
- **Density:** list rows 44 px minimum on touch, 36 px on fine pointers; agent summary rows 52 px.

### 3.4 Motion

- 120 ms ease-out for state changes (disclosure open, pill swap, badge change); one 200 ms fade for dialogs.
- The only looping animation is the thinking dots; with `prefers-reduced-motion: reduce` they fade instead of bouncing, and the zoom viewer drops transitions entirely.
- No entrance animations on sections or cards; motion only answers an action or signals live work.

### 3.5 Iconography

Inline SVG built with `createElementNS` (24 px grid, 2 px stroke, round caps), `aria-hidden="true"` with the accessible name on the button. Needed set: chevron, pin, pin-filled, close, open-external, attach, send, search, host, provider, copy, retry. No icon font, no emoji as UI chrome.

## 4. Layout and Breakpoints

All shells are viewport-locked (`100dvh`) with independent scroll areas (spec 2.2 and 2.3). Breakpoints: wide desktop `>= 1200px`, compact desktop and tablet `960-1199px`, mobile `< 960px`.

### 4.1 Wide desktop (`>= 1200px`)

```
+-------------------------------------------------------------------------------------+
| Lyra   Chats(3)  Projects  Admin & Senate             [Ctrl K Search]  ● live  Owner |
+------------------------+--------------------+-----------------------------------------+
| Agents       3/4 online| Conversations      | (D) Dario  Consul  ● online   ...      |
| [By machine|By provider]| Pinned            |-----------------------------------------|
| +-------+------------+ |  (D) Dario    2 ●  |  agent bubble                           |
| | host  | (D) Dario  | |  (E) Echo          |           owner bubble                  |
| | mac   | (C) Claude | | With you           |           ▬▬▬▬▭ Working: Auditing routes |
| | RAM ▮ |            | |  ...               |                 • step / • step          |
| | Disk▮ |            | | Team (read only)   |  agent bubble                           |
| +-------+------------+ |  (D)(C) Dario, ... |                          [New messages] |
|  (scrolls on its own)  |  (scrolls)         |-----------------------------------------|
|                        |                    | [Attach] [Queue v]        draft  [Send] |
+------------------------+--------------------+-----------------------------------------+
   360 px                   280 px               minmax(0, 1fr)
```

### 4.2 Compact desktop and tablet (`960-1199px`)

Agents sidebar stays (340 to 360 px). The chat stage becomes a two-view stack: conversation list, or thread with a Back button ("Conversations") in the thread header, so the thread is never narrower than 420 px.

### 4.3 Mobile (`< 960px`)

```
+------------------------------+     +------------------------------+
| Lyra                 ● live  |     | < Conversations   (D) Dario  |
| [Agents][Chats 3][Projects][A&S]   |    Consul ● online           |
+------------------------------+     +------------------------------+
| Pinned                       |     |  bubbles...                  |
| (D) Dario   "Audit done"   2 |     |                              |
| With you                     |     |                              |
| (E) Echo    "echo: hi"       |     |              [New messages]  |
| Team (read only)             |     +------------------------------+
| (D)(C) Dario, Claude         |     | [Attach][Queue]       [Send] |
+------------------------------+     +-- safe-area inset -----------+
       list view                              thread view
```

- One active pane; the tab strip scrolls horizontally; the Chats tab carries the total unread count.
- Every control is at least 44 x 44 px with 8 px gaps; inputs are 16 px or larger so iOS does not zoom on focus.
- `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on the top bar and composer; `interactive-widget=resizes-content` keeps the composer above the keyboard.

## 5. Agents Sidebar

### 5.1 Header

Pane title "Agents" (serif) with a tabular `3/4 online` count, then a two-option segmented control "By machine | By provider" (`role="radiogroup"`, arrow keys switch, choice persisted). The header is sticky; the list below it scrolls independently (`flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain`).

### 5.2 Agent summary row (collapsed by default)

```
(D)● Dario @dario  [Consul]              > [Chat]
     [working] Opus 5.5 (high), 2 waiting
```

- Avatar 32 px with the presence dot; gold ring when Consul.
- Line 1: name, handle, Consul pill. The name keeps priority; the handle shrinks first and is hidden on Consul rows narrower than 300 px (it stays in the drawer).
- Line 2, one line with ellipsis: one activity pill, then model and effort, then waiting, unconfirmed or unread counts when non-zero. Offline or revoked agents show "offline" or "revoked", never "idle" (spec 6.3). The activity pill moved here from line 1 during Stage 2 QA: beside a 104 px rail the agent column is about 225 px wide, and two pills on line 1 truncated names to one letter.
- Right: a "Chat" button (stops propagation) and a chevron. The whole row is a `<button aria-expanded>`; "Chat" is a sibling button, never nested.
- Expanded drawer: last check-in, context meter, runtime and connector, delivery modes, image capability, waiting and unconfirmed counts, stream attached, address, pool selector, and "Message", "Revoke" (with confirmation) or "Re-admit".

Survey input: Vibe Kanban and Codex group work by attention. Within each host or pool, rows sort by attention: unconfirmed or failed deliveries first, then busy, then idle, then offline, alphabetically within ties.

### 5.3 By machine: host rail card plus agents on the right

```
+----------+-------------------------------------+
| [host]   | (D)● Dario     [Consul] [busy] [Chat]|
| mac-mini | (C)● Claude             [idle] [Chat]|
| 2 online | (E)○ Echo            [offline] [Chat]|
| RAM ▮▮▮▯ |                                     |
| Disk ▮▯▯ |                                     |
|   v      |                                     |
+----------+-------------------------------------+
| RAM 18.4 / 32 GB  [==========-----]  58%       |  expanded drawer, full width
| Disk 412 GB free of 1.8 TB [===----]  77% used |
| macOS 26.4 arm64, 10-core, 192.168.0.108, up 5 d, reported 12 s ago |
+------------------------------------------------+
```

- `.machine-group` is a grid `104px minmax(0, 1fr)`: a tall host card on the left (stretches to the height of its agents) and the agent rows on the right, joined by the card's border so the pair reads as one unit.
- The host card shows host name (wraps), online count and two vertical mini meters for RAM and disk; its chevron opens a full-width drawer below with bars, OS, CPU, architecture, IP, uptime and telemetry freshness (stale badge after 10 minutes).
- Hosts sort online first, then alphabetically. Agents without telemetry fall under "Unknown host".
- On mobile the same grid applies at 96 px for the host column.

### 5.4 By provider: account pool rail cards plus agents on the right

- `.provider-section` per provider (Anthropic, Google, OpenAI, Moonshot...), with a header showing account count and active agents; collapsible.
- Inside, each account pool is a `.pool-group` with the same rail pattern: a tall pool card on the left (pool label, account label, subscription pill, lowest remaining quota as a colored percentage, reporter dot) and that pool's agents on the right. Pools of one provider sit directly adjacent.
- The pool card's chevron opens a full-width drawer: one bar per quota metric with "resets at" times, reporter name and freshness ("stale: reporter offline" in amber), subscription details.
- Agents without a pool appear under "No pool assigned" inside their provider section, so no agent disappears from this view.
- Quota threshold banner (Paperclip pattern): when any pool drops below 10%, a single red line appears at the top of the sidebar with a link that switches to By provider and expands that pool.
- This replaces the standalone Usage tab (spec 6.1).

## 6. Conversations and Thread

### 6.1 Conversation list

- Sections "Pinned", "With you" and "Team (read only)", sorted by pinned, then `last_message_at`, then id (spec 4.4).
- Row: 36 px avatar (or a 24 px overlapping pair for team threads), name, one-line excerpt, relative time, unread pill on the right (`99+` cap), and a separate pin button. Structure: `<div class="conv-row"><button class="conv-main">…</button><button class="conv-pin" aria-pressed>…</button></div>`.
- Consul rows get a 3 px gold left border and a small "Consul" tag.

### 6.2 Unread badges and read receipts

- Row pill, Chats tab total, and the document title (`(3) Lyra`) all derive from `unread_count`.
- Marking read follows spec 4.2: only for the open conversation, while the page is visible and the thread is on screen, deduplicated per `last_read_message_id`, optimistic.

### 6.3 Thread layout

`.conv-view` is a column flex: header (fixed), `#messages` (`flex: 1; min-height: 0; overflow-y: auto`), composer (fixed). The header shows avatar, name, Consul badge, presence and the read-only note for team threads. A floating "New messages" pill appears above the composer when an update arrives while the reader is more than 48 px from the bottom.

### 6.4 Bubbles and reaction removal

- Agent bubbles: 28 px avatar in the gutter, name, time, body. Owner bubbles: right-aligned, `--bubble-me`, no avatar.
- The reaction bar and quick-emoji buttons are removed (spec 4.6). The footer keeps only the lifecycle (owner messages), "Reply" for writable threads, and "Retry delivery" when needed.
- Attachments render as an image strip of 120 x 72 px thumbnails (object-fit cover) that open the zoom viewer.

### 6.5 Composer

```
| [Write a message...                                            ] |
| [Attach image] [Queue v]                    Draft saved   [Send] |
```

- Textarea auto-grows from 40 px to `min(220px, 32dvh)`, then scrolls (spec 4.5). Enter inserts a newline, Ctrl or Cmd+Enter sends, IME composition is respected.
- Left group: Attach (disabled with a reason for text-only agents) and a compact delivery select; when the recipient supports only Queue, show a static "Queue" chip instead of a one-option select.
- Right group: a quiet "Draft saved" hint (desktop only) and the primary Send button.
- Drafts persist per conversation on every input (section 9.3); a failed send never clears the draft.

### 6.6 Markdown and math in bubbles

- Supported: headings (`#` to `####`, rendered one level down), paragraphs with line breaks, bold, italic, strikethrough, inline code, fenced code with a language tag and Copy button, blockquotes, ordered and unordered lists with two nested levels and task items, horizontal rules, GFM tables with alignment inside a horizontally scrolling wrapper, http(s) links and bare URLs, inline `$...$` and display `$$...$$` math via vendored KaTeX.
- Semantic highlights `==red:BLOCKED==` with the allow-list red, orange, amber, green, blue, purple, gray; each maps to a fixed class with a text color plus a faint wash, both themes at 4.5:1 or better. Unknown tokens stay literal.
- Currency guard keeps "Price is $5 to $10" as text; inline code shields math and highlight tokens.

### 6.7 Message lifecycle

Below each owner message to an agent:

```
▬▬▬▭▭  ••• Thinking…                         (meter: Sent, Queued, Delivered, Working, Replied)
▬▬▬▬▭  Working: Auditing routes and CSP headers
       ● Inspect static file handler       (done)
       ● Draft CSP and KaTeX rules         (active, bold)
       ○ Write acceptance QA checks        (pending)
[Delivered]                                 (after the reply arrives: the tracker collapses to a pill)
```

- States follow spec 5.1: sending, waiting (with "#2" queue position), delivered, thinking, working, complete, plus unconfirmed, failed and send failed with their retry or discard actions.
- Added from the survey (Linear's unresponsive state): after 15 minutes delivered with no progress or reply, the line turns amber, "Delivered, no reply for 15 min". The threshold is a constant to be tuned.
- The work card shows at most 6 bullets around the active one, with "3 earlier steps done" and "+2 more" lines.
- Updates re-render the tracker in place so scroll position is untouched.

### 6.8 Image viewer (imgpop)

- One `<dialog>` in the top layer. Desktop: centered card `calc(100vw - 64px) x calc(100dvh - 64px)`, 14 px radius, dark scrim. Mobile: 8 px margins inside the safe area, 12 px radius.
- Toolbar top right: zoom readout, "1:1" (resets to the fitted 100%, disabled at 100%), open-original link, close. 44 px targets on touch.
- 100% means fitted so one axis fills the frame; zoom runs to 800%. Wheel zoom is anchored at the cursor; drag pans when zoomed (grab cursor); double-click toggles 100% and 250% at the pointer; pinch zooms around the midpoint and two-finger moves pan; double-tap toggles; keys `+`, `-`, `0` and arrows. Pan is clamped so the image edge never leaves the frame; on an axis where the zoomed image still fits it stays centered.
- Closes on Esc, the close button or a backdrop click (not after a drag), resets zoom, and returns focus to the thumbnail.
- Note: the spec calls the reset button "1:1" while defining it as a return to the fitted view. The implementation follows the spec; if "1:1" should instead mean one image pixel per screen pixel, that is a one-line change in `imgpop.js`.

## 7. Admin & Senate, Projects

### 7.1 Admin & Senate (merged tab)

Three sections in one scroll, max width 1080 px, two-column forms on desktop and stacked on mobile:

i. **Consul governance:** gold-bordered card with the current Consul (avatar 44 px, serif name, presence), the appoint form and a "Dismiss Consul" button with confirmation, then the Consul invite ledger (target, state pill, issuer, reason, time, Cancel when open).
ii. **Invites and access:** invite form, the one-time code card (code in monospace, Copy with "Copied" status announced politely, the `/lyra-link join` hint), open invites, revoked agents with Re-admit.
iii. **Account pools:** add pool (provider, label, account label, subscription), editable pool rows with the usage reporter select.

Destructive actions (revoke, dismiss Consul, cancel invite) always confirm; survey anti-pattern: Paperclip places an unconfirmed Terminate next to Pause.

### 7.2 Projects and tasks

- Master-detail per spec 8.3 (two columns from 960 px, list then detail with a back button on phones). Status filters for projects (all, active, paused, completed, archived) and tasks (all, open, in progress, in review, blocked, done) persist in view state. Project cards show manager avatar, member stack, status pill and `done/total`. Task rows show priority, title, inline status select and assignee avatars. Assignee pickers list only project members; at least one assignee is required.

## 8. Power-User Ergonomics (zero bloat)

| Feature | Behaviour | Source |
| --- | --- | --- |
| Quick switcher | Ctrl+K or Cmd+K opens a `<dialog>` search over agents, conversations and tabs with fuzzy matching (initials and subsequence, so "dar" finds Dario); Enter opens, Esc closes; recent items first | Linear, Vibe Kanban, Codex |
| Conversation stepping | Alt+Up and Alt+Down move to the previous or next conversation in list order | Codex (Ctrl+Tab) |
| Send | Ctrl or Cmd+Enter sends; Enter is a newline | Existing v1 behaviour, Linear setting |
| Focus composer | `/` when focus is not in a field | Common pattern |
| Reconnect banner | When the SSE stream drops: a slim amber bar under the top bar, "Reconnecting… (retry in 4 s)" with a "Retry now" button; reconnect uses exponential backoff with jitter (1 s to 30 s); on success the bar turns green for 2 s ("Back online, 3 updates") then hides, and a full refresh runs | Mission Control (jittered reconnect); none of the surveyed apps document a banner |
| Session expiry | A 401 keeps drafts and view state, shows the sign-in card, and restores the same conversation afterwards | Spec 3.2 |
| Shortcut help | `?` opens a small list of the shortcuts above | Linear |

Stage 3 adds three single-letter keys (section 12): `N` / `Shift+N` (next or previous agent that needs you), `X` (next unread conversation) and `H` (hide or show the agents sidebar). They act only when focus is outside every text field, select and dialog, so typing in a thread can never trigger them.

## 9. Implemented Modules on This Branch

All modules are plain scripts that attach one global, use no dependencies, and are covered by tests (section 11). Stage 2 wires them into `index.html` and `app.js` against the live v4 API (section 9.1).

| File | Global and API | Covers |
| --- | --- | --- |
| `static/markdown.js` + `markdown.css` | `LyraMarkdown.parse(text)` (pure AST), `render(text, {document, katex})`, `renderInline`, `renderInto(el, text)`, `renderKatex` | Section 6.6, spec 4.7 |
| `static/imgpop.js` + `imgpop.css` | `LyraImgPop.bind(root)`, `enhance(img)`, `open(src, {alt, href, trigger})`, `close()`, `isOpen()`, `state()`, `math` (pure geometry) | Section 6.8, spec 4.1 |
| `static/store.js` | `LyraStore.create(storage?, {namespace})` returning `view.load(ctx)`, `view.save`, `view.patch`, `drafts.key({convId} or {agentId})`, `drafts.save/load/clear/migrate/list` | Spec 3.1 and 3.2 |
| `static/avatar.js` + `avatar.css` | `LyraAvatar.el(principal, size, {status, consul, label})` with size `xs`, `sm`, `md` or `lg`; `stack`, `spec`, `initials`, `contrast` | Spec 4.3 |
| `static/lifecycle.js` + `lifecycle.css` | `LyraLifecycle.phase(msg, {replied, now})`, `replied(msg, msgs)`, `render(msg, ctx, handlers)`, `update(el, msg, ctx, handlers)` | Section 6.7, spec 5 |

### 9.1 Wiring for v4 (`app.js`, `index.html`, `app.css`), done in Stage 2

All seven steps below are implemented. `app.js` reads `/api/v1/board` and `/api/v1/conversations`, follows SSE (`presence`, `principal`, `invite`, `pool`, `project`, `message`, `message_state`, `message_progress`, `conversation`) with `?last=` replay, debounced refreshes and the reconnect banner, and keeps every node DOM-built (no HTML strings; event handlers only through `addEventListener`).

i. `index.html`: viewport meta from spec 2.2; stylesheets `vendor/katex/katex.min.css`, then the module CSS, then `app.css`; scripts `vendor/katex/katex.min.js`, the five modules, then `app.js`, all `defer`.
ii. Replace `renderBody` and `inline` in `app.js` with `LyraMarkdown.render(m.body)`.
iii. Replace `imageLink` anchors with thumbnails passed through `LyraImgPop.enhance`; call `LyraImgPop.bind(document.body)` once in `boot()`.
iv. Replace the `S.drafts` map and `switchDraft()` with `LyraStore` drafts keyed by conversation or pending agent; restore view state after the first `/board` and `/conversations` load.
v. Use `LyraAvatar.el` in the roster, conversation rows, bubble gutters and Admin & Senate.
vi. Replace `stateBadge` for owner messages with `LyraLifecycle.render`, and update in place on `message_state` and `message_progress` events.
vii. Rebuild `app.css` on the tokens in section 3 and the layouts in sections 4 to 8; remove the reaction styles and the uppercase group labels.

### 9.2 Markdown contract notes

- Inline tokens do not span lines; emphasis needs a non-space character after the opener and before the closer; `_` emphasis requires word boundaries so `snake_case` stays text.
- Links accept only `http://` and `https://` and exclude quotes; everything else stays literal text.
- KaTeX runs with `throwOnError: false, strict: false, trust: false, maxSize: 40, maxExpand: 500`; formulas over 4000 characters or any KaTeX exception fall back to the TeX source in monospace.
- Inputs over 64,000 characters are truncated before parsing; pathological inputs (16,000 asterisks, thousands of unmatched `$`, backticks or `==red:`) parse in milliseconds.

### 9.3 Storage keys

- View state: `lyra.ui.v2.state` (optional `:namespace` suffix per user later).
- Drafts: `lyra.ui.v2.draft.conv:<id>` and `lyra.ui.v2.draft.pending:<agentId>`, value `{text, replyToId, mode, updatedAt}`; an empty text with no reply target deletes the key.
- All access is wrapped: private-mode and quota errors fall back to an in-memory store and never throw.

## 10. Server Prerequisites (live on `upstream/main` since 855c1ec)

All four were delivered upstream; this branch does not change `server/lyra_server/*.py`.

| Prerequisite | Status |
| --- | --- |
| Nested static paths | Live: segment-wise checks, `/static/vendor/katex/*` served |
| Font MIME types and caching | Live: `font/woff2` and friends, 7-day cache for `/static/vendor/` |
| CSP for KaTeX | Live: `style-src-attr 'unsafe-inline'` only; `test_live_csp_allows_katex_and_blocks_unsafe_scripts_and_styles` proves KaTeX renders while inline scripts, handlers, `eval`, `data:` scripts and `<style>` elements stay blocked |
| v4 data | Live: read cursors, pins, progress with stale flag, `presence.effective_status`, hosts, avatars, pool metadata, projects and tasks with `in_review` |

The modules still degrade safely: without KaTeX, math shows as TeX source; without progress, the lifecycle stops at "Delivered"; without telemetry, hosts show "Unknown host".

## 11. Verification

- `server/tests/test_js_modules.py` runs with the normal server suite:
  - **Hygiene scan:** no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` or style or event attributes in the modules, plus a check that the vendored KaTeX is present.
  - **Hygiene scan** also covers `app.js`, and a static check pins the live `web.CSP` to `'unsafe-inline'` for style attributes only.
  - **Engine tests** (`tests/js/test_engine.js`, 32 cases): parser, geometry, storage (theme, sidebar, mutes, draft images), brand, avatar (server formats and image paths) and lifecycle (receipts, the live bubble, server `state` bullets and the `stale` flag). Runs under JavaScriptCore (`jsc` on macOS) or Node (CI).
  - **Browser tests** (`tests/js/test_dom.js`, 13 cases, plus the engine cases in the page): set `LYRA_BROWSER_TESTS=1` with Chrome or Chromium installed. Pages are served with the live Lyra CSP header; `tests/js/csp_probe.html` checks KaTeX against each blocked vector. Covers XSS payloads (QA-02), KaTeX and currency (QA-20), wide tables on 390 px (QA-18), the dialog size, wheel anchoring, drag clamping, double-click, keyboard, pinch and double-tap (QA-06, QA-07), focus return, avatars (QA-12), lifecycle (QA-21, QA-22) and persistent drafts (QA-11).
- `server/tests/test_board_e2e.py` (opt-in with `LYRA_BROWSER_TESTS=1`) runs the wired board end to end. It seeds a real server through the public API (`tests/js/qa_board.py`: hosts with telemetry and an alias, pools with usage and a long duplicated label, Consul, PNG avatars, needs-input, stalled, held and offline agents, every message state including cancelled, an image, pins, a team thread, an orphaned upload, projects with all six task states and a blocked reason) and puts a test-only sign-in proxy in front, which can drop SSE streams. It then drives Chrome over the DevTools pipe (`tests/js/cdp.py`) at 1440 x 900 and at 390 x 844 (touch, DPR 2):
  - `tests/js/qa/probe.js` runs 32 desktop and 6 phone feature checks with DOM events only, in light and in dark. It also fails on any element that crosses its rail, card or row container.
  - Any page error, console error or CSP violation fails the test.
  - `tests/js/qa_shots.py` captures light and dark screenshots; set `LYRA_QA_SHOTS=<dir>` to keep them.
- `tests/js/gallery.html` and `tests/js/phone.html` remain the module-level visual QA pages; they are not served by Lyra.

## 12. Stage 3 (schema v5): UI and orchestration

Wired against `upstream/main` dcebc90 (`docs/API.md` section 6.4); `server/lyra_server/*.py` is unchanged on this branch.

### 12.1 Look and brand

- **Themes:** one token set through `light-dark()`. The default follows the system; the topbar switch (`#themeToggle`, `role="switch"`) pins Dark or Light in LyraStore (`theme`), and `brand.js` applies it in `<head>` before first paint. Dark uses neutral grays: `#121316` page, `#18191c` bars, `#202124` cards, `#282a2e` raised surfaces, `#2f3136` lines, `#e8eaed` text.
- **Brand:** `brand.js` draws the Lyra constellation (Vega as a four-point star, then the zeta, delta, gamma and beta parallelogram) in `#facc15` on a dark tile, inline SVG with no external URLs. The wordmark is `#facc15` in dark and `#b07d00` in light (3.6:1 on white). `static/favicon.svg` is a bolder variant that stays legible at 16 px.
- **Provider marks:** Anthropic, Google, Google Gemini and Moonshot AI come from Simple Icons (CC0-1.0), and OpenAI from LobeHub lobe-icons (MIT). They are inlined as single SVG paths. Anthropic and Google keep their brand colors; OpenAI and Moonshot use `currentColor`. They appear in By provider headers, pool cards, Senate pools, agent rows and drawers, and on the sign-in card. Unknown providers get a neutral hexagon.
- **Avatars:** `avatar.image` (`/static/avatars/<file>`, same path rule as the server) renders as a circle-cropped `<img>`; on `error` the image is removed and the icon or initials return.
- **Controls:** thin scrollbars in both themes. Attach image is a paperclip icon (36 px, 44 px on touch) with a CSS tooltip that also shows when it is disabled ("Text only: this agent does not accept images"). Delivery and Send are pills.

### 12.2 Agents rail

- **Needs you (n):** the first section of the rail lists agents that need the owner, one entry per agent, with the most urgent reason first. Reasons are `needs_input`, `stalled`, offline with waiting or unconfirmed mail, unconfirmed delivery, and a failed message in the last 24 hours. The count shows on the mobile Agents tab and in `document.title` together with unread messages.
- **Status chips:** each row shows the server's `effective_status` honestly (`needs input`, `stalled`, `no updates` for stale, `detached`, `working`, `unknown`, `idle`, `offline`). `effective_since` goes in the tooltip and the drawer. A purple `held` pill marks a held agent.
- **Context ring:** 14 px, colored by band: under 30% calm, 30 to 60% normal, 60 to 80% warning, 80% and up critical.
- **Drawer actions:** Hold or Resume delivery (`POST` or `DELETE /admin/principals/{id}/hold`), and Mute notifications per agent (`mutedAgentIds`).
- **Machines:** host cards show the alias (`hosts[].display_name`) on one line with an ellipsis; host names never break mid-word. RAM and disk bars fill and carry explicit `used / total GB` labels (`22.5 / 64 GB`, `492 / 1858 GB`). Right-click (or the Menu key) opens a menu with Rename machine (a dialog, no `prompt()`), Use the host name, and Show details; the expanded card repeats Rename for touch users. Changes go to `PUT /admin/hosts/{host}`.
- **Pools:** label, account and plan are shown once each. Every rail, card and row child has `min-width: 0`, and long labels and pills end in an ellipsis, so no text crosses the rail divider (owner screenshot #131).
- **Sidebar:** collapse with the topbar button or `H`. Drag the gutter handle to resize, or use arrow keys on it (Shift for larger steps, Home and End for the limits); double-click resets. Width is clamped to 280 to 560 px. Collapsed state and width persist. The phone layout keeps its Agents tab.

### 12.3 Threads

- **Owner receipts:** `Sending…`, then one check `Server` (with `#n in queue` and `Cancel` while unclaimed), then two checks `Agent read`. `Delivery unconfirmed` offers `Retry`; `Cancelled` and `Failed: reason` are shown plainly. No progress appears under the owner's bubble.
- **Live agent bubble:** while the agent is thinking, working or waiting for input, a dashed placeholder bubble with its avatar sits at the bottom of the thread. It shows animated dots, the summary, the step bullets (six visible) and an elapsed `m:ss` timer. Input required is outlined in the accent color, and stale or stalled work turns amber or red. It disappears when the reply lands.
- **Details:** a quiet trigger on answered, delivered, unconfirmed, failed or cancelled messages opens a dialog backed by `GET /messages/{id}/lifecycle`. It lists the milestones (browser, server, claim, agent read, progress, reply) with millisecond times, bars for `client_to_server`, `server_to_claim`, `claim_to_agent_read`, `agent_think_to_reply` and `total_round_trip`, and a delivery attempts table. Sends include `client_sent_at`.
- **Cancel:** `POST /messages/{id}/cancel`; a `409 message_claimed` says it is too late.
- **Draft images:** uploaded images are part of the per-conversation draft (`{id, filename, mime_type, size_bytes}`, at most eight). They return as thumbnails after a reload. A thumbnail that fails to load (an expired upload) is pruned from the draft with a short note. Images stay in the draft while an agent is temporarily text only; Send is disabled until they are removed or allowed.

### 12.4 Projects, Senate and storage

- **Tasks:** the `cancelled` state appears in filters, selects and the project count bar (`task_counts`). Choosing `Blocked` opens the task dialog with a reason field (`blocked_reason`). Every update sends `expected_version`; a `409 version_conflict` reloads the board and asks the owner to apply the change again.
- **Senate:** the tab formerly called "Admin & Senate" is now **Senate**. Stored `admin-senate` and `admin` tabs map to it.
- **Lyra Server Storage:** reads `board.server_storage`, with the cleanup response refreshing it. It shows usage against the quota (10 GB by default) and a breakdown: database, attachments, orphaned uploads, backups, events, messages, host disk free of total, and server uptime. Buttons run `POST /admin/cleanup` with `sweep_orphans`, `prune_events`, `prune_backups`, `vacuum_wal` or `all`; destructive steps ask for confirmation.

### 12.5 Live data and alerts

- **SSE:** the cursor is seeded from `board.last_event_id`. `event: reset` triggers a full reload. The named `event: tick` (every 15 s) feeds a 30 s watchdog that drops a silent stream into the reconnect banner. `host` events refresh the board.
- **Notifications:** an explicit bell toggle requests permission on the user's gesture. While the tab is hidden, a new agent message or a new Needs you reason raises a desktop notification with a soft two-tone WebAudio chime, unless that agent is muted.

## 13. Survey Notes and References

| Product | Adopted | Avoided |
| --- | --- | --- |
| Vibe Kanban | Attention-first grouping, pinned items on top, fuzzy Cmd+K, per-view state memory | Issue to workspace to session nesting |
| Paperclip | Avatar plus status line, quota bar with a threshold banner that links to the fix | Destructive action next to a safe one without confirmation; animated mascots |
| Mission Control | Jittered reconnect; one activity stream | Panel sprawl |
| Linear | Run states with an unresponsive timeout, single replaceable activity line, three-token themes, restrained accent | Shortcuts as the only path |
| Codex app | Pinned and recent threads, activity of unread and running work, notification modes (never, background only, always) | No default quick switcher |

Notification modes and sound are noted for a later version; v2 relies on unread badges and the document title.

Sources (read 2026-11-28):

- https://github.com/BloopAI/vibe-kanban and https://vibekanban.com/docs (interface, command bar, settings)
- https://raw.githubusercontent.com/paperclipai/paperclip/master/README.md and https://docs.paperclip.ing (dashboard, agents)
- https://raw.githubusercontent.com/builderz-labs/mission-control/main/README.md and its CHANGELOG
- https://linear.app/developers/agent-interaction, https://linear.app/now/behind-the-latest-design-refresh, https://linear.app/changelog/2026-03-12-ui-refresh
- https://openai.com/index/introducing-the-codex-app/, https://learn.chatgpt.com/docs/features, https://learn.chatgpt.com/docs/notifications, https://learn.chatgpt.com/codex/reference/commands
- Vercel Web Interface Guidelines snapshot: https://github.com/vercel-labs/web-interface-guidelines (pinned commit in the installed skill)
