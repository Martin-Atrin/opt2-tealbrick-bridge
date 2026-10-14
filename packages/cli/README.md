# tealbrick CLI (`@opt2-tealbrick/cli`)

The `tealbrick` command for Teal Brick (opt2 build). Owner mode reads and drafts. Agent mode connects agents to the workspace bridge and runs them.

## Adopt an agent that already runs on this machine

```sh
tealbrick adopt --dry-run                          # detect + plan only: nothing is written, no network call
tealbrick adopt --harness claude-sdk --name "Research agent" --persona ~/agents/research/persona.md --yes   # a Claude Agent SDK agent
tealbrick adopt --harness codex --name "Codex helper" --yes
tealbrick adopt --undo --name "Codex helper"        # restore the backups, revoke the own connection, delete the local key
```

`adopt` detects the harness, the model sign-in (presence only, never a value), the persona (CLAUDE.md or AGENTS.md in the current folder, or `--persona <file>`), prints one plan, asks the owner for ONE approval in Portal, then wires the harness (one `tealbrick` MCP entry, the existing config backed up first) and, for Claude Agent SDK agents, writes an `agent serve` config. Adopt never reads or copies credentials; it reports the model sign-in by presence only. A re-run changes only what differs and writes nothing when nothing changed; `--undo` restores the backups (only when the file is unchanged since adopt), stops its own `agent serve` (supervisor included; a process that does not stop keeps its pidfile), revokes its own connection at the bridge (bridge 0.1.18 or later; Portal then lists it revoked) and deletes the local key. Only when that revoke fails does it name the connection id the owner must revoke in Portal. The persona is copied as written; lines with tool references or outward verbs (send, post, publish) are listed for review. `--persona <file>` replaces the detected instructions (the plan lists the replaced files); add `--persona-append` to keep them and add yours. Memory is not imported. `--inbox buzz:<channel>` makes the agent listen on those Buzz channels. Without it, the serve config has an auto inbox (`{"auto": "connect"}`): `agent serve` listens on the Buzz channels the agent is a member of (the owner picks one at approval), else on its Buzz DMs, else on Connect's bot channel inbox when the agent has a chat bot. It re-checks at most every 5 minutes (and at once when an inbox is refused) and logs one `serve.inbox.auto` line when the choice changes. A short-lived refusal while choosing (for example `hook_failed` while an app restarts) is retried after 5 s and never settles on "no inbox"; a channel found later is read from the serve start, so a mention posted in the meantime still gets a reply. If the harness config already has one Teal Brick entry, adopt reuses it: the same entry name and, when the entry names it, the same card (otherwise pass `--agent <agt_…>`); with several entries it stops and lists them. A reused entry keeps its transport: a remote (URL/OAuth) entry stays remote unless you pass `--switch-to-stdio`, and the plan says which. The device request carries a suggestion for the owner: read access for the Teal Brick apps the persona refers to (tool names such as `knowledge__recall` or `mcp__tealbrick__knowledge__recall`, or the app name in prose, e.g. "Kanban") and the inbox channel. It never names write operations: Portal lists every deployed app and its operations on the approval page, and the owner ticks write access there. In a terminal, adopt asks which harness to use when it finds several. `--start` starts `agent serve --supervise` in the background (one loop per connection); the agent works in `<adopt dir>/work`, and serve turns write no Claude SDK session under `~/.claude/projects/`; each turn is logged to `<adopt dir>/transcripts/<date>.jsonl` instead (the model login is not touched). A re-run reports a running serve (supervisor pid, last poll). `--dry-run` also prints the persona lines to review. There is no import from Teal Brick v1 (opt2 is version 0): build such an agent new with `agent login --create` or adopt it with its persona file.

## Plug in a Claude Code agent

A Claude Code project folder (its `CLAUDE.md`, `.claude/`) can be a Teal Brick agent without hand-written files:

```sh
npm install <cli tarball>                          # folder-local install; `tealbrick` need not be on PATH
npx tealbrick agent login --create --name "Goobo" --grant knowledge,kanban --channel buzz:<channel id>
cd ~/agents/goobo/work && npx tealbrick connect claude-code --write      # writes ./.mcp.json (project scope)
cp <install>/node_modules/@opt2-tealbrick/cli/assets/agent-serve.claude-code.example.json ./serve.json
npx tealbrick agent serve --file serve.json --detach                     # woken by mentions and DMs
```

Or in one step: `tealbrick adopt --harness claude-code --name "Goobo" --project ~/agents/goobo/work --serve --start`.

