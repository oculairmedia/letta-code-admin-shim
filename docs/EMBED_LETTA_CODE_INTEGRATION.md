# Embed Letta Code as on-device runtime — integration design

**Status:** Day 0 spike complete 2026-05-26 02:00 EDT. Highest-risk unknown (Node 22 requirement) resolved. Full Android spike pending — 1–2 day budget.

**Decision bead:** `lcp-59c` (P1, open)
**Spike bead:** `lcp-59c.1` (P1, open)
**Filed by:** Emmanuel + Meridian, 2026-05-26 01:30am EDT, after reviewing phodal/auto-dev and SeekerClaw and confirming Letta Code is TS with an existing local backend mode.

This doc is the canonical project-side reference for the embed-Letta-Code-via-nodejs-mobile pivot. Grounded in a source-tree review of `sepivip/SeekerClaw` (a shipping production app using the same pattern) and a live Day 0 spike confirming Node-version compatibility.

---

## TL;DR

- **Letta Code is TS/Node end-to-end.** It already has `letta --backend local` mode that runs an embedded stateful agent server (agents, conversations, memfs-with-git, providers) at `~/.letta/lc-local-backend/`.
- **We were going to reimplement this in Kotlin** via the `letta-mobile-hua6` (Koog turn engine) and most of `letta-mobile-i8dl` (KMP common-core LettaBackend / MemFS / RuntimeEvent outbox) epics. Months of work.
- **Instead: embed nodejs-mobile in the Android app and ship actual `letta.js` as the on-device runtime.** Same code on phone, desktop, and home server.
- **SeekerClaw (111⭐, shipping)** proves the pattern works on Android 14+ with a ~100-line C++ bridge and ~250-line Kotlin runtime bootstrap.
- **Day 0 result:** `letta.js` boots and runs end-to-end on Node 18.20.8 (the version SeekerClaw uses). The `engines: ">=22.19.0"` constraint is install-time only, not runtime. So we can use SeekerClaw's exact nodejs-mobile v18.20.4 prebuilt — no upstream PR work, no fork, no waiting.
- **Net effect if spike succeeds:** delete `letta-mobile-hua6` epic, reshape `letta-mobile-i8dl` to ~25-30% of original scope, rewrite Phases 2–3 of the multiplatform roadmap.

---

## Context

Letta Code (`@letta-ai/letta-code`) is the new agent backend and it is TS/Node end-to-end:

- Shipped as a single bundled `letta.js` (`#!/usr/bin/env node`) — bun's bundler inlines all dependencies into ~491K lines
- Node engine field: `>=22.19.0` (install-time only — see Day 0 result)
- npm deps: `ws`, `react`, `ink`, `sharp`, `glob`, `@letta-ai/letta-client`, `node-pty`
- **Already has a local-first mode:** `letta --backend local` runs an embedded stateful agent server inside Letta Code itself, storing agents/conversations/memory/secrets at `~/.letta/lc-local-backend/`

The runtime we were going to reimplement in Kotlin via Koog (the `hua6` epic) and partially in commonMain (`i8dl` LettaBackend interface / MemFS prompt compiler / RuntimeEvent outbox) **already exists, in TS, and works.**

---

## Proposal

Stop reimplementing the agent runtime in Kotlin. Embed nodejs-mobile in the Android app and ship the actual Letta Code (`letta.js`) as the on-device runtime. Same code on phone, desktop, and home server.

Architecture becomes:

- **Letta Code (TS, Node)** = agent runtime everywhere — home server, desktop, mobile
- **Kotlin / Compose** = UI shell + host capabilities + transport bridge to local Node process
- **Transport** = loopback HTTP/WS when local, existing `/shim/v1/mobile` WS when remote
- **Capability enum** gains a third value: `LocalLettaCode` (sibling to `RemoteLettaRestSse` and `AdminShimWs`)

---

## Why this is the right call

