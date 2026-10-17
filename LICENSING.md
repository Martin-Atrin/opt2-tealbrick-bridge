# Licensing

This repository ships under the Tealbrick Software Licence, version 1.1 (`LICENSE`, published at https://tealbrick.com/software-licence). The copyright owner is Polygonface s.r.o. (`NOTICE`).

## Versions released under MIT

Versions released before this change were distributed with an MIT declaration (`"license": "MIT"` in `package.json`) and stay available under the MIT licence. This is section 1.3 of the Tealbrick Software Licence. We do not relicense past releases.

The Tealbrick Software Licence applies from the next version of each package that is released after the pull request that added the `LICENSE` file was merged.

| Package or image | Last version before the change (release index, 2026-10-16) | Last git tag when this file was added (2026-10-17) |
|---|---|---|
| Bridge image (`packages/bridge-server`) | 0.1.30 stable, 0.1.31 dev | `bridge-v0.1.31`, `v0.1.31` |
| `@opt2-tealbrick/bridge` | 0.1.1 (listed as `bridge-package-legacy`) | `bridge-v0.1.31` (shares the image tag) |
| `@opt2-tealbrick/cli` (bridge copy) | 0.1.22 (listed as `cli-legacy`) | `cli-v0.1.22` |
| `@opt2-tealbrick/harness-claude` | 0.1.0 (listed as `harness-claude-legacy`) | `harness-claude-v0.1.15` |
| `@opt2-tealbrick/harness-eve` | not in the release index | `harness-eve-v0.1.10` |

Rule if a version is missing from the table: every version up to and including the last tag before the merge date of that pull request stays under MIT. A version tagged on or after the merge date carries this licence.

From bridge 0.2.0 the CLI and the two harnesses are no longer in this repository (their source is `Tealbrick/opt2-tealbrick-cli`); the rows above stay as history of what was released from here.

The release index is the signed `registry` release of `Tealbrick/opt2-tealbrick-dist` (`index.json`). It lists only the versions mirrored there. The git tags in this repository list every version that was built.
