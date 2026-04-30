# Multiverse — Cross-Service Analysis Engine

## Overview

Multiverse extends GitNexus with **cross-service analysis**: detect how microservices communicate via HTTP APIs, message queues, and library dependencies. It builds a **service graph** where services are connected through **Transport** hub nodes (API endpoints, Kafka topics) and **Gateway** classes (client code that calls external services).

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Web UI (:3003)                         │
│  Dashboard │ Services │ ServiceDetail │ ServiceMap │ Wiki  │
│  Channels │ Attention │ SinkPatterns │ ManualLinks         │
└───────────────────────┬──────────────────────────────────┘
                        │ REST API (Basic Auth)
┌───────────────────────┴──────────────────────────────────┐
│                   Multiverse Server                        │
│  analyze-api │ services-api │ graph-api │ config-api       │
│  tool-handlers (MCP)                                       │
└───────────────────────┬──────────────────────────────────┘
                        │
┌───────────────────────┴──────────────────────────────────┐
│               Engine Pipeline (per service)                │
│                                                            │
│  1. Git Clone/Pull ──→ workspace/{service-id}              │
│  2. GitNexus Core ───→ parse source → in-memory graph      │
│  3. Persist Neo4j ───→ label-aware MERGE (optimized)       │
│  4. Sink Detector ───→ scan source for outbound patterns   │
│  5. Config Resolver ─→ local YAML + Spring Cloud Config    │
│  6. Bubble-Up ───────→ resolve targets via config/trace    │
│  7. Cross-Linker ────→ Gateway + Transport + SERVES edges  │
│  8. Listener Resolve → resolve config placeholders         │
│  9. Business Grouper → group entry points by domain        │
│ 10. Lib Detector ────→ pom.xml → DEPENDS_ON edges          │
│ 11. Route Fixer ─────→ prepend class-level base paths      │
└───────────────────────┬──────────────────────────────────┘
                        │
               Neo4j Graph Database
