# Channels ops runbook

The admin-shim hosts channel plugins from `~/.letta/channels/<id>/` (generic
registry, `SHIM_CHANNELS_ENABLED=1` in the lettashim unit drop-in
`/etc/systemd/system/lettashim.service.d/channels.conf`). Matrix is the first
managed channel; mobile is listed but registry-exempt.

## Daily driving

```bash
curl -s localhost:8291/v1/channels | jq                    # types + adapter states
curl -s localhost:8291/v1/channels/matrix/status | jq      # lastSyncAt/lastInboundAt/lastError
curl -s -X POST localhost:8291/v1/channels/matrix/adapters/lettabot/restart
```

Send as the bot (agent-initiated):

```bash
curl -s -X POST localhost:8291/v1/channels/matrix/accounts/lettabot/messages \
  -H "Content-Type: application/json" \
  -d '{"chatId":"!room:server","text":"hi","markdown":true}'
```

## Config

- Accounts: `POST/PATCH /v1/channels/<ch>/accounts[/<id>]` — secrets are
  write-only (`{"__secret_set":true}` in responses); on-disk file is
  `~/.letta/channels/<ch>/accounts.json`, shared with the `letta channels` CLI.
- Routes (room → agent+conversation): `/v1/channels/<ch>/routes` CRUD, persisted
  to `routing.yaml` (JSON body, CLI-compatible). Route edits are live — no
  restart (per-message mtime cache).
- Never run `letta server --channels matrix` while the shim registry hosts
  matrix: two /sync consumers double-deliver.

## Token rotation

PATCH the account with `{"config":{"accessToken":"<new>"}}`, then restart the
adapter. Verify with `whoami`:
`curl -s $HS/_matrix/client/v3/account/whoami -H "Authorization: Bearer <new>"`.

## Deploy / restart

```bash
cd /opt/stacks/letta-code-parallel/admin-shim && npm run build   # unit runs dist/
systemctl stop lettashim-watchdog.timer
systemctl restart lettashim
# verify /v1/channels shows matrix running, then:
systemctl start lettashim-watchdog.timer
```

If the matrix `state/<account>.json` sync token is older than ~a day, delete it
before starting so the plugin does a fresh bootstrap (drops backlog) instead of
replaying stale room events as agent turns.

## Escape hatches

- `SHIM_CHANNELS_ENABLED=0` in the drop-in + restart: registry fully off
  (mobile unaffected).
- `POST /v1/channels/matrix/adapters/lettabot/stop`: targeted halt (manual stop
  disables auto-restart until `start`).

## Scheduled work

Heartbeat (`meridian-heartbeat`, */30) and morning check-in
(`meridian-morning-checkin`, 9:30 Toronto) are `/v1/crons` tasks bound to
Meridian; they post to Matrix via the send endpoint above. Crons fire only
while the shim is up.

## History

2026-07-03: replaced the lettabot + tuwunel matrix-client WS bridge
(`matrix-tuwunel-deploy-matrix-client-1`, stopped) with this stack. Beads:
letta-mobile-{9o50g,6ahjp,10fp8,zygyj,h3t31,ay8wv}.
