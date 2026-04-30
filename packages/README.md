# Packages

This directory is the target layout for the multiverse extraction.

Current boundaries:

- `multiverse-core`: multiverse runtime entrypoint and future home for orchestration, APIs, MCP, and cross-repo graph logic.
- `multiverse-web`: React admin UI for multiverse.
- `gitnexus-adapter`: the only package that should talk directly to `gitnexus/` internals during the migration.

Extracted support slice:

- `multiverse-core/src/api`
- `multiverse-core/src/config`
- `multiverse-core/src/auth`
- `multiverse-core/src/util`
- `multiverse-core/src/engine/source-file-utils.ts`

First runtime-owned slice:

- `multiverse-core/src/server.ts`
- `multiverse-core/src/api/fs-api.ts`
- `multiverse-core/src/api/config-api.ts`

Current runtime direction:

- `multiverse-core` starts the server.
- Package-local server code uses package-local support modules first.
- Legacy multiverse routers are still imported from `gitnexus/src/multiverse/**` until each slice is extracted.

Migration rule:

- New multiverse code should land in `packages/multiverse-core` or `packages/multiverse-web`.
- Direct imports from `gitnexus/src/**` should be isolated behind `packages/gitnexus-adapter`.