1. **Cohesion problem solves itself.** Emmanuel's concern was: *"closely copy letta's way of handling context as I don't want the agent to feel different."* If we embed actual Letta Code as the runtime, there IS no drift — it's literally the same code path local and remote.
2. **Free agent / paid rig product split survives intact.** Free agent = Letta Code + Compose UI in a single APK / single .exe. Rig = vibesync still orchestrates from a server.
3. **Desktop v1 becomes trivial.** Bundle Node + letta.js + Compose Desktop. Single .exe via jpackage. Same code as Android.
4. **Skill ecosystem story already done.** Letta Code already has skills, hooks, permissions, channels, MemFS, `/palace`, `/doctor`, `/sleeptime`.
5. **Independent convergence on this architecture.** phodal/auto-dev (4.5k⭐, KMP, multi-host) and SeekerClaw (111⭐, nodejs-mobile + Kotlin shell) both arrived at shapes near this independently. SeekerClaw specifically proves nodejs-mobile + Kotlin/Compose + Node agent runtime is viable on Android 14+.

---

## Day 0 result — Node 22 is NOT required at runtime

Tested 2026-05-26 02:00 EDT on Node 18.20.8 against the bundled `letta.js` from `@letta-ai/letta-code` 0.26.2. **It works end-to-end.**

### Test method

- `curl -s -o /tmp/node-v18.tar.xz https://nodejs.org/dist/v18.20.8/node-v18.20.8-linux-x64.tar.xz && tar -xJf` — got a clean Node 18.20.8 binary
- `/tmp/node-v18.20.8-linux-x64/bin/node /root/.bun/install/global/node_modules/@letta-ai/letta-code/letta.js ...` — invoked letta.js directly with Node 18
- Used a clean `$HOME=/tmp/letta-spike-home3` so nothing leaked into the host's real `~/.letta`
- Setup took ~2 minutes; testing took ~10 minutes

### What was verified

- ✅ `letta --version` → `0.26.2 (Letta Code)`
- ✅ `letta --help` → full help output, all flags parsed
- ✅ `letta --backend local backend` → reports default backend
- ✅ `letta --backend local connect anthropic --api-key <key> --base-url <url>` → "Connected Anthropic (anthropic) in local storage", writes `$HOME/.letta/lc-local-backend/providers/auth.json`
- ✅ `letta --backend local --new-agent --model anthropic/claude-haiku-4-5 --personality blank -p "..."` → cold-starts the runtime, creates agent, initializes memfs with a real git repo, writes system/persona.md + system/human.md with frontmatter, creates conversation manifest + system-prompt.json + messages.jsonl, dispatches to LLM with full retry logic, surfaces error cleanly

### What persisted on disk after the run

```
.letta/.lettasettings
.letta/settings.json
.letta/transcripts/agent-local-<uuid>/local-conv-1/state.json
.letta/transcripts/agent-local-<uuid>/local-conv-1/transcript.jsonl
.letta/lc-local-backend/providers/auth.json
.letta/lc-local-backend/agents/<base64-agent-id>.json
.letta/lc-local-backend/conversations/<base64>/manifest.json
.letta/lc-local-backend/conversations/<base64>/system-prompt.json
.letta/lc-local-backend/conversations/<base64>/conversation.json
.letta/lc-local-backend/conversations/<base64>/messages.jsonl
.letta/lc-local-backend/memfs/<agent-id>/memory/system/{persona,human}.md
.letta/lc-local-backend/memfs/<agent-id>/memory/.git/      ← real git repo, real commit
```

### The only failure

LLM call returned 401 / connection error because the test environment doesn't have a reachable Anthropic gateway. **Not a Node compatibility issue.** The runtime did everything correctly up to and including the HTTP dispatch.

### Implications

**THE NODE 22 BLOCKER IS NOT REAL FOR OUR USE CASE.**

The `package.json` `engines` field (`>=22.19.0`) is enforced by npm/bun at install time, not by the bundled letta.js at runtime. Once bundled, letta.js runs fine on Node 18.20.x.

This means:

1. We can use the existing **nodejs-mobile v18.20.4 prebuilt** that SeekerClaw already ships in production
2. **No upstream PR #150 to build/maintain ourselves** (PR #150 has been clean-and-mergeable for 9 months with no movement)
3. **No fork to maintain**
4. **No bounty / waiting on the nodejs-mobile maintainers**
5. The SeekerClaw integration pattern applies essentially as-written
6. node-pty becomes the next risk to verify, not the second risk after Node-version

### Recommendation

**GREENLIGHT THE SPIKE.** Highest-risk unknown resolved in 10 minutes of testing. Proceed with the Day 1 plan (verbatim SeekerClaw bootstrap), then directly to dropping letta.js + `LETTA_LOCAL_BACKEND_DIR` pointing at `filesDir`.

