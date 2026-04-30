---
name: gitnexus-retrieval
description: Use when the task needs reliable code retrieval with impact-aware reasoning across monorepo or multiverse flows.
---

# GitNexus Retrieval (Codex)

Follow this sequence:

1. Discover: `query` or `search`
2. Expand: `context` or `explore`
3. Validate flow: `trace`
4. Check risk before edits: `impact`
5. Verify edited scope: `detect_changes`

Use `route_map`, `tool_map`, `shape_check`, `api_impact` for API/tool contract analysis.

When unresolved sinks are involved, prioritize `sinks -> source -> patterns` to gather enough evidence for fastest LLM resolution.
