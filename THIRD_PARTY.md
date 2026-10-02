# Third-party components

This repository contains deployment glue and a gateway, not vendored forks of the upstream projects.
Its MIT license covers this repository's original code only; upstream licenses remain separate.

| Component | Pinned source | License information |
|---|---|---|
| OpenCodex | npm `@bitkyc08/opencodex@2.75.0`, https://github.com/lidge-jun/opencodex | MIT; notice preserved in `licenses/OpenCodex-MIT.txt` |
| Caveman CLI | npm `@caveman-ai/cli@1.3.4`, https://github.com/JuliusBrussee/caveman | package metadata declares MIT |
| Caveman companion binaries | CLI's signed binary release, `bin-v1.1.7` | BSL-1.1 with Additional Use Grant; see `licenses/Caveman-proxy-LICENSE` and `licenses/Caveman-LICENSING.md` |
| Codex CLI | npm `@openai/codex@0.160.0`, https://github.com/openai/codex | upstream Apache-2.0; preserve packaged notices |
| MCP TypeScript SDK | npm `@modelcontextprotocol/sdk@1.30.0` | MIT; license retained in installed package |
| TOML parser | npm `@iarna/toml@3.0.0` | ISC; license retained in installed package |
| Node/Bun/base OS and transitive dependencies | Containerfile + package-lock.json | each component retains its own license |

The pinned Caveman binary release is **not entirely open source**: its CLI/adoption surfaces
are MIT, but engine-linked proxy/MCP/binaries are BSL-1.1. The release's Additional Use Grant
permits self-hosted production use for your own first-party traffic, including internal use.
Offering that functionality to third parties as a hosted, managed, or embedded service requires
a commercial license from the licensor. The listed Change Date is 2030-06-21, with Apache-2.0
as Change License. Do not infer this release's terms from a newer `main` branch LICENSE.
Exact source: https://github.com/JuliusBrussee/caveman/blob/bin-v1.1.7/LICENSING.md

This source distribution references upstream packages rather than copying their source into Git.
When distributing built images, preserve installed package licenses and the exact binary release
licenses/NOTICE files; review your organization's dependency and model-service usage rules.

Upstream model instructions/catalogs, generated images, credentials, CCR originals and account
metadata are runtime data, excluded from this repository. This project is not an official
OpenAI, Caveman or OpenCodex distribution and does not grant model-service access rights.