- **Relay command**: `connect` and `adopt` write this install's absolute node and `main.js` paths, plus the store arguments (`--store file --config-dir <dir>` with `TB_CREDENTIAL_STORE=file`). The relay needs no other env. Re-run `connect` after you move the install or node.
- **Scope**: the default is the project scope, `<folder>/.mcp.json` (`--project <dir>`, default the current folder). Only Claude Code sessions in that folder get the agent's tools and key. `--scope user` (every session on the machine) is printed as a `claude mcp add --scope user …` command only; tealbrick never edits `~/.claude.json`. The adopt plan says which scope it uses.
- **Serve harness `claude-code`**: `{"kind": "claude-code", "cwd": ".", "maxTurns": 20, "allowedTools": [], "model": "sonnet", "turnTimeoutSeconds": 600, "passthroughEnv": []}`; only `cwd` (relative to the config file) is required. Each wake runs `claude -p --output-format json` in `cwd` with the prompt on stdin, a temporary MCP config (mode 0600, removed after the turn) whose only server is this turn's relay (with the sender claim, so it can only narrow access), `--strict-mcp-config`, `--allowedTools mcp__tealbrick` and `--disallowedTools Bash WebFetch WebSearch Write Edit`. `allowedTools` can only add tools (for example `["Read"]`); the disallowed tools cannot be added. The env is the command harness allow-list (`HOME`, `USER`, `PATH`, … plus `passthroughEnv`). A turn past `turnTimeoutSeconds` (default 600) gets SIGTERM, then SIGKILL after 10 s (its own child only). The serve log gets one `serve.turn.result` line per turn: `ok`, `exitCode`, `numTurns`, `durationMs`, `costUsd`, `permissionDenials` (count), `isError`, the tokens (`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`) and `model`, never the prompt or the reply.
- **Usage and tool search (both Claude harnesses)**: the `claude` harness writes the same token, cost, turn and model fields to its `serve.turn.result` log line and to the transcript `result` line. Both harnesses leave Claude Code's MCP tool search on (tool schemas are deferred): the turn env is allow-listed, so a host `ENABLE_TOOL_SEARCH` or `ANTHROPIC_BASE_URL` never reaches the turn.

## Connect an agent

```sh
tealbrick agent login --create --name "Research agent" --purpose "Reads the inbox and drafts answers"
```

The command opens one device request. The owner approves it in Portal, where the card name is already filled in. Use `--agent <agt_…>` to connect an existing card, or `--file <agents.json>` for several cards at once (`tealbrick agents export` writes that file). `--harness <id>` names the Portal harness option of the card: one of the spec ids `tbd-default`, `claude-desktop`, `codex-desktop`, `claude-code`, `eve`, `tealbrick-cli` (default), `generic-mcp`. Any other value is refused before the device request. `claude-sdk` and `command` are runner kinds of a `tealbrick-cli` agent, not harness ids; `adopt` maps its runner kind to the harness id itself (`claude-sdk`/`command` → `tealbrick-cli`, `codex` → `codex-desktop`, `claude-desktop`, `claude-code`).

With `--create`, the approval page is the same one form as `adopt`. It lists every deployed app with its operations, and a channel field. Nothing is ticked unless you name it. `--grant knowledge,kanban:read+create` pre-ticks the read operations of those apps (write operations stay unticked; the owner ticks them). `--channel buzz:<channel id>` (or `new:<name>`) fills the channel field. After the approval the CLI checks whether the agent is a member of that Buzz channel. If it is not, it prints the agent's npub and the one owner step: add that npub to the channel in Buzz.

### Machines without a keychain

Set `TB_CREDENTIAL_STORE=file`. Agent items are then stored in `$XDG_CONFIG_HOME/tealbrick/` (default `~/.config/tealbrick/`), with file mode 0600. The person (owner) credential always needs the OS keychain.

Harnesses start the local relay with their own, filtered environment. So the CLI passes the store choice to the relay as arguments: `tealbrick bridge serve --stdio --agent <agt> --store file --config-dir <dir>`. `tealbrick connect` and `tealbrick agent serve` add these arguments for you. When the bridge restarts (update, redeploy), it refuses new tool calls with `temporarily_unavailable` and Retry-After while it finishes the running ones (bridge 0.1.23 or later); the relay sends such a call again until the new bridge answers (at most 90 s), so the call runs once and the agent sees no error. A call that was cut off while running is reported as `app_unavailable` and is never sent again.

## Call one tool as the agent: `tealbrick tool`

```sh
tealbrick tool list [--agent <agt_…>] [--json]
tealbrick tool call connect__buzz_identity            # for example, read the agent's Buzz npub
tealbrick tool call <name> --input '{"key":"value"}'  # or --input @file.json
```

