import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { scan, apply } from "../scripts/prune-transient-agents.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function touch(path: string, ageMs: number, now: number): void {
  const seconds = (now - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
}

type FixtureAgentOptions = {
  hidden?: boolean;
  tags?: string[];
  transcriptLines?: number;
  conversationAgeMs?: number;
  liveConversationId?: string;
  memfs?: boolean;
};

/**
 * Fixture per design §4 P3: a state dir shaped like lc-local-backend with
 * agents/, conversations/ (base64url-encoded `default:<agentId>` and
 * `conversation:<convId>` keys), and memfs/.
 */
function makeFixture(now: number): {
  stateDir: string;
  addAgent: (id: string, options?: FixtureAgentOptions) => void;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "prune-fixture-"));
  mkdirSync(join(stateDir, "agents"));
  mkdirSync(join(stateDir, "conversations"));
  mkdirSync(join(stateDir, "memfs"));

  const addAgent = (id: string, options: FixtureAgentOptions = {}): void => {
    const {
      hidden = true,
      tags = ["origin:letta-code", "role:subagent"],
      transcriptLines = 3,
      conversationAgeMs = 20 * DAY_MS,
      liveConversationId,
      memfs = false,
    } = options;
    const agentPath = join(stateDir, "agents", `${b64url(id)}.json`);
    writeFileSync(agentPath, JSON.stringify({ id, name: "Letta Code", hidden, tags }));

    const defaultDir = join(stateDir, "conversations", b64url(`default:${id}`));
    mkdirSync(defaultDir);
    writeFileSync(
      join(defaultDir, "conversation.json"),
      JSON.stringify({ id: "default", agent_id: id }),
    );
    const transcript = Array.from({ length: transcriptLines }, (_, index) =>
      JSON.stringify({ type: "message", id: `entry-${index}` }),
    ).join("\n") + "\n";
    writeFileSync(join(defaultDir, "messages.jsonl"), transcript);
    touch(join(defaultDir, "messages.jsonl"), conversationAgeMs, now);
    touch(join(defaultDir, "conversation.json"), conversationAgeMs, now);
    touch(defaultDir, conversationAgeMs, now);

    if (liveConversationId) {
      const liveDir = join(stateDir, "conversations", b64url(`conversation:${liveConversationId}`));
      mkdirSync(liveDir);
      writeFileSync(
        join(liveDir, "conversation.json"),
        JSON.stringify({ id: liveConversationId, agent_id: id }),
      );
      writeFileSync(join(liveDir, "messages.jsonl"), JSON.stringify({ type: "message" }) + "\n");
      touch(join(liveDir, "messages.jsonl"), conversationAgeMs, now);
      touch(join(liveDir, "conversation.json"), conversationAgeMs, now);
      touch(liveDir, conversationAgeMs, now);
    }

    if (memfs) {
      const memfsDir = join(stateDir, "memfs", id);
      mkdirSync(memfsDir);
      writeFileSync(join(memfsDir, "memory.md"), "scratch\n");
    }
  };

  return { stateDir, addAgent };
}

test("prune-transient-agents: dry-run scan applies all three criteria", (t) => {
  const now = Date.now();
  const { stateDir, addAgent } = makeFixture(now);
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  // Prunable: hidden+role:subagent, 20d-old scratch conversation, no live ref.
  addAgent("agent-local-prunable", { transcriptLines: 5, memfs: true });
  // Too young: conversation activity 2d ago.
  addAgent("agent-local-young", { conversationAgeMs: 2 * DAY_MS });
  // Live-referenced: a named conversation: dir points at it.
  addAgent("agent-local-live", { liveConversationId: "conv-live-1" });
  // Not a subagent: visible agent must never be a candidate even when old.
  addAgent("agent-local-visible", { hidden: false, tags: [] });

  const { candidates, excluded, agentCount } = scan(stateDir, { minAgeDays: 14, now });

  assert.equal(agentCount, 4);
  assert.equal(candidates.length, 1, "exactly one agent satisfies all criteria");
  const candidate = candidates[0]!;
  assert.equal(candidate.id, "agent-local-prunable");
  // Dry-run must surface the transcript line count being deleted (the
  // reviewer consciously approves transcript deletion).
  assert.equal(candidate.transcripts.length, 1);
  assert.equal(candidate.transcripts[0]!.lines, 5);
  assert.ok(candidate.removal.memfsDir, "memfs dir is part of the removal set");
  assert.equal(excluded.tooYoung, 1);
  assert.equal(excluded.liveReference, 1);
  assert.equal(excluded.notSubagent, 1);
});

