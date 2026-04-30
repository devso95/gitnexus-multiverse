# Agent Skill Packs

This directory provides ready-to-use skill packs for multiple agents so teams can run the same GitNexus retrieval workflow everywhere.

## Included Agents

- Claude: `.claude/skills/gitnexus/gitnexus-retrieval/SKILL.md`
- Codex: `.codex/skills/gitnexus-retrieval/SKILL.md`
- Copilot: `.github/prompts/gitnexus-retrieval.prompt.md`
- Antigravity: `antigravity/skills/gitnexus-retrieval.md`

## Shared Workflow

All packs align to one retrieval flow:

1. Discover with `query` or `search`
2. Expand with `context` or `explore`
3. Trace with `trace` (multiverse) when flow-level reasoning is required
4. Validate risk with `impact` before edits
5. Verify scope with `detect_changes` after edits

For API or tool-contract work, use `route_map`, `tool_map`, `shape_check`, and `api_impact`.

## Notes

- If index is stale, run `npx gitnexus analyze` before deep retrieval.
- Keep results grounded in tool output; avoid assumptions without graph evidence.
