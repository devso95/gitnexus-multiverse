/**
 * GitNexus Multiverse — Unified Server
 *
 * Single Express process serving:
 *   /              → Admin UI (placeholder)
 *   /mcp           → MCP SSE transport (delegated to gitnexus)
 *   /wiki/:id      → Wiki placeholder
 *   /api/mv/*      → Multiverse REST API (basic auth)
 *   /api/ops/health→ Health check (no auth)
 *   /api/*         → GitNexus existing API (basic auth)
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config/loader.js';
import { createBasicAuth } from './auth/basic-auth.js';
import { createServicesRouter } from './api/services-api.js';
import { createAnalyzeRouter, createOpsRouter } from './api/analyze-api.js';
import { ensureServiceConstraints } from './admin/service-registry.js';
import { mvLog } from './util/logger.js';

const LOG = 'server';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const startMultiverseServer = async (
  options: { config?: string; port?: number; host?: string } = {},
) => {
  const config = await loadConfig(options.config);
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;

  // Validate critical config
  if (!config.neo4j?.uri) throw new Error('Config error: neo4j.uri is required');
  if (!config.neo4j?.password)
    throw new Error('Config error: neo4j.password is required (set NEO4J_PASSWORD env)');
  if (!config.workspace?.dir) throw new Error('Config error: workspace.dir is required');

  // Set graph backend type (not credentials)
  process.env.GITNEXUS_GRAPH_BACKEND = 'neo4j';

  // Init Neo4j with config directly (no credentials in process.env)
  mvLog.info(LOG, 'Connecting to Neo4j...');
  const { getGraphBackend } = await import('../core/graph-backend/index.js');
  const backend = await getGraphBackend();
  await backend.init('neo4j', {
    uri: config.neo4j.uri,
    user: config.neo4j.user,
    password: config.neo4j.password,
    database: config.neo4j.database,
  });
  mvLog.info(LOG, 'Neo4j connected');

  // Ensure constraints
  await ensureServiceConstraints();

  const app = express();

  // CORS — restrict to localhost and private networks
  app.use(
    cors({
      origin: (origin, cb) => {
        if (
          !origin ||
          /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d|172\.(1[6-9]|2\d|3[01])\.\d|192\.168\.\d)/.test(
            origin,
          )
        ) {
          cb(null, true);
        } else {
          cb(new Error('CORS blocked'));
        }
      },
    }),
  );
  app.use(express.json({ limit: '10mb' }));

  // ── Health check (NO auth) ──
  app.get('/api/ops/health', async (_req, res) => {
    try {
      const stats = await backend.getStats();
      const { listServices } = await import('./admin/service-registry.js');
      const services = await listServices();
      res.json({
        status: 'healthy',
        neo4j: { connected: backend.isReady(), ...stats },
        services: { total: services.length },
        version: 'multiverse-1.0.0',
      });
    } catch (err: unknown) {
      res
        .status(503)
        .json({ status: 'unhealthy', error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Basic auth for protected routes ──
  const auth = createBasicAuth(config.auth.users);

  // ── Multiverse API (auth required) ──
  app.use('/api/mv/services', auth, createServicesRouter());
  app.use('/api/mv/services', auth, createAnalyzeRouter());
  app.use('/api/mv/ops', auth, createOpsRouter());

  // ── Config API (sink patterns) ──
  const { createConfigRouter } = await import('./api/config-api.js');
  app.use('/api/mv/config', auth, createConfigRouter());

  // ── Chat API (server-side LLM agent) ──
  const { createChatRouter } = await import('./api/chat-api.js');
  app.use('/api/mv/chat', auth, createChatRouter());

  // ── Graph API (internal graph visualization) ──
  const { createGraphRouter } = await import('./api/graph-api.js');
  app.use('/api/mv/graph', auth, createGraphRouter());

  // ── FS API (directory browsing) ──
  const { createFsRouter } = await import('./api/fs-api.js');
  app.use('/api/mv/fs', auth, createFsRouter());

  // ── Wiki (real generator) ──
  app.get('/wiki/:serviceId', auth, async (req, res) => {
    try {
      const { generateWikiHtml } = await import('./wiki/wiki-generator.js');
      const html = await generateWikiHtml(req.params.serviceId);
      res.type('html').send(html);
    } catch (err: unknown) {
      res
        .status(500)
        .send(`<h1>Wiki Error</h1><p>${err instanceof Error ? err.message : String(err)}</p>`);
    }
  });

  // ── Wiki API (JSON) ──
  app.get('/api/mv/wiki/:serviceId', auth, async (req, res) => {
    try {
      const { generateWikiData } = await import('./wiki/wiki-generator.js');
      const data = await generateWikiData(req.params.serviceId);
      res.json(data);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Wiki Generate (markdown to disk) ──
  app.post('/api/mv/wiki/generate', auth, async (req, res) => {
    try {
      const { generateAllWiki } = await import('./wiki/markdown-wiki-generator.js');
      const outputDir = req.body.outputDir || config.wiki?.outputDir;
      if (!outputDir) {
        res
          .status(400)
          .json({ error: 'outputDir required — set in config wiki.outputDir or pass in body' });
        return;
      }
      const result = await generateAllWiki(outputDir);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/mv/wiki/generate/:serviceId', auth, async (req, res) => {
    try {
      const { generateServiceWiki } = await import('./wiki/markdown-wiki-generator.js');
      const outputDir = req.body.outputDir || config.wiki?.outputDir;
      if (!outputDir) {
        res
          .status(400)
          .json({ error: 'outputDir required — set in config wiki.outputDir or pass in body' });
        return;
      }
      const result = await generateServiceWiki(req.params.serviceId, outputDir);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Wiki Markdown API (serve generated .md files for UI) ──
  app.get('/api/mv/wiki/md/:serviceId', auth, async (req, res) => {
    try {
      const outputDir = config.wiki?.outputDir;
      if (!outputDir) {
        res.json({ files: [] });
        return;
      }
      const svcDir = path.join(outputDir, req.params.serviceId);
      const fsModule = await import('fs');
      if (!fsModule.existsSync(svcDir)) {
        res.json({ files: [] });
        return;
      }
      const entries = fsModule
        .readdirSync(svcDir)
        .filter((f: string) => f.endsWith('.md'))
        .sort();
      res.json({ files: entries });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/mv/wiki/md/:serviceId/:fileName', auth, async (req, res) => {
    try {
      const outputDir = config.wiki?.outputDir;
      if (!outputDir) {
        res.status(404).json({ error: 'Wiki not configured' });
        return;
      }
      const filePath = path.join(outputDir, req.params.serviceId, req.params.fileName);
      const fsModule = await import('fs');
      if (!fsModule.existsSync(filePath) || !req.params.fileName.endsWith('.md')) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const content = fsModule.readFileSync(filePath, 'utf-8');
      res.type('text/markdown').send(content);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── MCP Tools API (for programmatic access to multiverse tools) ──
  app.post('/api/mv/tools/:toolName', auth, async (req, res) => {
    try {
      const { handleMultiverseTool } = await import('./mcp/tool-handlers.js');
      const result = await handleMultiverseTool(req.params.toolName, req.body);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── List available MCP tools ──
  app.get('/api/mv/tools', auth, async (_req, res) => {
    const { MULTIVERSE_TOOLS } = await import('./mcp/tools.js');
    res.json({
      tools: MULTIVERSE_TOOLS.map((t) => ({
        name: t.name,
        description: t.description.split('\n')[0],
      })),
    });
  });

  // ── MCP StreamableHTTP endpoint (for AI agent connections) ──
  const { Server: McpServer } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } =
    await import('@modelcontextprotocol/sdk/types.js');
  const { MULTIVERSE_TOOLS: toolDefs } = await import('./mcp/tools.js');
  const { handleMultiverseTool: handleTool } = await import('./mcp/tool-handlers.js');
  const { randomUUID } = await import('crypto');

  const mcpSessions = new Map<
    string,
    {
      server: InstanceType<typeof McpServer>;
      transport: InstanceType<typeof StreamableHTTPServerTransport>;
      lastActivity: number;
    }
  >();

  const createMvMcpServer = () => {
    const server = new McpServer(
      { name: 'multiverse', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolDefs.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));
    server.setRequestHandler(
      CallToolRequestSchema,
      async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
        const { name, arguments: args } = req.params;
        try {
          const result = await handleTool(name, args || {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err: unknown) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
    return server;
  };

  app.all('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && mcpSessions.has(sessionId)) {
        const s = mcpSessions.get(sessionId);
        if (!s) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          });
          return;
        }
        s.lastActivity = Date.now();
        await s.transport.handleRequest(req, res, req.body);
      } else if (sessionId) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
      } else if (req.method === 'POST') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createMvMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        if (transport.sessionId) {
          const createdSessionId = transport.sessionId;
          mcpSessions.set(createdSessionId, { server, transport, lastActivity: Date.now() });
          transport.onclose = () => {
            if (transport.sessionId) mcpSessions.delete(transport.sessionId);
          };
        }
      } else if (req.method === 'GET') {
        // SSE listener for existing session
        if (sessionId && mcpSessions.has(sessionId)) {
          const s = mcpSessions.get(sessionId);
          if (!s) {
            res.status(404).json({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            });
            return;
          }
          await s.transport.handleRequest(req, res, req.body);
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'POST to initialize first' },
            id: null,
          });
        }
      } else {
        res.status(405).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        });
      }
    } catch (err: unknown) {
      if (!res.headersSent)
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          id: null,
        });
    }
  });

  // Cleanup idle MCP sessions every 5 min
  const mcpCleanup = setInterval(
    () => {
      const now = Date.now();
      for (const [id, s] of mcpSessions) {
        if (now - s.lastActivity > 30 * 60 * 1000) {
          try {
            s.server.close();
          } catch {}
          mcpSessions.delete(id);
        }
      }
    },
    5 * 60 * 1000,
  );
  if (mcpCleanup && typeof mcpCleanup === 'object' && 'unref' in mcpCleanup)
    (mcpCleanup as NodeJS.Timeout).unref();

  mvLog.info(LOG, 'MCP endpoint mounted at /mcp');

  // ── Static Admin UI (React SPA build output) ──
  const webDistCandidates = [
    path.resolve(__dirname, '..', '..', '..', 'packages', 'multiverse-web', 'dist'),
    path.resolve(__dirname, '..', '..', '..', 'gitnexus-multiverse-web', 'dist'),
  ];
  const fs = await import('fs');
  const webDist = webDistCandidates.find((candidate) => fs.existsSync(candidate));
  if (webDist) {
    app.use(express.static(webDist));
    // SPA fallback: serve index.html for all non-API routes
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/wiki/')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.send(`<!DOCTYPE html><html><head><title>GitNexus Multiverse</title>
      <style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px;color:#e0e0e0;background:#0f1117}a{color:#a29bfe}</style>
      </head><body><h1>⚡ Multiverse</h1><p>Admin UI not built yet. Run <code>cd ../packages/multiverse-web && npm run build</code> first.</p>
      <p>API: <a href="/api/ops/health">/api/ops/health</a></p></body></html>`);
    });
  }

  // ── Error handler ──
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      mvLog.error(LOG, 'Unhandled error', err);
      res.status(500).json({ error: 'Internal server error' });
    },
  );

  // ── Start ──
  const server = app.listen(port, host, () => {
    mvLog.info(LOG, `Multiverse server running on http://${host}:${port}`);
    mvLog.info(LOG, `Dashboard: http://${host}:${port}/`);
    if (config.cloudConfig?.enabled) {
      mvLog.info(
        LOG,
        `Cloud Config: ${config.cloudConfig.baseUrl} (profile: ${config.cloudConfig.defaultProfile})`,
      );
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    mvLog.info(LOG, 'Shutting down...');
    server.close();
    await backend.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
};
