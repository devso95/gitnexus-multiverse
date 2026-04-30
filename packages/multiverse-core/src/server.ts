import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config/loader.js';
import { createBasicAuth } from './auth/basic-auth.js';
import { createConfigRouter } from './api/config-api.js';
import { createFsRouter } from './api/fs-api.js';
import { mvLog } from './util/logger.js';

const LOG = 'server';
const coreRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(coreRoot, '../../..');
const requireFromGitNexus = createRequire(path.resolve(repoRoot, 'gitnexus/package.json'));

export interface StartMultiverseOptions {
  config?: string;
  port?: number;
  host?: string;
}

const legacyModuleUrl = (...segments: string[]) =>
  pathToFileURL(path.resolve(coreRoot, '../../../gitnexus/src/multiverse', ...segments)).href;

const coreModuleUrl = (...segments: string[]) =>
  pathToFileURL(path.resolve(coreRoot, '../../../gitnexus/src/core', ...segments)).href;

const loadLegacyModule = async <T>(...segments: string[]) =>
  (await import(legacyModuleUrl(...segments))) as T;

const loadCoreModule = async <T>(...segments: string[]) =>
  (await import(coreModuleUrl(...segments))) as T;

export const startMultiverseServer = async (
  options: StartMultiverseOptions = {},
): Promise<unknown> => {
  const express = requireFromGitNexus('express') as any;
  const cors = requireFromGitNexus('cors') as (options: unknown) => any;
  const config = await loadConfig(options.config);
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;

  if (!config.neo4j?.uri) throw new Error('Config error: neo4j.uri is required');
  if (!config.neo4j?.password) {
    throw new Error('Config error: neo4j.password is required (set NEO4J_PASSWORD env)');
  }
  if (!config.workspace?.dir) throw new Error('Config error: workspace.dir is required');

  process.env.GITNEXUS_GRAPH_BACKEND = 'neo4j';

  mvLog.info(LOG, 'Connecting to Neo4j...');
  const { getGraphBackend } = await loadCoreModule<{
    getGraphBackend: () => Promise<{
      init: (
        dbPath: string,
        config: { uri: string; user: string; password: string; database: string },
      ) => Promise<void>;
      getStats: () => Promise<{ nodes: number; edges: number }>;
      isReady: () => boolean;
      close: () => Promise<void>;
    }>;
  }>('graph-backend/index.ts');
  const backend = await getGraphBackend();
  await backend.init('neo4j', {
    uri: config.neo4j.uri,
    user: config.neo4j.user,
    password: config.neo4j.password,
    database: config.neo4j.database,
  });
  mvLog.info(LOG, 'Neo4j connected');

  const { ensureServiceConstraints, listServices } = await loadLegacyModule<{
    ensureServiceConstraints: () => Promise<void>;
    listServices: () => Promise<Array<unknown>>;
  }>('admin/service-registry.ts');
  await ensureServiceConstraints();

  const { createServicesRouter } = await loadLegacyModule<{ createServicesRouter: () => unknown }>(
    'api/services-api.ts',
  );
  const { createAnalyzeRouter, createOpsRouter } = await loadLegacyModule<{
    createAnalyzeRouter: () => unknown;
    createOpsRouter: () => unknown;
  }>('api/analyze-api.ts');
  const { createChatRouter } = await loadLegacyModule<{
    createChatRouter: () => unknown;
  }>('api/chat-api.ts');
  const { createGraphRouter } = await loadLegacyModule<{
    createGraphRouter: () => unknown;
  }>('api/graph-api.ts');

  const app = express();

  app.use(
    cors({
      origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
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

  app.get('/api/ops/health', async (_req: unknown, res: any) => {
    try {
      const stats = await backend.getStats();
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

  const auth = createBasicAuth(config.auth.users);

  app.use('/api/mv/services', auth, createServicesRouter() as any);
  app.use('/api/mv/services', auth, createAnalyzeRouter() as any);
  app.use('/api/mv/ops', auth, createOpsRouter() as any);
  app.use('/api/mv/config', auth, createConfigRouter() as any);
  app.use('/api/mv/chat', auth, createChatRouter() as any);
  app.use('/api/mv/graph', auth, createGraphRouter() as any);
  app.use('/api/mv/fs', auth, createFsRouter());

  app.get('/wiki/:serviceId', auth, async (req: any, res: any) => {
    try {
      const { generateWikiHtml } = await loadLegacyModule<{
        generateWikiHtml: (serviceId: string) => Promise<string>;
      }>('wiki/wiki-generator.ts');
      const html = await generateWikiHtml(req.params.serviceId);
      res.type('html').send(html);
    } catch (err: unknown) {
      res
        .status(500)
        .send(`<h1>Wiki Error</h1><p>${err instanceof Error ? err.message : String(err)}</p>`);
    }
  });

  app.get('/api/mv/wiki/:serviceId', auth, async (req: any, res: any) => {
    try {
      const { generateWikiData } = await loadLegacyModule<{
        generateWikiData: (serviceId: string) => Promise<unknown>;
      }>('wiki/wiki-generator.ts');
      const data = await generateWikiData(req.params.serviceId);
      res.json(data);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/mv/wiki/generate', auth, async (req: any, res: any) => {
    try {
      const { generateAllWiki } = await loadLegacyModule<{
        generateAllWiki: (outputDir: string) => Promise<unknown>;
      }>('wiki/markdown-wiki-generator.ts');
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

  app.post('/api/mv/wiki/generate/:serviceId', auth, async (req: any, res: any) => {
    try {
      const { generateServiceWiki } = await loadLegacyModule<{
        generateServiceWiki: (serviceId: string, outputDir: string) => Promise<unknown>;
      }>('wiki/markdown-wiki-generator.ts');
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

  app.get('/api/mv/wiki/md/:serviceId', auth, async (req: any, res: any) => {
    try {
      const outputDir = config.wiki?.outputDir;
      if (!outputDir) {
        res.json({ files: [] });
        return;
      }
      const svcDir = path.join(outputDir, req.params.serviceId);
      const fsModule = await import('node:fs');
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

  app.get('/api/mv/wiki/md/:serviceId/:fileName', auth, async (req: any, res: any) => {
    try {
      const outputDir = config.wiki?.outputDir;
      if (!outputDir) {
        res.status(404).json({ error: 'Wiki not configured' });
        return;
      }
      const filePath = path.join(outputDir, req.params.serviceId, req.params.fileName);
      const fsModule = await import('node:fs');
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

  app.post('/api/mv/tools/:toolName', auth, async (req: any, res: any) => {
    try {
      const { handleMultiverseTool } = await loadLegacyModule<{
        handleMultiverseTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
      }>('mcp/tool-handlers.ts');
      const result = await handleMultiverseTool(req.params.toolName, req.body);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/mv/tools', auth, async (_req: unknown, res: any) => {
    const { MULTIVERSE_TOOLS } = await loadLegacyModule<{
      MULTIVERSE_TOOLS: Array<{ name: string; description: string }>;
    }>('mcp/tools.ts');
    res.json({
      tools: MULTIVERSE_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description.split('\n')[0],
      })),
    });
  });

  const mcpSdkServer = await importMcpModule('@modelcontextprotocol/sdk/server/index.js');
  const mcpHttp = await importMcpModule('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const mcpTypes = await importMcpModule('@modelcontextprotocol/sdk/types.js');
  const { randomUUID } = await import('node:crypto');
  const { MULTIVERSE_TOOLS } = await loadLegacyModule<{
    MULTIVERSE_TOOLS: Array<{ name: string; description: string; inputSchema: unknown }>;
  }>('mcp/tools.ts');
  const { handleMultiverseTool } = await loadLegacyModule<{
    handleMultiverseTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  }>('mcp/tool-handlers.ts');

  const mcpSessions = new Map<
    string,
    {
      server: any;
      transport: any;
      lastActivity: number;
    }
  >();

  const createMvMcpServer = () => {
    const server = new mcpSdkServer.Server(
      { name: 'multiverse', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(mcpTypes.ListToolsRequestSchema, async () => ({
      tools: MULTIVERSE_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
    server.setRequestHandler(mcpTypes.CallToolRequestSchema, async (req: any) => {
      const { name, arguments: args } = req.params;
      try {
        const result = await handleMultiverseTool(name, args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return {
          content: [
            { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    });
    return server;
  };

  app.all('/mcp', async (req: any, res: any) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && mcpSessions.has(sessionId)) {
        const session = mcpSessions.get(sessionId)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(req, res, req.body);
      } else if (sessionId) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
      } else if (req.method === 'POST') {
        const transport = new mcpHttp.StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createMvMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        if (transport.sessionId) {
          mcpSessions.set(transport.sessionId, { server, transport, lastActivity: Date.now() });
          transport.onclose = () => mcpSessions.delete(transport.sessionId);
        }
      } else if (req.method === 'GET') {
        if (sessionId && mcpSessions.has(sessionId)) {
          const session = mcpSessions.get(sessionId)!;
          await session.transport.handleRequest(req, res, req.body);
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
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          id: null,
        });
      }
    }
  });

  const mcpCleanup = setInterval(
    () => {
      const now = Date.now();
      for (const [id, session] of mcpSessions) {
        if (now - session.lastActivity > 30 * 60 * 1000) {
          try {
            session.server.close();
          } catch {}
          mcpSessions.delete(id);
        }
      }
    },
    5 * 60 * 1000,
  );
  if (typeof (mcpCleanup as NodeJS.Timeout).unref === 'function') {
    (mcpCleanup as NodeJS.Timeout).unref();
  }

  mvLog.info(LOG, 'MCP endpoint mounted at /mcp');

  const fsModule = await import('node:fs');
  const webDistCandidates = [
    path.resolve(repoRoot, 'packages', 'multiverse-web', 'dist'),
    path.resolve(repoRoot, 'gitnexus-multiverse-web', 'dist'),
  ];
  const webDist = webDistCandidates.find((candidate) => fsModule.existsSync(candidate));
  if (webDist) {
    app.use(express.static(webDist));
    app.get('*', (req: any, res: any, next: any) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/wiki/')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  } else {
    app.get('/', (_req: unknown, res: any) => {
      res.send(`<!DOCTYPE html><html><head><title>GitNexus Multiverse</title>
      <style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px;color:#e0e0e0;background:#0f1117}a{color:#a29bfe}</style>
      </head><body><h1>⚡ Multiverse</h1><p>Admin UI not built yet. Run <code>cd ../packages/multiverse-web && npm run build</code> first.</p>
      <p>API: <a href="/api/ops/health">/api/ops/health</a></p></body></html>`);
    });
  }

  app.use((err: unknown, _req: unknown, res: any, _next: unknown) => {
    mvLog.error(LOG, 'Unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
  });

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

async function importMcpModule(specifier: string): Promise<any> {
  const resolved = requireFromGitNexus.resolve(specifier);
  return import(pathToFileURL(resolved).href);
}
