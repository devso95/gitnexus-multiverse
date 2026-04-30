---
mode: ask
description: GitNexus retrieval and impact-aware analysis workflow for Copilot Chat
---

Use GitNexus MCP tools with this strict flow:

1. Start with `query` (or `search` for multiverse scope).
2. Expand candidates with `context` (or `explore`).
3. Use `trace` when execution-flow certainty is needed.
4. Run `impact` before proposing code edits.
5. Run `detect_changes` after edits to verify scope.

For API/tool contracts:
- `route_map`
- `tool_map`
- `shape_check`
- `api_impact`

For unresolved sink resolution and wiki/RAG preparation:
- Collect sink set via `sinks`
- Attach origin context via `source`
- Group repeat motifs via `patterns`
- Keep output concise, evidence-based, and citation-friendly for doc chunking.