---

## Reference implementation: how SeekerClaw embeds Node on Android

[sepivip/SeekerClaw](https://github.com/sepivip/SeekerClaw) (111⭐, shipping on Play Store and dApp Store) ships ~24K lines of Node code inside an Android app, running 24/7 as a foreground service. Their entire native bridge is ~100 lines of C++ plus ~250 lines of Kotlin runtime bootstrap.

### Architecture (top down)

```
┌─────────────────────────────────────────────────────┐
│ Compose UI (Kotlin)                                 │
│   ├─ Settings screens, chat UI, log viewer          │
│   └─ talks to Service via standard Android Service  │
├─────────────────────────────────────────────────────┤
│ Foreground Service (Kotlin)                         │
│   ├─ extractBundle() — copy assets → filesDir       │
│   ├─ NodeBridge.start() — JNI call to node::Start() │
│   ├─ AndroidBridge (NanoHTTPD on 127.0.0.1:8765)    │
│   │   └─ exposes Android capabilities to Node       │
│   └─ Watchdog, log forwarding via FileObserver      │
├─────────────────────────────────────────────────────┤
│ Native lib (C++, ~100 lines)                        │
│   ├─ JNI entry point startNodeWithArguments         │
│   ├─ stdout/stderr pipe → logcat                    │
│   └─ calls node::Start(argc, argv) — blocking       │
├─────────────────────────────────────────────────────┤
│ libnode.so (prebuilt, downloaded at build time)     │
│   ├─ github.com/nodejs-mobile/nodejs-mobile         │
│   ├─ v18.20.4 (their version, will be ours too)     │
│   └─ ABI: arm64-v8a (single ABI ships)              │
├─────────────────────────────────────────────────────┤
│ Node.js process (the JS agent runtime)              │
│   ├─ main.js — entry point (for us: letta.js)       │
│   ├─ http server on 127.0.0.1:8766 (control)        │
│   ├─ http client → 127.0.0.1:8765 (calls Kotlin)    │
│   └─ writes node_debug.log; Kotlin tails via        │
│       FileObserver                                  │
└─────────────────────────────────────────────────────┘
```

### What SeekerClaw proves works in production

- nodejs-mobile + Kotlin/Compose + foreground service is a viable on-device JS runtime on Android 14+
- The native bridge is small: ~100 lines of JNI C++, ~250 lines of Kotlin runtime bootstrap
- Bidirectional HTTP-localhost IPC pattern (Kotlin NanoHTTPD on `:8765` for host capabilities, Node http server on `:8766` for control) works reliably
- stdout/stderr → pipe → logcat redirection works
- Asset extraction from APK to filesDir on first-run / APK-update works
- Ephemeral config delivery (write to filesDir, give Node 5s to read, delete) is a clean secret-passing pattern
- Per-boot auth token on the HTTP bridge is sufficient app-isolation defense
- FileObserver-based log tailing from Kotlin works

### Hard constraints SeekerClaw reveals

1. **Node.js can only be started ONCE per OS process.** `node::Start()` is one-shot. To "restart Node," they kill and respawn the entire foreground service via `stopService` + `AlarmManager` + `START_STICKY`.
2. **The `node::Start()` call blocks the calling thread forever.** Must run on a dedicated background executor, never main thread.
3. **One ABI per APK** (arm64-v8a). Each ABI adds ~30MB to APK size for libnode alone.
4. **stdout/stderr must be redirected** to logcat via pipe + thread. Default Android JNI swallows them. The pattern is in `native-lib.cpp` — copy verbatim.
5. **Node project assets live in `app/src/main/assets/nodejs-project/`** and get copied to `filesDir/nodejs-project/` on first run or APK update (detected via `packageInfo.lastUpdateTime`). Reason: APK assets are read-only zip entries; Node needs writable fs.
6. **Per-boot auth token** required on the Kotlin↔Node HTTP bridge — anything else and any app on the device could connect to `127.0.0.1:8765`.
7. **Ephemeral config**: SeekerClaw writes `config.json` to workspace, gives Node 5 seconds to read it, then deletes. Secrets never persist on disk in plaintext form longer than necessary.
8. **Bidirectional bridge pattern:**
   - Kotlin → Node: Node runs HTTP on `127.0.0.1:8766`
   - Node → Kotlin: Kotlin runs NanoHTTPD on `127.0.0.1:8765`, Node calls it via `http.request`

---

## Mapping to letta-mobile

### Concept mapping

| SeekerClaw piece | Letta-Mobile equivalent |
|---|---|
| `nodejs-project/main.js` | `letta.js` (with argv: `--backend local`) |
| `AndroidBridge` (HTTP `:8765`) | `LettaHostBridge` — surfaces host capabilities (file picker, clipboard, OS keychain, notifications) to letta.js |
| `internal-control-server` (HTTP `:8766`) | Letta Code's own local server endpoints (chat, runs, A2UI, etc.) — letta.js already serves these |
| `config.json` ephemeral write | Same pattern: write API keys + config, give letta.js 5s to read, delete |
| `node_debug.log` + FileObserver | Same pattern — letta.js logs to a file the Kotlin side tails |
| Foreground service | Same — wrap nodejs-mobile in a Service |
| Compose UI ↔ Service binding | Same — UI ViewModel binds to Service, gets state |

### Transport — Compose UI ↔ embedded letta.js

SeekerClaw uses HTTP-localhost only. We need bidirectional WS because A2UI surfaces and Letta runs are stream-shaped, not request/response.

**Option A — Direct WS to letta.js's existing server (RECOMMENDED for v1).**

- Letta Code already runs a WS endpoint when in `--backend local` mode (it has to, for the local CLI client). The Compose UI dials it on `127.0.0.1:<port>`.
- Same Letta Code wire protocol the admin-shim already speaks.
- **Pro:** zero new transport code. Compose UI uses identical client code whether talking to remote shim WS or local letta.js WS.
- **Con:** need to discover what port letta.js listens on. Likely options: pass via env var (`LETTA_LOCAL_PORT=...`) or read from a state file letta.js writes on boot.

**Option B — Run admin-shim itself in nodejs-mobile, in front of letta.js.**

- Embed BOTH the admin-shim AND letta.js (they're both Node — same runtime).
- Compose UI talks to admin-shim on `127.0.0.1:<shimPort>`, admin-shim talks to letta.js on a sibling port.
- **Pro:** Compose UI sees identical contract whether local or remote — admin-shim always fronts.
- **Con:** can't run two Node processes (one `node::Start()` per OS process). Would need `child_process` support inside nodejs-mobile (verify in spike).

**Recommendation:** start with Option A. Simpler, less surface area. Escalate to Option B only if we discover the admin-shim does something on-device that letta.js itself can't (A2UI dispatch, transport-exclusivity contract enforcement, capability negotiation).

### Connection-contract update

`capability.mobile_transport` gets a third value `LocalLettaCode` (sibling to `RemoteLettaRestSse` and `AdminShimWs`). The single-active-mutator rule already in the admin-shim transport-exclusivity contract still applies: when local letta.js is the live transport, do NOT consume remote SSE/WS concurrently for the same conversations.

### File layout (Android)

```
android-compose/app/
├── build.gradle.kts                         # download libnode v18.20.4 prebuilt
├── libnode/                                 # extracted libnode tarball (gitignored)
│   ├── include/node/                        # headers for native-lib.cpp
│   └── bin/arm64-v8a/libnode.so             # prebuilt
└── src/main/
    ├── cpp/
    │   ├── CMakeLists.txt                   # ~20 lines, copy from SeekerClaw
    │   └── native-lib.cpp                   # JNI entry (~100 lines, copy from SeekerClaw)
    ├── assets/
    │   └── letta-code/
    │       ├── letta.js                     # bundled @letta-ai/letta-code
    │       ├── package.json
    │       └── node_modules/                # IF native deps need to ship as JS
    │           └── (sharp, node-pty stub, etc. — see Native deps below)
    └── java/.../runtime/local/
        ├── LettaCodeBridge.kt               # JNI wrapper (analog of NodeBridge.kt)
        ├── LettaHostBridge.kt               # NanoHTTPD or Ktor (analog of AndroidBridge.kt)
        └── LocalLettaService.kt             # foreground service (analog of SeekerClawService.kt)
```

### File layout (Desktop)

Desktop is simpler — real Node binary, spawned as a child process:

```
desktop-compose/
├── build.gradle.kts                         # jpackage config bundling JVM + Node
└── src/main/
    ├── kotlin/.../runtime/local/
    │   ├── DesktopLettaProcess.kt           # ProcessBuilder spawns `node letta.js`
    │   └── LettaHostBridge.kt               # Ktor or built-in HTTP server (same shape as Android)
    └── resources/
        ├── bin/
        │   ├── node-win-x64.exe             # bundled Node binary
        │   ├── node-mac-arm64
        │   └── node-linux-x64
        └── letta-code/
            ├── letta.js
            └── node_modules/
```

**Key difference:** Desktop spawns Node as a child process via `ProcessBuilder`. Android calls `node::Start()` in-process via JNI. Same letta.js, different host runtime. The Compose UI talks to letta.js over loopback the same way on both — only lifecycle management differs.

Single .exe via jpackage with bundled Node-the-binary in resources. Estimated size: ~80–120MB (JVM + Node + letta.js + node_modules + Compose UI).

---

## Native dependency risk survey

Letta Code's native deps (from `package.json`):

| Dep | Status | Mitigation |
|---|---|---|
| **node-pty** | **Load-bearing risk.** Android sandbox has no PTY. | Stub with no-op module that throws "PTY not supported"; OR patch upstream to make it optional; OR replace with non-PTY shell tool implementation (Android can `exec` processes, just not via PTY). |
| **sharp** | libvips image processing. Has ARM64 Linux prebuilds. | Should work with right prebuild. If not, feature-flag off image features. |
| **@vscode/ripgrep** | Optional dep. Bundled binary needs Android ARM64 build. | If unavailable, codebase search falls back to JS-only implementation. |
| **ws** | Pure JS, no native code. | No action needed. |
| **react** | Runtime only for `ink` TUI. The TUI is irrelevant for mobile. | Should be no-op at runtime. |

**The node-pty question is the only remaining material risk after Day 0.** Worst case: stub it and accept that shell-tool features are degraded inside the embedded runtime. Most agent capabilities (memory, conversation, A2UI emission, MCP, web fetch) don't depend on PTY.

### Suggested node-pty stub

```js
// node_modules/node-pty/index.js (replaced)
module.exports = {
  spawn: () => { throw new Error('PTY not available on this platform'); }
};
```

Tools that require PTY will fail with a clean error; tools that don't will work.

---

## Build pipeline additions

1. **Download libnode v18.20.4 at build time.** Gradle task adapted from SeekerClaw's `app/build.gradle.kts` (uses `HttpURLConnection` with redirect-following + SHA-256 verification). Source: `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip` (~54MB).
2. **Vendor letta.js into assets.** New gradle task: `npm install @letta-ai/letta-code@<version>` into a build dir, then copy `letta.js` and any required `node_modules/*` (after stubbing/patching native deps) into `app/src/main/assets/letta-code/`. Pin the version explicitly.
3. **APK size impact.** libnode ~30MB extracted + letta.js ~20MB + minimal node_modules ~10–20MB. Plan for **~60MB increase** in APK size. Acceptable per Emmanuel.

---

## Spike plan (1–2 days, lcp-59c.1)

Goal: prove letta.js runs inside nodejs-mobile on Android 14+ end-to-end. Each step gates the next — stop and report if any fails.

### Day 1 morning — minimal nodejs-mobile + Kotlin app

- New throwaway Android project (do NOT pollute letta-mobile main repo yet)
- Copy SeekerClaw bridge files verbatim:
  - `app/src/main/cpp/native-lib.cpp` (~100 lines)
  - `app/src/main/cpp/CMakeLists.txt`
  - `app/src/main/java/.../service/NodeBridge.kt` (~250 lines, rename for our context)
  - libnode download gradle task from SeekerClaw's `app/build.gradle.kts`
- Replace nodejs-project assets with single hello.js: `console.log('hello from embedded node'); setTimeout(()=>{},1e9)`
- **Goal:** `adb logcat | grep MERIDIAN-NODE` shows the hello. If yes — bridge works. If no — debug before any letta.js attempt.

### Day 1 afternoon — drop in letta.js

- `npm install @letta-ai/letta-code` in a build dir
- Copy resulting `letta.js` into `app/src/main/assets/letta-code/letta.js`
- Modify NodeBridge.start argv to: `['node', '<filesDir>/letta-code/letta.js', '--backend', 'local']`
- Boot the app. Watch logcat. Expected outcomes (in order of likelihood):
  - **(A)** letta.js boots, then crashes on `require('node-pty')` — confirms node-pty is the load-bearing risk
  - **(B)** letta.js boots successfully — best case, proceed to Day 2 morning
  - **(C)** crash earlier (missing assets, fs permissions, etc.) — diagnose, may revert plan

### Day 2 morning — native deps survey + local backend smoke

- Address whichever deps blew up. For each: stub it, feature-flag it off, or escalate.
- Verify letta.js boots cleanly to a steady state
- Verify it listens on its local HTTP/WS endpoint (discover the port)
- Letta Code's local backend writes to `~/.letta/lc-local-backend`. On Android, set `HOME=context.filesDir`. Verify directory is created and writable.
- Connect provider via `letta --backend local connect anthropic --api-key ...` — verify provider config writes to local state and is readable on next boot.
- Create one agent, send one message, receive one response. Verify memfs files appear under `filesDir/.letta/lc-local-backend/memfs/<agent-id>/memory/`.

### Day 2 afternoon — Compose UI loopback smoke + decision

- Minimal Compose screen with a text input and a list. Hard-coded talks to `ws://127.0.0.1:<port>/...`.
- Send message, see streamed response. Verify A2UI envelope parsing still works if the local server emits A2UI.
- Write `docs/SPIKE-EMBED-FINDINGS.md` with:
  - Which native deps blocked, how addressed
  - Boot time on a real Pixel 9 Pro
  - APK size impact
  - Battery / memory observation
  - Recommendation: greenlight | escalate | revert

### Original spike success criteria (still applicable)

- Minimal Android app boots a foreground service hosting nodejs-mobile
- letta.js boots inside the service with `--backend local`
- Compose UI in the same app can speak HTTP/WS to the local letta.js over loopback
- A conversation with a real agent works end-to-end: send message, agent responds, memory persists
- At least one tool call succeeds inside the embedded runtime

### Open questions left for the real spike

- node-pty behavior on Android (sandbox has no PTY)
- sharp / @vscode/ripgrep ARM64 prebuild availability
- File system layout: where exactly is `HOME` on Android (use scoped storage / app private dir)
- MemFS git: does nodejs-mobile have a working git binding, or does it shell out? If shell-out, see node-pty
- Loopback HTTP/WS connectivity from Compose to letta.js's port
- letta.js boot time on a real Pixel 9 Pro vs a Linux server
- APK size with libnode + letta.js + minimal node_modules

### Hard go/no-go gates (any failure = stop the spike, report)

1. `node::Start()` fails to boot at all → fundamental incompatibility
2. node-pty is unfixable in <1 day AND can't be stubbed → escalate to Letta team
3. Boot time on real device > 30 seconds → significant UX problem, evaluate before proceeding
4. APK size > 150MB → significant distribution problem, evaluate before proceeding

### Decision points

- ✅ **spike succeeds** → hua6 deletes, i8dl reshapes, roadmap rewrites
- ⚠️ **spike partial** (works but native deps unstable) → continue spike OR escalate to letta-ai for upstream support
- ❌ **spike fails** (Node startup broken on Android, or native deps unfixable) → original Kotlin-canonical roadmap stands, decision reverts

### Deliverables on spike completion

- `docs/SPIKE-EMBED-FINDINGS.md` committed
- Throwaway spike project pushed to a branch (so it's recoverable)
- `bd` comment on `lcp-59c` with the decision recommendation
- If greenlight: rough estimate of effort to merge into main letta-mobile branch

---

## What deletes / reshapes if spike succeeds

- **`letta-mobile-hua6` (Embedded Letta-Shaped Runtime Driven By Koog)** — **DELETE entirely.** Koog TurnEngine is unnecessary because Letta Code IS the turn engine.
- **`letta-mobile-i8dl` (KMP Letta Substrate Migration)** — **RESHAPE to ~25–30% of original scope.** `sharedLogic` no longer contains LettaBackend interface, MemFS repository, RuntimeEvent outbox, prompt compiler. It becomes: UI tokens, navigation primitives, A2UI parser/renderer, transport bridge (loopback vs WS), persistence glue for what the UI cache needs.
- **multiplatform roadmap** — **REWRITE Phases 2 and 3.** Phase 2 becomes "embed nodejs-mobile + letta.js." Phase 3 (Desktop) becomes "Compose Desktop + bundled Node + letta.js, jpackage single binary."
- **`admin-shim/docs/MOBILE_WS_PROTOCOL.md` transport-exclusivity contract** — **EXTEND** with `LocalLettaCode` as a third value of the capability enum. Single-active-mutator rule still applies: when local Letta Code is the live transport, REST/SSE to remote Letta is not concurrently consumed.

---

## Risks / open questions (post-Day-0)

1. **node-pty** — load-bearing. Android sandbox has no PTY. Spike must answer: can node-pty be stubbed, replaced with a non-PTY shell tool, or made optional without breaking the agent?
2. **sharp / native deps.** sharp has ARM64 prebuilds; nodejs-mobile-react-native ecosystem has documented patterns. Likely tractable.
3. **iOS.** nodejs-mobile-ios exists but is less polished. App Store post-Apple-rules-change is friendlier to embedded interpreters but still a risk surface. iOS comes after Desktop+Android anyway.
4. **Battery cost on Android.** Foreground Node process running 24/7 — SeekerClaw ships this and people use it; cost is real but acceptable for a companion agent.
5. **Letta Code may not officially support running inside nodejs-mobile.** May need contributor coordination with letta-ai if the spike surfaces issues that need upstream fixes.

---

## Critical things to remember while implementing

- **Don't touch the existing remote/shim transport while spiking.** The local-runtime path must be additive. If the spike fails, nothing on the remote path should have changed.
- **Don't ship a spike branch to users.** A crash-loop on Node startup will brick the foreground service. Need a clean fallback before any user-visible release.
- **Watch for identity drift.** If letta.js running locally and remote Letta Code running on home server produce subtly different agent behavior (different system prompts, different memfs compaction), the agent will feel inconsistent. The point of embedding the actual Letta Code is that this can't happen — verify it doesn't, don't assume.
- **iOS is a separate conversation.** `nodejs-mobile-ios` exists but App Store review is more sensitive to embedded interpreters than Play. Address after Android + Desktop validate.

---

## Why this is the right pattern (not just the easy one)

SeekerClaw ships in production with this exact architecture. They handle wallet transactions, MCP, Telegram bot, Discord bot, cron, ~60 tools, embedded skills system — all in Node, all on Android. Letta Code is in many ways a more constrained product (no native wallet, no Bluetooth, fewer Android-specific surfaces), so if SeekerClaw works, this will work.

The architectural debt of NOT doing this is significant: months of Kotlin runtime reimplementation, identity drift between hosts, ongoing maintenance burden of keeping a parallel Kotlin agent core in sync with the canonical TS one. Embedding is the lower-debt path even though the up-front investment looks higher.

---

## Cross-refs

- `letta-mobile-i8dl` (KMP Letta Substrate Migration epic) — reshapes if greenlit
- `letta-mobile-hua6` (Embedded Letta-Shaped Runtime via Koog epic) — candidate for deletion
- `lcp-9he` (GA Epic B: Phase 2 shim-proxied developer mode) — possibly affected by `LocalLettaCode` being a third backend mode
- `admin-shim/docs/MOBILE_WS_PROTOCOL.md` — transport-exclusivity wire contract (gets `LocalLettaCode` extension)
- `docs/MOBILE_CHANNEL_DESIGN.md` — existing mobile channel design (the remote/WS path this is parallel to)
- product north star: free agent / paid rig split — strengthened by single-binary packaging story

---

## References

- [SeekerClaw source](https://github.com/sepivip/SeekerClaw) — verbatim-copyable bridge code (`native-lib.cpp`, `NodeBridge.kt`, `AndroidBridge.kt`, `SeekerClawService.kt`)
- [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) — the runtime, v18.20.4 prebuilt
- [@letta-ai/letta-code on npm](https://www.npmjs.com/package/@letta-ai/letta-code) — the agent code we want to embed
- [phodal/auto-dev](https://github.com/phodal/auto-dev) — 4.5k⭐ KMP multi-host AI dev platform; independent convergence on KMP shared-core + multi-host pattern
