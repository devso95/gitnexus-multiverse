# GitNexus Retrieval Skill (Antigravity)

## Purpose

Standard retrieval workflow for fast, safe code reasoning with GitNexus MCP.

## Flow

1. Discover with `query` or `search`
2. Expand with `context` or `explore`
3. Confirm runtime path with `trace`
4. Assess blast radius with `impact` before edits
5. Confirm actual changed scope with `detect_changes` after edits

## Contract Work

Use:
- `route_map`
- `tool_map`
- `shape_check`
- `api_impact`

## Unsink + Wiki/RAG

1. `sinks` for unresolved sink inventory
2. `source` for local code evidence around each sink
3. `patterns` for repeated classes of unresolved sinks
4. Emit concise, grounded summaries that can be chunked into AI wiki/RAG documents
