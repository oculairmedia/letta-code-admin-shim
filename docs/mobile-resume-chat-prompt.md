# Implementation prompt: resume-on-open chat behavior for letta-mobile

Use this prompt to implement bead **`letta-mobile-h2b8`** ("Resume
most-recent conversation on chat-open, with explicit + New Chat
affordance").

Drop everything below the divider into the implementer's context. It
includes the problem statement, the fix, the file-by-file changes, the
acceptance criteria, and the test plan. It assumes the implementer has
read access to `/opt/stacks/letta-mobile/` and can run `./gradlew
:app:compileDebugKotlin` and `./gradlew :app:testDebugUnitTest` from
`android-compose/`.

---

# Task

Implement bead `letta-mobile-h2b8`: make the chat screen resume the most
recent conversation for the agent on open, with an explicit
"+ New Chat" affordance to start a fresh thread.

## Background — read this first

`letta-mobile` historically routed chat through Client Mode (the
`InternalBotClient` → LettaBot gateway path on `:8407`). The gateway
pinned a single persistent conversation per agent server-side, so the
per-VM `isFreshRoute` model in `TimelineSendCoordinator` was effectively
invisible to users — they always seemed to be in the same chat.

With Client Mode disabled and chat going through the standard Letta REST
API (`POST /v1/conversations/{id}/messages`), the per-VM-fresh-conv
behavior is now exposed: every chat-screen-open creates a new
conversation, breaking continuity.

The fix lives entirely on the client. The Letta server / shim does not
need to change. This keeps mobile working identically against the
vanilla Python Letta server and the new letta-code admin shim.

## What you're building

Behaviour to land:

1. **Default**: Opening an agent's chat resumes their most-recent
   conversation with that agent. The composer is empty; sending a
   message continues that thread.
2. **Explicit fresh start**: A "+ New Chat" affordance (toolbar / kebab)
   sets a transient `explicitNewChat` flag, navigates back into the
   chat screen, and the screen lands on an empty conv with no history.
   Sending creates a new conv.
3. **First-time interaction**: Opening an agent that has no prior conv
   → empty composer. Sending creates the first conv. (Unchanged from
   today.)
4. **Feature flag**: Wrap the resume logic in
   `feature.resume_recent_conversation`. Enable for internal builds /
   debug; default-off for release until soaked. Existing behavior is
   the fallback when disabled.

## Files you'll touch

Approximate locations — confirm exact paths in the current tree before
editing.

| File | Change |
|---|---|
| `app/src/main/java/com/letta/mobile/ui/screens/chat/AdminChatViewModel.kt` | Add `resolveInitialConversationId(agentId, explicitNewChat)`; call it from the init block where `isFreshRoute` currently fires `setActiveConversationId(null)`. |
| `app/src/main/java/com/letta/mobile/ui/screens/chat/ChatConversationCoordinator.kt` | If this is where `setActiveConversationId` lives — wire the resume logic to update through this coordinator rather than directly mutating state, so the existing observers fire properly. |
| `core/src/main/java/com/letta/mobile/data/repository/ConversationRepository.kt` | If `conversationsForAgent(agentId)` doesn't exist, add a method that returns conversations for an agent sorted by `lastMessageAt` desc, excluding archived. Should use the existing cache + `agentApi.listConversationsForAgent` (or whichever method already fetches `/v1/conversations?agent_id=X`). |
| `app/src/main/java/com/letta/mobile/ui/screens/chat/ChatScreen.kt` | Add the "+ New Chat" toolbar action / overflow item. On tap: set the explicit-new-chat flag (in the relevant viewmodel/coordinator), then navigate back into the chat route for the same agent (route arg already supports the agent id). |
| `app/src/main/java/com/letta/mobile/ui/screens/chat/AppNavGraph.kt` (or wherever chat routes are defined) | If needed: add a route arg `explicitNewChat: Boolean = false` so the flag survives navigation. Consume on read. |
| `core/src/main/java/com/letta/mobile/data/repository/SettingsRepository.kt` | Add `resumeRecentConversationEnabled: Flow<Boolean>` (or wire to existing feature-flag plumbing if there is one). |
| `app/src/main/java/com/letta/mobile/util/Telemetry.kt` (or equivalent) | Add event names: `chat.resume_attempted`, `chat.resume_succeeded`, `chat.resume_no_recent`, `chat.explicit_new_chat`. Fields: `agent_id`, `resumed_conv_id` (when succeeded), `last_message_age_sec`. |
| `app/src/test/java/com/letta/mobile/ui/screens/chat/AdminChatViewModelTest.kt` | Unit tests for `resolveInitialConversationId` covering: most-recent picked, empty list returns null, explicitNewChat returns null, archived filtered out. |

## Implementation details

### `resolveInitialConversationId`

```kotlin
internal suspend fun resolveInitialConversationId(
    agentId: AgentId,
    explicitNewChat: Boolean,
): String? {
    if (explicitNewChat) {
        telemetry.event("chat.explicit_new_chat", mapOf("agent_id" to agentId.value))
        return null
    }
    if (!settingsRepository.resumeRecentConversationEnabled.first()) {
        return null  // feature flag off → preserve today's behavior
    }
    telemetry.event("chat.resume_attempted", mapOf("agent_id" to agentId.value))

    val convs = runCatching {
        conversationRepository.conversationsForAgent(agentId)
    }.getOrNull() ?: return null  // network/cache miss → fall through

    val recent = convs
        .filterNot { it.archived }
        .maxByOrNull { it.lastMessageAt ?: it.createdAt }

    return if (recent != null) {
        val ageSec = (System.currentTimeMillis() - (recent.lastMessageAt?.toEpochMilli()
            ?: recent.createdAt.toEpochMilli())) / 1000
        telemetry.event(
            "chat.resume_succeeded",
            mapOf(
                "agent_id" to agentId.value,
                "resumed_conv_id" to recent.id,
                "last_message_age_sec" to ageSec,
            ),
        )
        recent.id
    } else {
        telemetry.event("chat.resume_no_recent", mapOf("agent_id" to agentId.value))
        null
    }
}
```

### Where to call it

Find the current `isFreshRoute` branch in `AdminChatViewModel.init`. It
looks roughly like:

```kotlin
if (isFreshRoute) {
    setClientModeConversationId(null)
    currentConversationTracker.setCurrent(null)
}
```

Replace with:

```kotlin
if (isFreshRoute) {
    setClientModeConversationId(null)
    currentConversationTracker.setCurrent(null)
    viewModelScope.launch {
        val resumed = resolveInitialConversationId(
            agentId = agentId,
            explicitNewChat = explicitNewChatFromRoute,
        )
        if (resumed != null) {
            chatConversationCoordinator.setActiveConversationId(resumed)
            startTimelineObserver(resumed)
        }
        // resumed == null → leave activeConversationId null, fall through
        // to the existing create-on-send path in TimelineSendCoordinator.
    }
}
```

`explicitNewChatFromRoute` is the route arg (default `false`).

### "+ New Chat" UI affordance

In `ChatScreen.kt`, add a toolbar action (icon button) and/or kebab item
labeled "New chat" (use the existing `LucideIcons.MessageSquarePlus` or
similar). On tap:

```kotlin
fun onNewChatTapped() {
    navController.navigate(
        route = "chat?agentId=${agentId.value}&explicitNewChat=true",
        navOptions = navOptions {
            popUpTo("chat?agentId=${agentId.value}") { inclusive = true }
        }
    )
}
```

Navigation should pop the current chat route off the stack and push a
new chat route for the same agent with `explicitNewChat=true`. This
triggers the resume-skip path in the viewmodel.

### Route arg plumbing

If the existing chat route doesn't already pass `explicitNewChat`, add
it. In the `NavGraph` definition:

```kotlin
composable(
    "chat?agentId={agentId}&explicitNewChat={explicitNewChat}",
    arguments = listOf(
        navArgument("agentId") { type = NavType.StringType },
        navArgument("explicitNewChat") {
            type = NavType.BoolType
            defaultValue = false
        },
    ),
) { backStackEntry ->
    val explicitNewChat = backStackEntry.arguments?.getBoolean("explicitNewChat") ?: false
    ChatScreen(agentId = ..., explicitNewChat = explicitNewChat)
}
```

The flag is consumed on read — the next navigation event without the
flag will resume normally.

### Feature flag

Use whatever feature-flag mechanism exists in
`SettingsRepository`. If there isn't one yet for runtime flags, a simple
boolean stored in the existing settings store is fine:

```kotlin
val resumeRecentConversationEnabled: Flow<Boolean> =
    dataStore.data.map { it[booleanPreferencesKey("resume_recent_conversation")] ?: true }
```

Default `true` in internal builds, expose a toggle in the existing
debug / dev settings screen.

## Acceptance criteria

1. Open agent A (one prior conv exists) → chat screen shows prior
   history, activeConversationId matches the most-recent conv id.
   Composer empty.
2. Tap "+ New Chat" → chat screen empty, no history. Send → POST to
   `/v1/conversations` creates a new conv id; that conv id is now
   active.
3. Open agent B (no prior conv) → empty composer. Send → POST
   `/v1/conversations` then POST `/{id}/messages`. Today's behavior
   preserved.
4. Pointing the build at `http://192.168.50.90:8289` (vanilla Python
   Letta server) vs `http://<shim-host>:8291` (the letta-code admin
   shim) produces identical resume behaviour. Verify with one chat
   session against each.
5. `resume_recent_conversation` flag disabled → behaviour identical to
   today (fresh conv per session).
6. Telemetry events fire as specified.

## Test plan

### Unit (`AdminChatViewModelTest.kt`)

- `resolveInitialConversationId` returns the most-recent non-archived
  conv when the repository returns three with varying `lastMessageAt`.
- Returns null when the repository returns an empty list.
- Returns null when `explicitNewChat` is true regardless of repository
  content.
- Returns null when the feature flag is false.
- Filters out conversations with `archived = true`.

### Instrumented

- Seed two convs for an agent in the local cache via the repository;
  open the chat screen → assert `activeConversationId` equals the
  most-recent.
- Tap "+ New Chat" → assert `activeConversationId` is null; send a
  message → assert `POST /v1/conversations` was issued.

### Manual

- Drive the app against the admin shim (`http://<host>:8291`) and
  verify the user-facing behaviours in the acceptance criteria.
- Repeat against vanilla Python Letta server. Behaviour should be
  identical.

## Out of scope (do not change)

- The TimelineSendCoordinator's `createConversation` path (used when
  `convId == null` at send time). It still runs when no resume target
  exists or "+ New Chat" was tapped.
- Cross-device "active conversation" sync. This issue is per-install.
- Scroll-position restoration on resume. The chat list scrolls to
  bottom on open today; that stays the same.
- Any changes to `ClientModeSendCoordinator`. Client Mode is a
  parallel transport that has its own conversation lifecycle; leave it
  alone.
- Any changes to the Letta REST API or the admin shim.

## Coordination

- File the PR with title `feat(chat): resume most-recent conversation
  on open (h2b8)`.
- Link to bead `letta-mobile-h2b8` in the PR description.
- Tag the chat / viewmodel reviewer per CODEOWNERS.
- Update bead status to `in_progress` when starting, `completed` when
  merged.