`tool list` shows each tool of the agent, whether it is read-only, and its title. `tool call` runs one tool as the agent. It uses the agent item only, never the owner session. It runs read-only tools at once. A tool that is not marked read-only can change data, so the command refuses it until you pass `--yes`. An unknown tool name exits 6 (`unknown_tool`). The command prints the tool's structured result, or its text. With `--json` it prints one value: `{tool, isError, result}`. If the tool returns an error, the command exits 5 and shows the error code and message.

## Run an agent on its own machine: `tealbrick agent serve`

```sh
tealbrick agent serve --file agent-serve.json
tealbrick agent serve --file agent-serve.json --detach   # in the background, supervised; log in serve.log next to the file
tealbrick agent stop                                     # stops it (own pidfile only)
```

The Claude Agent SDK comes with the CLI install (exact version pin), so the first turn works without a manual install.

The command watches the agent's inboxes and scheduled routines through the bridge. For each new item it starts one turn in the agent's own harness. The agent replies through the same Teal Brick tools, so grants and holds apply. The bridge never runs the agent and never calls a model. Example configs are in `assets/` (`agent-serve.example.json`, `agent-serve.claude-code.example.json`, `agent-serve.routines.example.json`, `agent-serve.eve.example.json`). Harness kinds: `claude` (Claude Agent SDK), `claude-code` (a Claude Code project folder, see above), `command` (any CLI).

- **`inboxes[].wake`**: `"mentions"` (default) starts a turn only for channel messages that mention the agent (Connect `mentionsMe`). `"all"` starts a turn for every message. Direct messages always start a turn. Items that do not start a turn are marked as seen. If the inbox items have no `mentionsMe` field (Connect before 0.4.0), the inbox uses `"all"` and logs one warning.
- **`routines[]`**: scheduled work (for example Evolution routines). Each claimed job gets exactly one turn. A job is never claimed or run twice, also after a restart.
- **Concurrency**: one turn at a time for each agent.
- **Command harness** (`{"kind": "command", "command": ["my-harness", "--mcp", "{mcpCommand}"], "cwd": ".", "passthroughEnv": [], "turnTimeoutSeconds": 600}`): the prompt goes to the command's stdin; only the exit code counts. A turn past `turnTimeoutSeconds` (default 600, as for `claude-code`) gets SIGTERM, then SIGKILL after 10 s (its own child only), and ends as "turn timed out"; serve then goes on with the next item. The serve log gets one `serve.turn.result` line per turn (`ok`, `exitCode`, `signal`, `timedOut`, `sent` = the signals serve sent, `wallMs`).
- **Claude harness fields**: `appendSystemPromptFile` (persona file, relative to the config), `builtinTools` (default none), `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `turnTimeoutSeconds`.
- **Where a serve turn writes** (claude harness): `cwd` (relative to the config; adopt uses `"work"`). `transcripts` (relative folder, e.g. `"transcripts"`): one JSONL line per turn event in `<folder>/<date>.jsonl` (folder 0700, files 0600). Without it no transcript is kept anywhere. `persistSession` (default false): the Claude SDK writes no session under `~/.claude/projects/`. `memory` (relative folder): turns Claude auto-memory on and keeps it there; default off. Example: `"harness": {"kind": "claude", "cwd": "work", "transcripts": "transcripts", "appendSystemPromptFile": "persona/persona.md"}`.
- **`--detach`** starts `agent serve --supervise` in the background and returns. The log goes to `--log <file>` (default `serve.log` next to the config file, mode 0600). A second `--detach` for the same connection is refused while the first runs. `tealbrick agent stop` stops it through the connection's own pidfile and reports "stopped" only when the process is gone.
- **`--log <file>`**: the serve log lines are appended to this file. The relay of each harness turn appends its `relay.retry` lines there too (tool name, code, Retry-After, attempt; never the arguments), so a bridge restart is visible in one place.
- **`--supervise`**: restarts the loop after a crash or a stall, with backoff. One loop per connection (pidfile). `tealbrick agent status` shows whether serve runs and its last poll. Stop: SIGTERM (or `adopt --undo`) ends the supervisor and its loop within 5 s, also during a turn (the loop gets SIGTERM, then SIGKILL after 3.5 s); stop scripts can escalate after 10 s.

## Write operations and idempotency

Operations that change data can require an idempotency key (`_meta["tealbrick/idempotencyKey"]` on the MCP call). Model-driven clients cannot set `_meta`. So when a call has no key, the bridge derives one from the connection, the MCP session, the operation, the exact input and a 10-minute window. This applies to operations with idempotency `required` and `supported`. An identical retry in the same session within the window then gives the same result without a second write. A client that sends its own key keeps exact control.
