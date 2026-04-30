/**
 * Multiverse MCP Tool Definitions — v3.0 (9 tools)
 *
 * Graph:  query, search, explore, trace
 * Admin:  services, patterns
 * Sinks:  sinks
 * Context: source, config  (NEW — LLM enablers)
 */

export interface MvToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

export const MULTIVERSE_TOOLS: MvToolDefinition[] = [
  // ── query (raw Cypher) ──
  {
    name: 'query',
    description: `Execute raw Cypher query against the multi-service code knowledge graph.
Returns results as rows. Automatically scoped to a service via repoId when service param is provided.

WHEN TO USE: Complex structural queries that other tools can't answer. Full power of the graph.

SCHEMA:
- Node labels: File, Folder, Class, Interface, Method, Constructor, Property, Variable, Enum, Process, Community, Route, Listener, DetectedSink, Transport, ServiceNode, Gateway
- All code edges use single CodeRelation type with 'type' property
- Edge types: CALLS, STEP_IN_PROCESS, METHOD_IMPLEMENTS, METHOD_OVERRIDES, DEFINES, HAS_METHOD, HAS_PROPERTY, IMPORTS, CONTAINS, ACCESSES, HANDLES_ROUTE, MEMBER_OF, EXTENDS, IMPLEMENTS
- Cross-service edges: TRANSPORTS_TO (Method→Transport), SERVES (Listener→Transport), DEPENDS_ON (ServiceNode→ServiceNode), DETECTED_IN (DetectedSink→Method)
- Key properties: repoId (service ID on all nodes), name, filePath, startLine, qualifiedName

EXAMPLES:
• MATCH (caller)-[:CodeRelation {type:'CALLS'}]->(m:Method {name:'retry'}) WHERE m.repoId='order-db' RETURN caller.name, caller.filePath
• MATCH (d:DetectedSink)-[:DETECTED_IN]->(m:Method) WHERE d.repoId='ordering' RETURN d.calleeMethod, m.name, d.confidence`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query to execute' },
        service: {
          type: 'string',
          description: 'Service ID — auto-adds repoId filter if query contains $service',
        },
      },
      required: ['query'],
    },
  },
  // ── search ──
  {
    name: 'search',
    description: `Search for symbols, processes, or patterns across all indexed services.
Finds Methods, Classes, Interfaces, Routes, Listeners, Processes by name, filePath, or qualifiedName.
Supports OR matching: "sync|reconcil|schedule" matches any term.

WHEN TO USE: Finding where something is defined or used across services.
AFTER THIS: Use explore(symbol) or trace(flow) on results for deeper exploration.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search pattern — supports OR with pipe/comma/space',
        },
        service: { type: 'string', description: 'Limit to one service (optional)' },
        nodeLabels: {
          type: 'string',
          description:
            'Comma-separated label filter: Method,Class,Route,Listener,Process,Interface',
        },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['query'],
    },
  },
  // ── services ──
  {
    name: 'services',
    description: `Unified service management: list services with sink stats, get service info, relink cross-service graph.

Actions:
- list: List all indexed services with sink resolution stats.
- info: Detailed info for one service — sinks, entry points, outbound transports.
- relink: Re-run cross-service linking. Without service param → relink ALL services. skipDetect=true (default) preserves manual resolutions.

WHEN TO USE: After batch-resolving sinks, run relink to update Transport edges. Use without service param to relink all at once.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: list | info | relink' },
        service: {
          type: 'string',
          description: 'Service ID (for info; optional for relink — omit to relink all)',
        },
        type: { type: 'string', description: 'Filter by service type: service | lib (for list)' },
        skipDetect: {
          type: 'boolean',
          description: 'Skip re-detection (default: true, for relink)',
        },
      },
      required: ['action'],
    },
  },
  // ── explore ──
  {
    name: 'explore',
    description: `Unified graph exploration: neighbors, overview, symbol context, implementations, business groups, channels.

Actions:
- neighbors: Direct neighbors of a node (params: nodeId or name+file, direction, edgeTypes, nodeLabels)
- overview: Structural overview of a service (params: service)
- symbol: 360° view — callers, callees, processes (params: name or nodeId, service)
- implementations: Find all implementations of interface/abstract class (params: interface or nodeId, service)
- groups: Business capability groups and entrypoints (params: service)
- channels: List transport channels for a service (params: service)

WHEN TO USE: Exploring code structure, understanding relationships, finding implementations.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'Action: neighbors | overview | symbol | implementations | groups | channels',
        },
        service: { type: 'string', description: 'Service ID' },
        nodeId: { type: 'string', description: 'Node ID (for neighbors/symbol/implementations)' },
        name: { type: 'string', description: 'Node name to search (for neighbors/symbol)' },
        file: { type: 'string', description: 'File path to disambiguate (for neighbors/symbol)' },
        direction: { type: 'string', description: 'in | out | both (for neighbors, default: out)' },
        edgeTypes: {
          type: 'string',
          description: 'Comma-separated edge type filter (for neighbors)',
        },
        nodeLabels: {
          type: 'string',
          description: 'Comma-separated node label filter (for neighbors)',
        },
        interface: {
          type: 'string',
          description: 'Interface/abstract class name (for implementations)',
        },
      },
      required: ['action'],
    },
  },
  // ── trace ──
  {
    name: 'trace',
    description: `Unified flow tracing: trace execution flow, find upstream callers, downstream dependencies, impact analysis.

Actions:
- flow: Full execution flow from entrypoint across services (params: entryPointId or path, service, depth, mainFlowOnly)
- upstream: Find all cross-service callers of an entrypoint (params: entryPointId or path, service)
- downstream: Find all cross-service targets called by an entrypoint (params: entryPointId or path, service)
- impact: Blast radius of changing a symbol (params: target or nodeId, service, direction, maxDepth)

WHEN TO USE: Understanding execution flows, impact analysis, dependency tracing.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: flow | upstream | downstream | impact' },
        service: { type: 'string', description: 'Service ID' },
        entryPointId: {
          type: 'string',
          description: 'Route or Listener node ID (for flow/upstream/downstream)',
        },
        path: {
          type: 'string',
          description: 'Search by route path (for flow/upstream/downstream)',
        },
        depth: { type: 'number', description: 'Max trace depth (for flow, default: 10)' },
        mainFlowOnly: {
          type: 'boolean',
          description: 'Skip Process fan-out (for flow, default: false)',
        },
        target: { type: 'string', description: 'Symbol name (for impact)' },
        nodeId: { type: 'string', description: 'Node ID (for impact)' },
        direction: { type: 'string', description: 'upstream | downstream (for impact)' },
        maxDepth: { type: 'number', description: 'Max traversal depth (for impact, default: 3)' },
      },
      required: ['action'],
    },
  },
  // ── patterns ──
  {
    name: 'patterns',
    description: `Unified pattern & rule management: sink patterns (with scope + wrapper), entrypoint rules.

Use type="sink" (default) for sink detection patterns, type="rule" for entrypoint detection rules.
Actions: list, create, update, enable, disable

 Sink patterns support:
- scope: "common" (all services) | "service-id" | "project:ABC" | [mixed selectors]
- languages / fileExtensions: restrict a pattern or rule to the right source language and file type
- excludePathPatterns: regex path filters to skip fixtures/examples/internal files
- wrapperClass + wrapperMethods: detect at wrapper level

WHEN TO USE: Managing detection patterns and entrypoint rules.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: list | create | update | enable | disable',
        },
        type: { type: 'string', description: 'Pattern type: sink (default) | rule | wrapper' },
        id: { type: 'string', description: 'Pattern/rule ID' },
        name: { type: 'string', description: 'Human-readable name (for create)' },
        service: { type: 'string', description: 'Filter by service scope (for list)' },
        category: {
          type: 'string',
          description: 'http | kafka | rabbit | redis (for sink create)',
        },
        methodPattern: {
          type: 'string',
          description: 'Regex matching method call (for sink create)',
        },
        targetArgIndex: {
          type: 'number',
          description: 'Arg index with URL/topic (for sink create)',
        },
        scope: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description:
            '"common", a service id, "project:ABC", or an array of mixed selectors (for sink create/update)',
        },
        wrapperClass: { type: 'string', description: 'Wrapper class name (for wrapper create)' },
        wrapperMethods: {
          type: 'array',
          description: 'Wrapper method names',
          items: { type: 'string' },
        },
        languages: {
          type: 'array',
          description: 'Optional source languages, e.g. ["java", "kotlin"]',
          items: { type: 'string' },
        },
        fileExtensions: {
          type: 'array',
          description: 'Optional file extensions, e.g. [".java", ".kt"]',
          items: { type: 'string' },
        },
        excludePathPatterns: {
          type: 'array',
          description: 'Optional regex path filters to exclude matching files',
          items: { type: 'string' },
        },
        match: {
          type: 'array',
          description: 'Match steps for rule create',
          items: {
            type: 'object',
            properties: {
              node: { type: 'string' },
              label: {
                anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
              from: { type: 'string' },
              edge: { type: 'string' },
              direction: { type: 'string' },
              where: { type: 'object', additionalProperties: true },
            },
            required: ['node', 'label'],
            additionalProperties: true,
          },
        },
        emit: {
          type: 'object',
          description: 'Emit config for rule create',
          properties: {
            type: { type: 'string' },
            name: { type: 'string' },
            topic: { type: 'string' },
          },
          required: ['name'],
          additionalProperties: true,
        },
      },
      required: ['action'],
    },
  },
  // ── sinks ──
  {
    name: 'sinks',
    description: `Unified sink management: list, analyze, resolve (batch), promote wrapper→callers, fan-out, llm-resolve.

Actions:
- list: List sinks with filters (status, type, groupBy). groupBy="calleeMethod" detects wrapper patterns.
- analyze: Deep analysis of 1 sink — source context, callers, config suggestions, auto-detect wrapper.
- resolve: Batch resolve multiple sinks in one call. Accepts resolutions array.
- promote: Mark a wrapper sink → engine creates N caller-sinks (1 per caller with extracted arg).
- fan-out: promote + auto-resolve via config scan. The most powerful action.
- llm-resolve: use the configured LLM to resolve one sink (sinkId) or all unresolved sinks in a service.

WORKFLOW: list(groupBy) → identify wrappers → fan-out → llm-resolve unresolved sinks → resolve any remaining manually.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: list | analyze | resolve | promote | fan-out | llm-resolve',
        },
        service: { type: 'string', description: 'Service ID filter / target service' },
        sinkId: {
          type: 'string',
          description: 'Sink ID (for analyze/promote/fan-out/llm-resolve)',
        },
        status: { type: 'string', description: 'Filter: unresolved | resolved | all (for list)' },
        type: {
          type: 'string',
          description: 'Filter by sink type: kafka | http | rabbit (for list)',
        },
        groupBy: {
          type: 'string',
          description: 'Group by: calleeMethod (for list — detects wrappers)',
        },
        limit: { type: 'number', description: 'Max results (default: 50, for list)' },
        resolutions: {
          type: 'array',
          description: 'Array of {sinkId, value, confidence} for batch resolve',
          items: {
            type: 'object',
            properties: {
              sinkId: { type: 'string' },
              value: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['sinkId', 'value'],
            additionalProperties: false,
          },
        },
        targetArgIndex: {
          type: 'number',
          description: 'Arg index for URL/topic (0-based, for promote/fan-out)',
        },
        autoResolve: {
          type: 'boolean',
          description: 'Auto-resolve after promote (for fan-out, default: true)',
        },
        wrapperConfig: {
          type: 'object',
          description: 'Wrapper config: {targetArgIndex} (for promote)',
          properties: {
            targetArgIndex: { type: 'number' },
          },
          additionalProperties: false,
        },
        relink: {
          type: 'boolean',
          description:
            'Re-link the service after llm-resolve if any sinks were resolved (default: true)',
        },
      },
      required: ['action'],
    },
  },
  // ── source (NEW) ──
  {
    name: 'source',
    description: `Read raw source code, class metadata, method bodies, and callers from indexed services.

Actions:
- read: Read source lines from a file (params: service, file, line?, range?)
- class: Get class metadata — @Value fields, injected beans, methods, interfaces (params: service, file or className)
- method: Get method body + annotations (params: service, nodeId or name+file)
- callers: Find all callers of a method with call-site source snippets (params: service, nodeId or name+file)
- grep: Regex search across service source files (params: service, pattern, filePattern?)

WHEN TO USE: Reading source code to understand sink targets, resolve URLs/topics, or explore code structure.
WORKFLOW for sink resolution: source(class) → read @Value fields → config(lookup) → sinks(resolve)`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: read | class | method | callers | grep' },
        service: { type: 'string', description: 'Service ID (required)' },
        file: { type: 'string', description: 'File path relative to repo root' },
        className: { type: 'string', description: 'Class name (for class action)' },
        nodeId: { type: 'string', description: 'Graph node ID (for method/callers)' },
        name: { type: 'string', description: 'Method name (for method/callers)' },
        line: { type: 'number', description: 'Center line number (for read)' },
        range: { type: 'number', description: 'Number of lines to read (default: 30, for read)' },
        pattern: { type: 'string', description: 'Regex pattern (for grep)' },
        filePattern: { type: 'string', description: 'File path filter regex (for grep)' },
        limit: { type: 'number', description: 'Max results (for callers/grep)' },
        maxResults: { type: 'number', description: 'Max grep results (default: 30)' },
      },
      required: ['action'],
    },
  },
  // ── config (NEW) ──
  {
    name: 'config',
    description: `Direct access to resolved Spring config keys for a service.

Actions:
- lookup: Resolve a single config key with \${ref} substitution (params: service, key)
- search: Fuzzy search config keys by glob pattern like "*.url" or "kafka.*.topic" (params: service, pattern)
- list: List all config keys, optionally filtered by prefix (params: service, prefix?)
- sources: Show active config sources — local files, cloud config (params: service)

WHEN TO USE: Resolving @Value("$\{key}") annotations to actual values, finding config keys for sink resolution.
WORKFLOW: source(class) → find @Value key → config(lookup, key) → get actual URL/topic`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: lookup | search | list | sources' },
        service: { type: 'string', description: 'Service ID (required)' },
        key: { type: 'string', description: 'Config key to lookup (for lookup)' },
        pattern: {
          type: 'string',
          description: 'Glob pattern like "*.url" or "kafka.*.topic" (for search)',
        },
        prefix: { type: 'string', description: 'Key prefix filter (for list)' },
        limit: {
          type: 'number',
          description: 'Max results (default: 30 for search, 100 for list)',
        },
      },
      required: ['action'],
    },
  },
];