```

## Graph Model — Gateway + Transport

```
SERVICE A                                              SERVICE B
┌────────────────────────────┐                        ┌────────────────────────┐
│                            │                        │                        │
│  Route ← Controller       │                        │  Listener              │
│  POST /orders              │                        │  @KafkaListener        │
│       ↓                    │                        │       ↑                │
│  UseCase → Gateway ────────┼── TRANSPORTS_TO ──→ Transport ←── SERVES ──┤
│            KafkaProducer   │                    KafkaTopic:             │
│            (class)         │                    order.created           │
│                            │                        │                        │
│  Gateway ──────────────────┼── TRANSPORTS_TO ──→ Transport ←── SERVES ──┤
│  ServiceBClient            │                    ApiEndpoint:            │
│  (class)                   │                    /api/v1/payments        │
└────────────────────────────┘                        └────────────────────────┘
```

### Node Types

| Label | Description | Key Properties |
|-------|-------------|----------------|
| `ServiceNode` | Registered microservice | id, name, type, repoProject, analyzeStatus |
| `Gateway` | Class that calls external services | id, name, repoId, classNodeId |
| `Transport` | Hub node between services (API/Kafka) | id, type (api/kafka), name, path, topic |
| `Route` | HTTP endpoint handler | id, repoId, routePath, httpMethod, controllerName |
| `Listener` | Message consumer | id, repoId, topic, resolvedTopic, listenerType |
| `BusinessGroup` | Domain grouping of entry points | id, serviceId, name, entryPointCount |
| `DetectedSink` | Raw outbound call detection | id, repoId, sinkType, targetExpression, confidence |
| `Class/Method/...` | GitNexus core code elements | id, repoId, name, filePath |

### Edge Types

| Type | From → To | Meaning |
|------|-----------|---------|
| `TRANSPORTS_TO` | Method → Transport | Outbound call through a transport |
| `SERVES` | Route/Listener → Transport | Inbound handler for a transport |
| `WRAPS` | Gateway → Class | Gateway wraps a client class |
| `DEPENDS_ON` | ServiceNode → ServiceNode | Library dependency |
| `CodeRelation` | Any → Any | Core code relationships (CALLS, CONTAINS, etc.) |

### Cross-Service Query

```cypher
MATCH (m)-[:TRANSPORTS_TO]->(t:Transport)<-[:SERVES]-(entry)
WHERE m.repoId <> entry.repoId
RETURN m.repoId AS from, entry.repoId AS to, t.type, t.name AS via
```

## Pipeline Steps

### 1. Sink Detector
Scans source files with configurable regex patterns to find outgoing calls:
- **HTTP**: `restTemplate.*`, `webClient.*`, custom wrappers
- **Kafka**: `kafkaTemplate.send`, custom producers
- **RabbitMQ**: `rabbitTemplate.convertAndSend`
- **In-file resolution**: constants, `@Value` annotations, multi-line URL construction

### 2. Config Resolver
Merges config from multiple sources (priority order):
1. `bootstrap.yml` / `application.yml` (local)
2. Spring Cloud Config Server (remote, optional)

### 3. Bubble-Up
Resolves sink target expressions to actual values:
- Literal strings → direct resolve
- Config keys (`${config.key}`) → config lookup
- Composite (`${base}+${path}`) → concatenated resolution
- Constants → graph lookup
- Caller chain trace (max 5 levels) → find `@Value` annotations

### 4. Cross-Linker
Creates the Gateway + Transport graph:
1. **Gateway nodes** from client classes containing sinks
2. **Transport nodes** (API endpoints / message topics) from resolved values
3. **TRANSPORTS_TO** edges from methods to transports
4. **Auto-match SERVES**: Routes/Listeners matched to Transports by tail-segment matching
5. **Auto-merge on join**: new service's endpoints auto-link to existing Transports

### 5. Route Fixer
Scans class-level `@RequestMapping` to prepend base paths that the core parser misses.

### 6. Business Grouper
Groups entry points by business domain (controller name prefix).

## API Endpoints

### Services CRUD
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mv/services` | List all services |
| `POST` | `/api/mv/services` | Register service (auto-parse gitUrl) |
| `GET` | `/api/mv/services/:id` | Service detail |
| `PUT` | `/api/mv/services/:id` | Update service |
| `DELETE` | `/api/mv/services/:id?confirm=true` | Delete service + data |
| `POST` | `/api/mv/services/:id/analyze` | Trigger full analyze (async) |
| `POST` | `/api/mv/services/:id/relink` | Re-run cross-linking only |
| `GET` | `/api/mv/services/:id/status` | Analyze status + stats |

### Graph Exploration
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mv/graph/:id/explore` | Neighborhood graph (seeds, depth, focus) |
| `GET` | `/api/mv/graph/:id/search?q=` | Search nodes by name |
| `GET` | `/api/mv/graph/:id/node/:nodeId` | Node detail + connections |

### MCP Tools
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/mv/tools/service-map` | Service graph with Transport links |
| `POST` | `/api/mv/tools/business-group` | Entry points grouped by domain |
| `POST` | `/api/mv/tools/trace-flow` | Trace from entry point downstream |
| `POST` | `/api/mv/tools/who-calls-me` | Incoming calls to a method |
| `POST` | `/api/mv/tools/what-do-i-call` | Outgoing calls from a method |
| `POST` | `/api/mv/tools/config-lookup` | Look up config key across services |
| `POST` | `/api/mv/tools/find-unresolved` | List unresolved sinks |

### Config
| Method | Path | Description |
|--------|------|-------------|
| `GET/POST/PUT/DELETE` | `/api/mv/config/patterns` | Sink pattern CRUD |
| `GET/POST/PUT/DELETE` | `/api/mv/config/links` | Manual link CRUD |

