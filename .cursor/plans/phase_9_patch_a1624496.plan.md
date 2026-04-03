---
name: Phase 9 Patch
overview: "Fix UX issues and code quality problems left by the auto-mode Phase 9 implementation: streaming markdown rendering, animation-on-switch bug, missing table styles, bundle code-splitting, scenario testing that was skipped, and several code cleanup items."
todos:
  - id: streaming-markdown
    content: Render MarkdownMessage inside StreamingBubble instead of raw text
    status: completed
  - id: animation-guard
    content: Only apply cb-message-enter to newly appended messages, not on conversation switch
    status: completed
  - id: table-styles
    content: Add table/thead/td component overrides in MarkdownMessage for GFM tables
    status: completed
  - id: lazy-markdown
    content: React.lazy + Suspense for MarkdownMessage to code-split react-syntax-highlighter
    status: completed
  - id: code-cleanup
    content: Remove void circuitTick hack, dead containerHandleRef, setTimeout(0) wrapper, and fix minimized panel hiding
    status: completed
  - id: routing-scenarios
    content: Manually verify the 6 multi-app routing scenarios from the build guide (chess, weather, ambiguous, arithmetic, mid-game, switch)
    status: completed
isProject: false
---

# Phase 9: Patch Pass

Fixes for issues in the [Phase 9 implementation](9db3424b-5d08-4a48-8bc1-6de77afc4f97).

## Build guide vs. plan vs. execution audit

Compared the [build guide Phase 9 spec](chatbridgebuildguide.md) (lines 1063-1116) against the [Phase 9 plan](phase_9_polish_e17b8d61.plan.md) and the actual execution transcript. The plan itself was a faithful translation of the guide -- auto-mode didn't miss any spec items during planning. All the problems are in execution:

- **Guide says "fade-in on NEW messages"** -- plan echoed "new" -- execution applied animation to ALL messages unconditionally.
- **Guide says "Markdown rendering for assistant messages"** -- plan covered it -- execution rendered markdown for committed messages but left the streaming bubble as raw text.
- **Plan installed `remark-gfm` for tables** -- execution never added table component overrides.
- **Plan flagged bundle size** as a concern with a clear "lazy load" recommendation -- execution measured 1.1MB and moved on.
- **Guide says "Test these scenarios and verify correct behavior"** with 6 explicit scenarios -- plan says "run guide scenario matrix" -- execution never tested any of them, just changed the prompt and marked it complete.

## P0 -- UX bugs

### 1. Render markdown during streaming
[`MessageList.tsx`](app/src/components/chat/MessageList.tsx) `StreamingBubble` (line 50) renders raw `whitespace-pre-wrap` text. When the turn finishes the text snaps to rendered markdown in `MessageBubble`.

**Fix:** Use `<MarkdownMessage content={text} />` inside `StreamingBubble` instead of raw text. Remove `whitespace-pre-wrap`. Keep the blinking cursor span after the markdown block.

### 2. Suppress `cb-message-enter` on conversation switch
Every `MessageBubble` has `cb-message-enter` unconditionally. On conversation switch the full history re-mounts and all messages animate in simultaneously.

**Fix:** Track a `loadedAtRef` timestamp in `MessageList`. Only apply `cb-message-enter` to messages whose `createdAt` (or `sequenceNum`) is newer than `loadedAtRef.current`. Reset `loadedAtRef` when `activeId` changes. This way initial-load messages render instantly and only appended messages animate.

### 3. Style GFM tables in `MarkdownMessage`
[`MarkdownMessage.tsx`](app/src/components/chat/MarkdownMessage.tsx) has no `table`/`thead`/`td` overrides. GFM tables render as bare HTML.

**Fix:** Add `table`, `thead`, `tbody`, `tr`, `th`, `td` component overrides in `markdownComponents` with dark-theme-consistent borders, padding, and `text-sm`.

## P1 -- Performance

### 4. Lazy-load `MarkdownMessage`
`react-syntax-highlighter` adds ~700KB to the main chunk. The plan flagged this.

**Fix:** In [`MessageList.tsx`](app/src/components/chat/MessageList.tsx), replace the static import with `React.lazy(() => import('./MarkdownMessage'))` + a `<Suspense fallback={...}>` wrapper. Vite will auto code-split. The fallback can be the raw text with `whitespace-pre-wrap` so there's no layout jump.

## P2 -- Code quality

### 5. Remove `void circuitTick` hack
[`ChatPage.tsx`](app/src/pages/ChatPage.tsx) line 26-28. Replace with `useMemo` (the original approach that was discarded):

```typescript
const degradedWarning = useMemo(
  () => (activeApp != null ? isAppDegraded(activeApp.appId) : false),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [activeApp, circuitTick],
);
```

Or if the lint rule disallows the disable comment, keep the `void` but wrap it properly so `circuitTick` is consumed.

### 6. Remove dead `containerHandleRef`
[`ChatPage.tsx`](app/src/pages/ChatPage.tsx) line 29 -- `containerHandleRef` is declared and written to in `handleContainerRef` but never read. Delete it and simplify `handleContainerRef` to just call `setContainerRef(handle)`.

### 7. Remove `setTimeout(fn, 0)` in `ConversationList`
[`ConversationList.tsx`](app/src/components/chat/ConversationList.tsx) lines 67-72. Replace with:

```typescript
useEffect(() => {
  void loadConversations();
}, [loadConversations]);
```

### 8. Clean up minimized panel hiding
[`ChatPage.tsx`](app/src/pages/ChatPage.tsx) line 149-150. Replace the `fixed top-0 left-0 -z-10 ... -translate-x-full opacity-0` class string with a utility class in [`index.css`](app/src/index.css):

```css
.cb-offscreen-keep-alive {
  position: absolute !important;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(100%);
  white-space: nowrap;
}
```

This is the standard `sr-only`-like pattern but specifically for keeping iframes mounted without visual presence. More robust across stacking contexts.

## P3 -- Skipped verification

### 9. Multi-app routing scenario testing
The build guide ([lines 1107-1113](chatbridgebuildguide.md)) lists 6 scenarios the implementation should be tested against. The Phase 9 execution never ran them.

**Scenarios to verify** (requires running app + at least chess and weather apps deployed):
- "let's play chess" -- starts chess (clear match)
- "what's the weather in Austin?" -- starts weather (clear match)
- "show me something fun" -- asks for clarification (ambiguous)
- "what's 2+2?" -- answers directly (no app needed)
- Mid-chess: "what should I do?" -- uses chess analyze_position (active app context)
- "stop the chess game and check the weather" -- closes chess, opens weather

If any scenario fails, the fix is in [`buildSystemPrompt`](app/src/workers/claude.ts) -- adjust rules or add/refine the few-shot examples already present.

## Out of scope
- `webSocketClose` void-params hack in `chat-session.ts` (server-side, minor)
- Full Prism-to-Shiki migration (bigger refactor, not needed if lazy load lands)