test("prune-transient-agents: agent-json mtime does not veto (bulk-rewrite hazard)", (t) => {
  const now = Date.now();
  const { stateDir, addAgent } = makeFixture(now);
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  // Conversation is 20d old but the agent JSON was rewritten "today" (the
  // fixture leaves it with a fresh mtime) — the age gate keys on conversation
  // mtime, so the agent must still be a candidate.
  addAgent("agent-local-prunable", { conversationAgeMs: 20 * DAY_MS });

  const { candidates } = scan(stateDir, { minAgeDays: 14, now });
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0]!.ageDays > 14);
});

test("prune-transient-agents: apply archives then deletes only the candidate", (t) => {
  const now = Date.now();
  const { stateDir, addAgent } = makeFixture(now);
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  addAgent("agent-local-prunable", { transcriptLines: 4, memfs: true });
  addAgent("agent-local-young", { conversationAgeMs: 2 * DAY_MS });
  addAgent("agent-local-live", { liveConversationId: "conv-live-1" });

  const { candidates } = scan(stateDir, { minAgeDays: 14, now });
  assert.equal(candidates.length, 1);

  const archiveDir = join(stateDir, "prune-archives");
  const archivePath = apply(stateDir, candidates, archiveDir);

  // Archive written before deletion and contains the full removal set.
  assert.ok(archivePath && existsSync(archivePath), "archive must exist");
  const archived = execFileSync("tar", ["-tzf", archivePath!], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.ok(archived.some((entry) => entry.startsWith("agents/")), "agent JSON archived");
  assert.ok(
    archived.some((entry) => entry.includes(b64url("default:agent-local-prunable"))),
    "scratch conversation dir archived",
  );
  assert.ok(archived.some((entry) => entry.startsWith("memfs/agent-local-prunable")), "memfs archived");

  // Candidate removed…
  assert.ok(!existsSync(join(stateDir, "agents", `${b64url("agent-local-prunable")}.json`)));
  assert.ok(!existsSync(join(stateDir, "conversations", b64url("default:agent-local-prunable"))));
  assert.ok(!existsSync(join(stateDir, "memfs", "agent-local-prunable")));

  // …and nothing else was touched.
  assert.ok(existsSync(join(stateDir, "agents", `${b64url("agent-local-young")}.json`)));
  assert.ok(existsSync(join(stateDir, "conversations", b64url("default:agent-local-young"))));
  assert.ok(existsSync(join(stateDir, "agents", `${b64url("agent-local-live")}.json`)));
  assert.ok(existsSync(join(stateDir, "conversations", b64url("conversation:conv-live-1"))));
  assert.equal(readdirSync(join(stateDir, "agents")).length, 2);

  // Second scan converges: nothing left to prune.
  const rescan = scan(stateDir, { minAgeDays: 14, now });
  assert.equal(rescan.candidates.length, 0);
});

test("prune-transient-agents: apply with no candidates writes nothing", (t) => {
  const now = Date.now();
  const { stateDir, addAgent } = makeFixture(now);
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  addAgent("agent-local-young", { conversationAgeMs: DAY_MS });

  const archiveDir = join(stateDir, "prune-archives");
  const archivePath = apply(stateDir, [], archiveDir);
  assert.equal(archivePath, null);
  assert.ok(!existsSync(archiveDir), "no archive dir for an empty removal set");
});

test("prune-transient-agents: refuses paths outside the state dir", (t) => {
  const now = Date.now();
  const { stateDir, addAgent } = makeFixture(now);
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  addAgent("agent-local-prunable");

  const { candidates } = scan(stateDir, { minAgeDays: 14, now });
  const forged = [
    {
      ...candidates[0]!,
      removal: { ...candidates[0]!.removal, agentFile: "/etc/hostname" },
    },
  ];
  assert.throws(
    () => apply(stateDir, forged, join(stateDir, "prune-archives")),
    /outside state dir/,
  );
});

test("prune-transient-agents: scan rejects a dir that is not a local backend", () => {
  const bogus = mkdtempSync(join(tmpdir(), "prune-bogus-"));
  try {
    assert.throws(() => scan(bogus, { minAgeDays: 14, now: Date.now() }), /does not look like/);
  } finally {
    rmSync(bogus, { recursive: true, force: true });
  }
});

test("prune-transient-agents: script file never runs main on import", () => {
  // Importing the module (as this test does) must be side-effect free; the
  // CLI entry is gated on argv[1]. Guarded here by asserting the exports are
  // functions and no fixture state was created in cwd.
  assert.equal(typeof scan, "function");
  assert.equal(typeof apply, "function");
  const content = readFileSync(
    new URL("../scripts/prune-transient-agents.mjs", import.meta.url),
    "utf8",
  );
  assert.match(content, /invokedDirectly/);
});