## Web UI

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Stats overview |
| Services | `/services` | CRUD + analyze with live status |
| Service Detail | `/services/:id` | Entry points by group, trace on click |
| Service Map | `/map` | D3.js force graph with Transport diamonds |
| Service Map (explore) | `/map?service=X` | Internal graph exploration |
| Channels | `/channels` | Message channels between services |
| Attention | `/attention` | Unresolved sinks needing review |
| Sink Patterns | `/sink-patterns` | Detection pattern management |
| Manual Links | `/manual-links` | Manual cross-service link management |
| Wiki | `/wiki` | Embedded documentation viewer |

## Configuration

### `.env` file
```bash
GITNEXUS_GRAPH_BACKEND=neo4j
GITNEXUS_NEO4J_URI=neo4j://localhost:7687
GITNEXUS_NEO4J_USER=neo4j
GITNEXUS_NEO4J_PASSWORD=your-password
GITNEXUS_NEO4J_DATABASE=neo4j
MV_IP=0.0.0.0
MV_ADMIN_USER=admin
MV_ADMIN_PASS=admin
MV_WORKSPACE=/path/to/workspace/repos
MV_GIT_BASE=https://your-git-server.com/scm
```

### Management Script
```bash
./multiverse.sh start    # Build + start on port 3003
./multiverse.sh stop     # Stop server
./multiverse.sh restart  # Stop + start
./multiverse.sh status   # Show PID + port
./multiverse.sh log      # Tail log file
```

## Performance

| Operation | Benchmark | Notes |
|-----------|-----------|-------|
| Analyze (5000 nodes) | ~65s | Clone + parse + persist + link |
| Analyze (700 nodes) | ~20s | Including git clone |
| Edge persist (15K edges) | ~4s | Label-aware MERGE |
| Graph explore API | ~500ms | Fixed-depth hops, indexed |
| Business groups API | ~160ms | |
| Search API | ~140ms | |
| Sink detection (800 files) | ~200ms | Regex scan |
| Relink only | ~2s | Skip parse, re-run linking |

## Auto-Merge Behavior

When a new service is analyzed:
1. Its **Routes** are matched against existing API Transport nodes → `SERVES` edges created
2. Its **Listeners** (with resolved topics) are matched against Kafka Transport nodes → `SERVES` edges created
3. Its **sinks** create new Transport nodes → other services' Routes/Listeners may match
4. Cross-service links appear **automatically** — no manual configuration needed

Unmatched Transports (services not yet registered) are tracked and shown in the Service Map as pending connections.

## Adding Custom Sink Patterns

Use the Sink Patterns UI or API to add detection patterns for your codebase:

```json
{
  "id": "my-http-client",
  "name": "Custom HTTP Client",
  "category": "http",
  "methodPattern": "myClient\\.(get|post|put|delete)",
  "targetArgIndex": 0,
  "enabled": true
}
```

Supported categories: `http`, `kafka`, `rabbit`, `redis`.

## Adding Custom Graph Rules

Use the Graph Rules UI (`/rules`) or API to define language-agnostic entry point detection:

```json
{
  "id": "my-custom-job",
  "name": "My Custom Job Framework",
  "type": "job",
  "enabled": true,
  "match": [
    { "node": "cls", "label": "Class", "where": { "ancestors": { "edge": "EXTENDS", "label": "Class", "name": "BaseJobHandler", "maxDepth": 3 } } },
    { "node": "method", "label": "Method", "from": "cls", "edge": "HAS_METHOD", "where": { "name": "execute" } }
  ],
  "emit": { "name": "Job:${cls.name}", "topic": "${cls.name}" }
}
```

## Vision — Config as Single Source of Truth

All detection rules (sink patterns, listener annotations, entry point annotations, graph rules)
follow the same architecture:

1. **Built-in defaults** — hardcoded in TypeScript, cover common frameworks
2. **Config file** (`multiverse-config.yml`) — override/extend built-ins by `id`
3. **Neo4j persistence** — runtime CRUD via API, highest priority
4. **Web UI** — visual management for each rule type:
   - `/patterns` — Sink Patterns (producers)
   - `/rules` — Graph Rules (language-agnostic entry point detection)

Resolution order: Neo4j DB > config YAML > built-in defaults.
This means users can start with zero config, then progressively customize via UI.
