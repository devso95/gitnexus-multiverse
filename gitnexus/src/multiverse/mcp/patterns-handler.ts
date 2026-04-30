/**
 * Patterns MCP Tool Handler — unified pattern & rule management
 *
 * Actions: list, create, update, enable, disable
 * type: "sink" (default) | "rule"
 */

export async function handlePatterns(params: Record<string, unknown>): Promise<unknown> {
  const patternType = params.type || 'sink';
  const { handleMultiverseTool } = await import('./tool-handlers.js');

  if (patternType === 'rule') {
    return handleMultiverseTool('manage-rule', params);
  }
  return handleMultiverseTool('manage-pattern', params);
}
