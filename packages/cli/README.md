# tealbrick CLI (`@opt2-tealbrick/cli`)

The `tealbrick` command for Teal Brick (opt2 build). Owner mode reads and drafts. Agent mode connects agents to the workspace bridge and runs them.

## Adopt an agent that already runs on this machine

```sh
tealbrick adopt --dry-run                          # detect + plan only: nothing is written, no network call
tealbrick adopt --from-v1 ~/agents/research --yes   # a v1 Teal Brick agent (Claude Agent SDK)
tealbrick adopt --harness codex --name "Codex helper" --yes
tealbrick adopt --undo --name "Codex helper"        # restore the backups, revoke the own connection, delete the local key
```

`adopt` detects the harness, the model sign-in (presence only, never a value), the persona and the v1 settings, prints one plan, asks the owner for ONE approval in Portal, then wires the harness (one `tealbrick` MCP entry, the existing config backed up first) and, for Claude Agent SDK agents, writes an `agent serve` config. Credential-like files are classified by name and never opened or copied. A re-run changes only what differs and writes nothing when nothing changed; `--undo` restores the backups (only when the file is unchanged since adopt), stops its own `agent serve` (supervisor included; a process that does not stop keeps its pidfile), revokes its own connection at the bridge (bridge 0.1.18 or later; Portal then lists it revoked) and deletes the local key. Only when that revoke fails does it name the connection id the owner must revoke in Portal. Known v1 tool names are rewritten to opt2 names only inside code spans (`` `create_document` ``) or after `mcp__<server>__`, never in prose; every rewrite and every name without an opt2 tool is listed for review. Memory is not imported. `--inbox buzz:<channel>` makes the agent listen on those Buzz channels. Without it, the serve config has an auto inbox (`{"auto": "connect"}`): `agent serve` listens on the Buzz channels the agent is a member of (the owner picks one at approval), else on its Buzz DMs, else on Connect's bot channel inbox when the agent has a chat bot. It re-checks at most every 5 minutes (and at once when an inbox is refused) and logs one `serve.inbox.auto` line when the choice changes. If the harness config already has one Teal Brick entry, adopt reuses it: the same entry name and, when the entry names it, the same card (otherwise pass `--agent <agt_…>`); with several entries it stops and lists them. A reused entry keeps its transport: a remote (URL/OAuth) entry stays remote unless you pass `--switch-to-stdio`, and the plan says which. The device request carries a suggestion for the owner: read access for the Teal Brick apps the persona refers to (tool names, v1 `mcp__…` names or the app name in prose, e.g. "Kanban") and the inbox channel. It never names write operations: Portal lists every deployed app and its operations on the approval page, and the owner ticks write access there. In a terminal, adopt asks which harness to use when it finds several. `--start` starts `agent serve --supervise` in the background (one loop per connection); the agent works in `<adopt dir>/work`, and serve turns write no Claude SDK session under `~/.claude/projects/`; each turn is logged to `<adopt dir>/transcripts/<date>.jsonl` instead (the model login is not touched). A re-run reports a running serve (supervisor pid, last poll). `--dry-run` also prints the persona rewrites and the lines to review. Top-level v1 recipe settings are defaults under the agent's own block; older `.tealbrick*` folders are listed once and never read. A recipe field adopt cannot read is reported ("could not read recipe: …"), never a crash. Inside a v1 `.tealbrick/` folder adopt reads only `native-serve.json` and the agent's pid files.

## Connect an agent

```sh
tealbrick agent login --create --name "Research agent" --purpose "Reads the inbox and drafts answers"
```

The command opens one device request. The owner approves it in Portal, where the card name is already filled in. Use `--agent <agt_…>` to connect an existing card, or `--file <agents.json>` for several cards at once (`tealbrick agents export` writes that file).

### Machines without a keychain

Set `TB_CREDENTIAL_STORE=file`. Agent items are then stored in `$XDG_CONFIG_HOME/tealbrick/` (default `~/.config/tealbrick/`), with file mode 0600. The person (owner) credential always needs the OS keychain.

Harnesses start the local relay with their own, filtered environment. So the CLI passes the store choice to the relay as arguments: `tealbrick bridge serve --stdio --agent <agt> --store file --config-dir <dir>`. `tealbrick connect` and `tealbrick agent serve` add these arguments for you.

## Run an agent on its own machine: `tealbrick agent serve`

```sh
tealbrick agent serve --file agent-serve.json
```

The command watches the agent's inboxes and scheduled routines through the bridge. For each new item it starts one turn in the agent's own harness. The agent replies through the same Teal Brick tools, so grants and holds apply. The bridge never runs the agent and never calls a model. Example configs are in `assets/` (`agent-serve.example.json`, `agent-serve.routines.example.json`, `agent-serve.eve.example.json`).

- **`inboxes[].wake`**: `"mentions"` (default) starts a turn only for channel messages that mention the agent (Connect `mentionsMe`). `"all"` starts a turn for every message. Direct messages always start a turn. Items that do not start a turn are marked as seen. If the inbox items have no `mentionsMe` field (Connect before 0.4.0), the inbox uses `"all"` and logs one warning.
- **`routines[]`**: scheduled work (for example Evolution routines). Each claimed job gets exactly one turn. A job is never claimed or run twice, also after a restart.
- **Concurrency**: one turn at a time for each agent.
- **Claude harness fields**: `appendSystemPromptFile` (persona file, relative to the config), `builtinTools` (default none), `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `turnTimeoutSeconds`.
- **Where a serve turn writes** (claude harness): `cwd` (relative to the config; adopt uses `"work"`). `transcripts` (relative folder, e.g. `"transcripts"`): one JSONL line per turn event in `<folder>/<date>.jsonl` (folder 0700, files 0600). Without it no transcript is kept anywhere. `persistSession` (default false): the Claude SDK writes no session under `~/.claude/projects/`. `memory` (relative folder): turns Claude auto-memory on and keeps it there; default off. Example: `"harness": {"kind": "claude", "cwd": "work", "transcripts": "transcripts", "appendSystemPromptFile": "persona/persona.md"}`.
- **`--supervise`**: restarts the loop after a crash or a stall, with backoff. One loop per connection (pidfile). `tealbrick agent status` shows whether serve runs and its last poll. Stop: SIGTERM (or `adopt --undo`) ends the supervisor and its loop within 5 s, also during a turn (the loop gets SIGTERM, then SIGKILL after 3.5 s); stop scripts can escalate after 10 s.

## Write operations and idempotency

Operations that change data can require an idempotency key (`_meta["tealbrick/idempotencyKey"]` on the MCP call). Model-driven clients cannot set `_meta`. So when a call has no key, the bridge derives one from the connection, the MCP session, the operation, the exact input and a 10-minute window. This applies to operations with idempotency `required` and `supported`. An identical retry in the same session within the window then gives the same result without a second write. A client that sends its own key keeps exact control.
