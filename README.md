# opt2-tealbrick-bridge

Teal Brick opt2: bridge core, deployed bridge-server, tealbrick CLI, harness adapters.

**Status: opt2 build (clean-room v2 of Teal Brick), work in progress.** This repository is part of the opt2 build and lives under `Martin-Atrin` during the build; it moves to the Teal Brick organisation as one clean commit when opt2 is released. It is not the current production system.

Owner lane: Lead · Bridge & Harness.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables, Woodpecker secrets) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every push runs a secret scan (`.woodpecker/secret-scan.yaml`, gitleaks). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## Layout

npm workspaces, TypeScript run directly by Node 24+ (type stripping, `erasableSyntaxOnly`).

| Package | Role |
|---|---|
| `packages/bridge` | Bridge core. Two forms of one package: `deployed` (enforcement point, holds grants and the key store) and `relay` (local, holds only the agent identity, forwards to the deployed bridge). Never runs agents, never calls models. |
| `packages/bridge-server` | Deployed bridge entry (Docker, workspace private network). |
| `packages/cli` | `tealbrick` CLI: owner mode (drafts), agent mode (agent cards), local relay, harness connection instructions. |
| `packages/harness-claude` | Claude Agent SDK adapter. No policy. |
| `packages/harness-eve` | Eve adapter. No policy. |

Package scope `@opt2-tealbrick/*` is a placeholder until `specs/REPOS.md` fixes names. Later wave in this repo: `buzz` (with voice), `avm`.

Checks: `npm run check` (typecheck, `scripts/check-literals.ts`, unit tests).

## CI

Woodpecker CI (shared opt2 pipeline template from `opt2-tealbrick-platform`).

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.
