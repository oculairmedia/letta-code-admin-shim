export const AGENT_ID_ALIASES: Record<string, string> = {
  // pre-rev6 migrator generated these from a name-hash; rev6 onward used
  // original Letta-server UUIDs. The local backend used by this dev shim now
  // exposes the default Letta Code id, so keep both legacy ids routable.
  "agent-migrated-77d0a4b78ede9f8d9e1b279b": "agent-597b5756-2915-4560-ba6b-91005f085166",
  "agent-migrated-eeb0dbb6d6117617453ba793": "agent-2fae4a23-1caa-460d-9033-9f30ac84ed5e",
  "agent-597b5756-2915-4560-ba6b-91005f085166": "agent-local-ffa3a92b-f5d6-45e1-8866-f3c965a92133",
};

export function resolveAgentIdAlias(agentId: string, exists: (id: string) => boolean): string {
  if (exists(agentId)) return agentId;

  const seen = new Set<string>([agentId]);
  let current = agentId;
  while (true) {
    const next = AGENT_ID_ALIASES[current];
    if (!next || seen.has(next)) return agentId;
    if (exists(next)) return next;
    seen.add(next);
    current = next;
  }
}
