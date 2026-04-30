/**
 * Trace MCP Tool Handler — unified flow tracing
 *
 * Actions: flow, upstream, downstream, impact
 */

export async function handleTrace(params: Record<string, unknown>): Promise<unknown> {
  const { action } = params;
  const { handleMultiverseTool } = await import('./tool-handlers.js');

  switch (action) {
    case 'flow':
      return handleMultiverseTool('trace-flow', params);
    case 'upstream':
      return handleMultiverseTool('who-calls-me', params);
    case 'downstream':
      return handleMultiverseTool('what-do-i-call', params);
    case 'impact':
      return handleMultiverseTool('impact', params);
    default:
      return { error: `Unknown action: ${action}. Use: flow, upstream, downstream, impact` };
  }
}
