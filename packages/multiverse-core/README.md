# Multiverse Core

This package is the extraction target for the multiverse runtime.

Current state:

- `src/cli.ts` provides a package-local entrypoint.
- `src/server.ts` is now the package-local server entrypoint.
- The server uses package-local config/auth/logging and package-local `fs-api` and `config-api`.
- Heavier routers still come from legacy modules through controlled dynamic imports.
- `src/api`, `src/config`, `src/auth`, `src/util`, and `src/engine/source-file-utils.ts` now contain copied extraction targets for low-coupling support code.

Next steps:

- Move runtime slices that consume these support modules into this package.
- Keep GitNexus-facing calls behind `packages/gitnexus-adapter`.
- Replace remaining legacy router imports with local implementations slice by slice.
