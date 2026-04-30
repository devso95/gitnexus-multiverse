/**
 * Chat API — server-side LLM agent with multiverse tools
 *
 * POST /api/mv/chat — send message, get streamed response
 * DELETE /api/mv/chat — clear conversation history
 *
 * Uses the same LLM config as wiki generation (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN).
 * Agent has access to all multiverse MCP tools (service-map, trace-flow, etc.).
 */

import { Router } from 'express';
import { resolveWikiLLMConfig } from '../wiki/llm-wiki-client.js';
import { loadConfig } from '../config/loader.js';
import { MULTIVERSE_TOOLS } from '../mcp/tools.js';
import { handleMultiverseTool } from '../mcp/tool-handlers.js';
import { mvLog } from '../util/logger.js';
import type { LLMConfig } from '../../core/wiki/llm-client.js';

const LOG = 'chat-api';

// ── Types ──

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ── Conversation store (in-memory, per-session) ──

const conversations = new Map<string, ChatMessage[]>();
const MAX_HISTORY = 30;

function getOrCreateConversation(sessionId: string): ChatMessage[] {
  if (!conversations.has(sessionId)) conversations.set(sessionId, []);
  return conversations.get(sessionId)!;
}

// ── System prompt ──

const SYSTEM_PROMPT = `You are Nexus, an AI assistant for microservice architecture analysis.
You have access to tools that query a Neo4j graph database containing parsed source code,
cross-service dependencies, API endpoints, Kafka topics, and config values.

## CRITICAL RULES
1. Use AT MOST 2-3 tool calls per round. Don't call every tool at once.
2. After getting tool results, SYNTHESIZE and RESPOND. Don't keep calling more tools.
3. If the first tool gives enough info, answer immediately without more tools.
4. Be concise. Users want quick answers, not exhaustive research.

## How to work
- service-map → big picture (which services exist, how they connect)
- business-group → what a service does (list its capabilities)
- trace-flow → what happens when an endpoint is called (full flow)
- who-calls-me → upstream callers of an endpoint
- what-do-i-call → downstream targets from an endpoint
- config-lookup → find config values
- find-unresolved → gaps in cross-service linking
- manage-pattern → create/update sink detection patterns
- manage-rule → create/update entrypoint detection rules (graph patterns)

## Response style
- Direct and factual. No filler.
- Use markdown: tables, code blocks, headers.
- When showing endpoints, include full paths.
- Answer in the same language the user uses.`;

// ── LLM call with tool use loop ──

async function callLLMWithTools(
  messages: ChatMessage[],
  llmConfig: LLMConfig,
  maxToolRounds: number = 8,
): Promise<{ response: string; toolsUsed: string[] }> {
  const toolsUsed: string[] = [];

  // Build OpenAI-compatible tools array
  const tools = MULTIVERSE_TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description.split('\n')[0], // first line only to save tokens
      parameters: t.inputSchema,
    },
  }));

  // Convert messages to API format
  const apiMessages = messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool' as const, content: m.content, tool_call_id: m.toolCallId || '' };
    }
    if (m.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });

  for (let round = 0; round < maxToolRounds; round++) {
    const body: Record<string, unknown> = {
      model: llmConfig.model,
      messages: apiMessages,
      tools,
      tool_choice: round >= maxToolRounds - 2 ? 'none' : 'auto',
      max_tokens: llmConfig.maxTokens || 4096,
      temperature: 0,
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (llmConfig.apiKey) {
      headers['x-api-key'] = llmConfig.apiKey;
      headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;
    }

    const res = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message: { content?: string; tool_calls?: any[] } }>;
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No response from LLM');

    const msg = choice.message;

    // If no tool calls, return the text response
    if (!msg.tool_calls?.length) {
      return { response: msg.content || '', toolsUsed };
    }

    // Process tool calls
    const toolCalls: ToolCall[] = msg.tool_calls.map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));

    // Add assistant message with tool calls
    apiMessages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.tool_calls,
    } as any);

    // Execute each tool call and add results
    for (const tc of toolCalls) {
      toolsUsed.push(tc.name);
      mvLog.info(LOG, `Tool: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)})`);

      let result: unknown;
      try {
        result = await handleMultiverseTool(tc.name, tc.arguments);
      } catch (err: unknown) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }

      const resultStr = JSON.stringify(result, null, 0).slice(0, 4000);
      apiMessages.push({
        role: 'tool',
        content: resultStr,
        tool_call_id: tc.id,
      } as any);
    }
  }

  return { response: 'Reached max tool rounds. Please refine your question.', toolsUsed };
}

// ── Router ──

export const createChatRouter = (): Router => {
  const router = Router();

  // POST /api/mv/chat — send message
  router.post('/', async (req, res) => {
    try {
      const { message, sessionId = 'default' } = req.body;
      if (!message) {
        res.status(400).json({ error: 'Required: message' });
        return;
      }

      const config = await loadConfig();
      const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
      if (!llmConfig) {
        res.status(503).json({
          error: 'No LLM configured. Set ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN env vars.',
        });
        return;
      }

      const history = getOrCreateConversation(sessionId);

      // Add system prompt if first message
      if (!history.length) {
        history.push({ role: 'system', content: SYSTEM_PROMPT });
      }

      // Add user message
      history.push({ role: 'user', content: message });

      // Trim history to prevent token overflow
      while (history.length > MAX_HISTORY + 1) {
        // Keep system prompt (index 0), remove oldest user/assistant pair
        history.splice(1, 2);
      }

      mvLog.info(LOG, `Chat [${sessionId}]: ${message.slice(0, 80)}`);

      const { response, toolsUsed } = await callLLMWithTools(history, llmConfig);

      // Add assistant response to history
      history.push({ role: 'assistant', content: response });

      res.json({
        response,
        toolsUsed,
        sessionId,
      });
    } catch (err: unknown) {
      mvLog.error(LOG, 'Chat error', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/mv/chat — clear conversation
  router.delete('/', (req, res) => {
    const sessionId = (req.query.sessionId as string) || 'default';
    conversations.delete(sessionId);
    res.json({ cleared: sessionId });
  });

  // GET /api/mv/chat/status — check if chat is available
  router.get('/status', async (_req, res) => {
    const config = await loadConfig();
    const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
    res.json({
      available: !!llmConfig,
      model: llmConfig?.model || null,
      tools: MULTIVERSE_TOOLS.map((t) => t.name),
    });
  });

  return router;
};
