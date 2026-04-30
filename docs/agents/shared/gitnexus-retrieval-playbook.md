# GitNexus Retrieval Playbook

Use this as the common retrieval contract across agents.

## Primary Goal

Retrieve enough high-confidence code intelligence to answer or change code safely, with minimal latency and minimal missed dependencies.

## Standard Sequence

1. `list_repos` (when repo context is ambiguous)
2. `query` (or multiverse `search`) to locate candidate areas
3. `context` (or multiverse `explore`) for symbol/process expansion
4. `trace` for runtime or cross-service flow validation
5. `impact` before code edits
6. `detect_changes` after edits to confirm expected blast radius

## API/Contract Sequence

1. `route_map` to find route-handler-consumer chain
2. `tool_map` for MCP/RPC contract visibility
3. `shape_check` to detect producer/consumer mismatch risk
4. `api_impact` before contract-level edits

## Unsink + RAG-Readiness Checks

- `sinks`: confirm unresolved sinks are clustered by root cause and include enough context for fast LLM resolution.
- `source`: include canonical origin snippets and nearby call context.
- `patterns`: capture repeated unresolved motifs for bulk fixes.
- `config`: verify retrieval knobs (depth/limits/filters) are tuned for low-noise, high-signal output.

## Output Expectations

- Report confidence and evidence trail (`tool -> symbol/process -> dependency path`).
- Flag ambiguity explicitly when two or more candidate flows conflict.
- Prefer shortest valid chain that preserves correctness.
