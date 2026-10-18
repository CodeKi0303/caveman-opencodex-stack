# Third-party components

This repository contains deployment glue and a gateway, not vendored forks of the upstream projects.
Its MIT license covers this repository's original code only; upstream licenses remain separate.

The table describes the checked-in baseline. `stack git-update` / `stack update --latest`
may select newer runtime products; exact versions and lockfiles are recorded under
`data/releases/`. Installed upstream package notices remain in the image. Baseline binary
notices below must not be assumed to describe a different binary release when redistributing
an image; preserve that release's own notices as well.

| Component | Pinned source | License information |
|---|---|---|
| OpenCodex | npm `@bitkyc08/opencodex@2.84.0`, https://github.com/lidge-jun/opencodex | MIT; notice preserved in `licenses/OpenCodex-MIT.txt` |
| Caveman CLI | npm `@caveman-ai/cli@4.0.1`, https://github.com/JuliusBrussee/caveman | Apache-2.0; license and NOTICE retained in installed package |
| Caveman companion binaries | CLI's signed binary release, `bin-v4.0.1` | Apache-2.0; exact release notices preserved in `licenses/Caveman-bin-v4.0.1/` |
| Codex CLI | npm `@openai/codex@0.162.1`, https://github.com/openai/codex | upstream Apache-2.0; preserve packaged notices |
| MCP TypeScript SDK | npm `@modelcontextprotocol/sdk@1.32.1` | MIT; license retained in installed package |
| TOML parser | npm `@iarna/toml@3.0.0` | ISC; license retained in installed package |
| Bun | npm `bun@1.4.3`, also selected for OpenCodex through a scoped override | MIT; preserve runtime third-party notices |
| Node.js | `node:24.21.0-bookworm-slim` | MIT with upstream third-party notices |
| Base OS and transitive dependencies | Containerfile + package-lock.json | each component retains its own license |

Caveman 3.0.0 and later license the CLI and engine-linked runtime under Apache-2.0.
Earlier releases retain the MIT/BSL-1.1 terms they shipped with. The `bin-v4.0.1`
release's Apache license, retained MIT notice, NOTICE, licensing guide, and native/font
third-party notices are preserved verbatim in `licenses/Caveman-bin-v4.0.1/`.
Its `THIRD_PARTY_GO_LICENSES.tar.gz` is preserved as extracted text in that directory's
`third-party-go/` tree. `Containerfile` includes these notices in the image.
Exact source: https://github.com/JuliusBrussee/caveman/releases/tag/bin-v4.0.1

Project-managed packages were checked against npm on 2026-10-14. TOML 3.0.0 remains
the highest published version; its `latest` tag still points to the older 2.2.5.
Other transitive packages follow the supported ranges and exact pins of their upstream
parents rather than forcing incompatible major versions.

This source distribution references upstream packages rather than copying their source into Git.
When distributing built images, preserve installed package licenses and the exact binary release
licenses/NOTICE files; review your organization's dependency and model-service usage rules.

Upstream model instructions/catalogs, generated images, credentials, CCR originals and account
metadata are runtime data, excluded from this repository. This project is not an official
OpenAI, Caveman or OpenCodex distribution and does not grant model-service access rights.
