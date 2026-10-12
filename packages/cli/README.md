# tealbrick CLI (`@opt2-tealbrick/cli`)

The `tealbrick` command for Teal Brick (opt2 build). Owner mode reads and drafts. Agent mode connects agents to the workspace bridge and runs them.

## Adopt an agent that already runs on this machine

```sh
tealbrick adopt --dry-run                          # detect + plan only: nothing is written, no network call
tealbrick adopt --from-v1 ~/agents/research --yes   # a v1 Teal Brick agent (Claude Agent SDK)
tealbrick adopt --harness codex --name "Codex helper" --yes
tealbrick adopt --undo --name "Codex helper"        # restore the backups, delete the local key
```

`adopt` detects the harness, the model sign-in (presence only, never a value), the persona and the v1 settings, prints one plan, asks the owner for ONE approval in Portal, then wires the harness (one `tealbrick` MCP entry, the existing config backed up first) and, for Claude Agent SDK agents, writes an `agent serve` config. Credential-like files are classified by name and never opened or copied. A re-run changes only what differs; `--undo` restores the backups (only when the file is unchanged since adopt), stops its own `agent serve` and deletes the local key. Known v1 tool names are rewritten to opt2 names only inside code spans (`` `create_document` ``) or after `mcp__<server>__`, never in prose; every rewrite and every name without an opt2 tool is listed for review. Memory is not imported. `--inbox buzz:<channel>` adds Buzz channels to the serve config (the default inbox is Connect's bot channels). If the harness config already has a Teal Brick entry, a real run stops unless `--keep-existing`. `--start` starts `agent serve --supervise` in the background (one loop per connection). A recipe field adopt cannot read is reported ("could not read recipe: …"), never a crash. Inside a v1 `.tealbrick/` folder adopt reads only `native-serve.json` and the agent's pid files.

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
- **`--supervise`**: restarts the loop after a crash or a stall, with backoff. One loop per connection (pidfile). `tealbrick agent status` shows whether serve runs and its last poll.

## Write operations and idempotency

Operations that change data can require an idempotency key (`_meta["tealbrick/idempotencyKey"]` on the MCP call). Model-driven clients cannot set `_meta`. So when a call has no key, the bridge derives one from the connection, the MCP session, the operation, the exact input and a 10-minute window. This applies to operations with idempotency `required` and `supported`. An identical retry in the same session within the window then gives the same result without a second write. A client that sends its own key keeps exact control.
