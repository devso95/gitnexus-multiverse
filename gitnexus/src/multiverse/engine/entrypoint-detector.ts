/**
 * Entry Point Detector v2 — scan source for ALL entry point types:
 *
 * 1. Routes: @RequestMapping, @GetMapping, @PostMapping, etc.
 *    - Combines class-level prefix + method-level path
 * 2. Listeners: @KafkaListener, @RabbitListener, @EventListener, Redis MessageListener
 *    - Extracts topic from annotation attributes
 * 3. Scheduled: @Scheduled, @Job, @Recurring (configurable)
 *
 * Creates Route + Listener nodes in Neo4j so business-grouper can find them.
 *
 * WHY: Core GitNexus tree-sitter queries don't capture Java annotations as
 * @decorator (Java uses `annotation`/`marker_annotation` AST nodes, not `decorator`).
 * This module fills that gap with regex-based source scanning.
 */

import fs from 'fs';
import path from 'path';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import type { EntryPointAnnotation, ListenerAnnotation } from './sink-patterns.js';
import { matchesAnnotationApplicability, matchesEntryPointApplicability } from './sink-patterns.js';
import { mvLog } from '../util/logger.js';
import {
  findMultiverseSourceFiles,
  sanitizeSourceLines,
  detectSourceLanguage,
} from './source-file-utils.js';

const LOG = 'ep-detector';

// ── Types ──

interface DetectedRoute {
  id: string;
  repoId: string;
  name: string; // full path e.g. /api/v1/users/account
  httpMethod: string;
  controllerName: string;
  filePath: string;
  startLine: number;
}

interface DetectedListener {
  id: string;
  repoId: string;
  name: string;
  listenerType: string; // kafka, rabbit, event, redis, scheduled, job
  topic: string;
  filePath: string;
  startLine: number;
  className: string;
}

// ── Source scanning ──

const findSourceFiles = (dir: string): string[] => findMultiverseSourceFiles(dir);

// ── Route detection ──

/** HTTP method mapping annotations (Spring MVC) */
const METHOD_ANNOTATIONS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'ALL',
};

/** JAX-RS standalone HTTP method annotations (Quarkus / Jakarta EE) */
const JAX_RS_METHOD_ANNOTATIONS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
] as const;

/** Extract path from annotation: @GetMapping("/path") or @GetMapping(value="/path") or @GetMapping(path={"/p1","/p2"}) */
function extractAnnotationPaths(line: string, nextLines: string[]): string[] {
  // Join current + next few lines for multi-line annotations
  const block = [line, ...nextLines.slice(0, 4)].join(' ');

  // Simple: @GetMapping("/path")
  const simple = block.match(/@\w+Mapping\s*\(\s*"([^"]+)"/);
  if (simple) return [simple[1]];

  // Named: @RequestMapping(value = "/path") or @RequestMapping(path = "/path")
  const named = block.match(/(?:value|path)\s*=\s*"([^"]+)"/);
  if (named) return [named[1]];

  // Array: @RequestMapping({"/p1", "/p2"}) or @RequestMapping(value = {"/p1", "/p2"})
  const arrayMatch = block.match(/\{([^}]+)\}/);
  if (arrayMatch) {
    return [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  // No path = root
  return [''];
}

/** Extract JAX-RS @Path value from a line: @Path("/some/path") */
function extractJaxRsPath(line: string): string | null {
  const m = line.match(/@Path\s*\(\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Find the @Path sub-path for a JAX-RS method by scanning nearby lines.
 * Looks up to 4 lines before and after `lineIdx` for a `@Path("...")` annotation.
 */
function findJaxRsMethodPath(lines: string[], lineIdx: number, classLine: number): string {
  const start = Math.max(classLine + 1, lineIdx - 4);
  const end = Math.min(lines.length - 1, lineIdx + 4);
  for (let k = start; k <= end; k++) {
    if (k === lineIdx) continue;
    const p = extractJaxRsPath(lines[k].trim());
    if (p !== null) return p;
  }
  return '';
}

/** Detect Route entry points from @RequestMapping/@GetMapping etc. (Spring MVC) and
 *  @Path + @GET/@POST/... (JAX-RS / Quarkus) */
function detectRoutes(serviceId: string, repoPath: string): DetectedRoute[] {
  const files = findSourceFiles(repoPath);
  const routes: DetectedRoute[] = [];

  for (const file of files) {
    const relPath = path.relative(repoPath, file).split(path.sep).join('/');
    const language = detectSourceLanguage(relPath);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const sanitizedLines = sanitizeSourceLines(lines);

    if (language === 'javascript' || language === 'typescript') {
      for (let i = 0; i < lines.length; i++) {
        const sanitizedLine = sanitizedLines[i];
        const methodMatch = sanitizedLine.match(
          /\b(?:app|router|server)\.(get|post|put|delete|patch|head|options|all)\s*\(/i,
        );
        if (!methodMatch) continue;
        const pathMatch = lines[i].match(
          /\b(?:app|router|server)\.(?:get|post|put|delete|patch|head|options|all)\s*\(\s*(["'`])([^"'`]+)\1/i,
        );
        if (!pathMatch) continue;
        routes.push({
          id: `Route:${relPath}:${methodMatch[1].toUpperCase()}:${pathMatch[2]}:${i + 1}`,
          repoId: serviceId,
          name: pathMatch[2],
          httpMethod: methodMatch[1].toUpperCase(),
          controllerName: path.basename(relPath),
          filePath: relPath,
          startLine: i + 1,
        });
      }
      continue;
    }

    if (language !== 'java' && language !== 'kotlin') continue;

    // Phase 1: Find class-level prefix + class name
    let classPrefix: string[] = [];
    let className = '';
    let classLine = -1;
    let isController = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const sanitizedLine = sanitizedLines[i].trim();

      // Spring MVC: @RestController or @Controller
      if (/@(?:Rest)?Controller\b/.test(sanitizedLine)) isController = true;

      // Spring MVC: class-level @RequestMapping before class declaration
      if (/@RequestMapping/.test(sanitizedLine) && classLine < 0) {
        classPrefix = extractAnnotationPaths(lines[i], lines.slice(i + 1));
      }

      // JAX-RS: class-level @Path — marks this as a JAX-RS resource class
      if (classLine < 0 && /@Path\s*\(/.test(sanitizedLine)) {
        const p = extractJaxRsPath(line);
        if (p !== null) {
          classPrefix = [p];
          isController = true; // treat JAX-RS resource classes as controllers
        }
      }

      // Class declaration
      const classMatch = line.match(/(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch && classLine < 0) {
        className = classMatch[1];
        classLine = i;
        break; // stop after first class
      }
    }

    if (!isController || classLine < 0) continue;

    // Phase 2: Find method-level annotations (AFTER class declaration)
    for (let i = classLine + 1; i < lines.length; i++) {
      const sanitizedLine = sanitizedLines[i].trim();

      // ── Spring MVC: @GetMapping, @PostMapping, etc. ──
      for (const [ann, method] of Object.entries(METHOD_ANNOTATIONS)) {
        if (!sanitizedLine.includes(`@${ann}`)) continue;

        const methodPaths = extractAnnotationPaths(lines[i], lines.slice(i + 1));
        const httpMethod =
          ann === 'RequestMapping'
            ? extractHttpMethod(lines[i], lines.slice(i + 1)) || 'GET'
            : method;

        // Combine class prefix + method path
        const prefixes = classPrefix.length ? classPrefix : [''];
        for (const prefix of prefixes) {
          for (const mp of methodPaths) {
            const fullPath = joinPath(prefix, mp);
            const id = `Route:${relPath}:${httpMethod}:${fullPath}`;
            routes.push({
              id,
              repoId: serviceId,
              name: fullPath,
              httpMethod,
              controllerName: className,
              filePath: relPath,
              startLine: i + 1,
            });
          }
        }
      }

      // ── JAX-RS: standalone @GET, @POST, @PUT, @DELETE, @PATCH, @HEAD, @OPTIONS ──
      // These annotations don't carry the path — path comes from a nearby @Path annotation.
      for (const httpMethod of JAX_RS_METHOD_ANNOTATIONS) {
        // Must match @GET (etc.) as a standalone annotation — not @GetMapping or inside a word
        if (!new RegExp(`@${httpMethod}\\b`).test(sanitizedLine)) continue;
        // Skip Spring MVC mappings that may contain the same letters
        if (/Mapping/.test(sanitizedLine)) continue;

        // Find method-level @Path in adjacent lines (may also be absent = use class path only)
        const methodPath = findJaxRsMethodPath(lines, i, classLine);

        const prefixes = classPrefix.length ? classPrefix : [''];
        for (const prefix of prefixes) {
          const fullPath = joinPath(prefix, methodPath);
          // De-duplicate: include line number to distinguish multiple methods with same path
          const id = `Route:${relPath}:${httpMethod}:${fullPath}:${i + 1}`;
          routes.push({
            id,
            repoId: serviceId,
            name: fullPath,
            httpMethod,
            controllerName: className,
            filePath: relPath,
            startLine: i + 1,
          });
        }
      }
    }
  }

  return routes;
}

/** Extract HTTP method from @RequestMapping(method = RequestMethod.POST) */
function extractHttpMethod(line: string, nextLines: string[]): string | null {
  const block = [line, ...nextLines.slice(0, 3)].join(' ');
  const m = block.match(/method\s*=\s*RequestMethod\.(\w+)/);
  return m ? m[1] : null;
}

function joinPath(prefix: string, sub: string): string {
  const p = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const s = sub.replace(/^\/+/, '');
  if (!p) return `/${s}`;
  return `/${p}/${s}`.replace(/\/+$/, '');
}

// ── Listener detection ──

// ── SOAP / @WebService detection ──

/** Detect SOAP entry points from @WebService interfaces and their implementations */
function detectSoapEndpoints(serviceId: string, repoPath: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];

  // Step 1: Scan XML for <jaxws:endpoint address="/FOService" implementor="#foService" />
  const xmlEndpoints: Array<{ address: string; beanId: string; file: string }> = [];
  const xmlFiles = findXmlFiles(repoPath);
  for (const xf of xmlFiles) {
    let content: string;
    try {
      content = fs.readFileSync(xf, 'utf-8');
    } catch {
      continue;
    }
    // Match both attribute orders
    const re = /<jaxws:endpoint[^>]+>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[0].includes('<!--')) continue;
      const addr = m[0].match(/address="([^"]+)"/);
      const impl = m[0].match(/implementor="[#]?(\w+)"/);
      if (addr && impl) {
        xmlEndpoints.push({
          address: addr[1],
          beanId: impl[1],
          file: path.relative(repoPath, xf).replace(/\\/g, '/'),
        });
      }
    }
  }

  // Step 2: Map bean IDs to implementation class names from <bean id="..." class="...">
  const beanToClass = new Map<string, string>();
  for (const xf of xmlFiles) {
    let content: string;
    try {
      content = fs.readFileSync(xf, 'utf-8');
    } catch {
      continue;
    }
    const re = /<bean\s+id="(\w+)"\s+class="([^"]+)"/g;
    let m2: RegExpExecArray | null;
    while ((m2 = re.exec(content)) !== null) {
      const simpleName = m2[2].split('.').pop() || '';
      beanToClass.set(m2[1], simpleName);
    }
  }

  // Step 3: Create a route per CXF endpoint address (catch-all for SOAP matching)
  for (const ep of xmlEndpoints) {
    const implClass = beanToClass.get(ep.beanId) || ep.beanId;
    routes.push({
      id: `Route:${ep.file}:SOAP:${ep.address}`,
      repoId: serviceId,
      name: ep.address,
      httpMethod: 'SOAP',
      controllerName: implClass,
      filePath: ep.file,
      startLine: 1,
    });
  }

  // Step 4: Scan @WebService interfaces/classes for per-method routes
  const files = findSourceFiles(repoPath);
  for (const file of files) {
    const relPath = path.relative(repoPath, file).replace(/\\/g, '/');
    const language = detectSourceLanguage(relPath);
    if (language !== 'java' && language !== 'kotlin') continue;
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (!content.includes('@WebService')) continue;

    const lines = content.split('\n');
    let className = '';
    let isWebService = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes('@WebService')) isWebService = true;
      const cm = line.match(/(?:public\s+)?(?:interface|class)\s+(\w+)/);
      if (cm) {
        className = cm[1];
        break;
      }
    }
    if (!isWebService || !className) continue;

    // Find CXF address for this class: match impl class or interface name (strip leading I)
    const classLower = className.toLowerCase();
    const stripped = className.replace(/^I/, '').toLowerCase();
    let cxfAddress = `/ws/${className}`;
    for (const ep of xmlEndpoints) {
      const implLower = (beanToClass.get(ep.beanId) || '').toLowerCase();
      if (
        implLower === classLower ||
        implLower === stripped ||
        implLower.includes(stripped) ||
        stripped.includes(implLower)
      ) {
        cxfAddress = ep.address;
        break;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const mm = line.match(/(?:public\s+)?\S+\s+(\w+)\s*\(/);
      if (mm && !mm[1].match(/^(class|interface|package|import)$/)) {
        const methodName = mm[1];
        const soapPath = `${cxfAddress}/${methodName}`;
        routes.push({
          id: `Route:${relPath}:SOAP:${soapPath}`,
          repoId: serviceId,
          name: soapPath,
          httpMethod: 'SOAP',
          controllerName: className,
          filePath: relPath,
          startLine: i + 1,
        });
      }
    }
  }

  return routes;
}

function findXmlFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (d: string) => {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== 'target'
        ) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.xml')) {
          results.push(full);
        }
      }
    } catch {}
  };
  const resDir = path.join(dir, 'src');
  walk(fs.existsSync(resDir) ? resDir : dir);
  return results;
}

/** Detect Listener entry points from @KafkaListener, @RabbitListener, @EventListener, Redis MessageListener */
function detectListeners(
  serviceId: string,
  repoPath: string,
  listenerAnnotations: ListenerAnnotation[],
): DetectedListener[] {
  const enabled = listenerAnnotations.filter((a) => a.enabled);
  if (!enabled.length) return [];

  const files = findSourceFiles(repoPath);
  const listeners: DetectedListener[] = [];

  for (const file of files) {
    const relPath = path.relative(repoPath, file).split(path.sep).join('/');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const sanitizedLines = sanitizeSourceLines(lines);
    const applicableAnnotations = enabled.filter((annotation) =>
      matchesAnnotationApplicability(annotation, relPath),
    );
    if (!applicableAnnotations.length) continue;
    let className = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const sanitizedLine = sanitizedLines[i];

      // Track class name
      const cm = line.match(/(?:class|interface)\s+(\w+)/);
      if (cm) className = cm[1];

      // Check for listener annotations
      for (const config of applicableAnnotations) {
        const annName = config.annotation;
        if (!sanitizedLine.includes(`@${annName}`)) continue;

        // Extract topic from annotation
        let topic = '';
        const block = lines.slice(i, Math.min(i + 5, lines.length)).join(' ');

        // Extract all quoted strings from the annotation block
        const allStrings = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

        if (config.topicAttribute && allStrings.length) {
          // For @KafkaListener(topics = "xxx") — find string after topics =
          const attrIdx = block.indexOf(config.topicAttribute);
          if (attrIdx >= 0) {
            // Get strings that appear after the attribute name
            const afterAttr = block.slice(attrIdx);
            const topicStrings = [...afterAttr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
            topic = topicStrings[0] || '';
          } else {
            topic = allStrings[0] || '';
          }
        }
        if (!topic && allStrings.length) {
          topic = allStrings[0];
        }

        // Find method name
        let methodName = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const mm = lines[j].match(/(?:public|private|protected|void)\s+\S*\s*(\w+)\s*\(/);
          if (mm) {
            methodName = mm[1];
            break;
          }
        }

        const name = `@${annName}(${topic || methodName})`;
        const id = `Listener:${relPath}:${name}:${i + 1}`;
        if (topic) mvLog.info(LOG, `  ${annName}: topic="${topic}" method=${methodName}`);
        listeners.push({
          id,
          repoId: serviceId,
          name,
          listenerType: config.type,
          topic,
          filePath: relPath,
          startLine: i + 1,
          className,
        });
      }
    }

    // Special: Redis MessageListener (implements MessageListener, onMessage method)
    if (content.includes('implements MessageListener')) {
      const cm = content.match(/class\s+(\w+)\s+implements\s+MessageListener/);
      if (cm) {
        const id = `Listener:${relPath}:redis:${cm[1]}`;
        listeners.push({
          id,
          repoId: serviceId,
          name: `Redis:${cm[1]}`,
          listenerType: 'redis',
          topic: '',
          filePath: relPath,
          startLine: 1,
          className: cm[1],
        });
      }
    }
  }

  return listeners;
}

// ── Scheduled/Job detection ──

function detectScheduled(
  serviceId: string,
  repoPath: string,
  epAnnotations: EntryPointAnnotation[],
): DetectedListener[] {
  const enabled = epAnnotations.filter((a) => a.enabled);
  if (!enabled.length) return [];

  const files = findSourceFiles(repoPath);
  const results: DetectedListener[] = [];

  for (const file of files) {
    const relPath = path.relative(repoPath, file).split(path.sep).join('/');
    const applicableAnnotations = enabled.filter((annotation) =>
      matchesEntryPointApplicability(annotation, relPath),
    );
    if (!applicableAnnotations.length) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const sanitizedLines = sanitizeSourceLines(lines);
    let className = '';

    const annNames = applicableAnnotations.map((a) => a.annotation);
    const regex = new RegExp(`@(${annNames.join('|')})\\b`, 'g');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const sanitizedLine = sanitizedLines[i];
      const cm = line.match(/(?:class|interface)\s+(\w+)/);
      if (cm) className = cm[1];

      regex.lastIndex = 0;
      const match = regex.exec(sanitizedLine);
      if (!match) continue;

      const annName = match[1];
      const config = applicableAnnotations.find((a) => a.annotation === annName);
      if (!config) continue;

      // Extract schedule expression
      let schedule = '';
      const block = lines.slice(i, Math.min(i + 4, lines.length)).join(' ');
      const cronMatch = block.match(/cron\s*=\s*"([^"]*)"/);
      const valueMatch = block.match(/@\w+\s*\(\s*"([^"]*)"/);
      schedule = cronMatch?.[1] || valueMatch?.[1] || '';

      let methodName = '';
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const mm = lines[j].match(/(?:public|private|protected|void)\s+\S*\s*(\w+)\s*\(/);
        if (mm) {
          methodName = mm[1];
          break;
        }
      }

      const name = `@${annName}(${methodName || 'line_' + (i + 1)})`;
      const id = `Listener:${relPath}:${name}:${i + 1}`;
      results.push({
        id,
        repoId: serviceId,
        name,
        listenerType: config.type,
        topic: schedule || methodName,
        filePath: relPath,
        startLine: i + 1,
        className,
      });
    }
  }

  return results;
}

// ── Public API ──

export interface EntryPointResult {
  routes: number;
  listeners: number;
  scheduled: number;
}

export interface CollectedEntryPoints {
  routes: DetectedRoute[];
  listeners: DetectedListener[];
  scheduled: DetectedListener[];
}

export const collectEntryPoints = (
  serviceId: string,
  repoPath: string,
  listenerAnnotations: ListenerAnnotation[],
  epAnnotations: EntryPointAnnotation[],
): CollectedEntryPoints => {
  const routes = detectRoutes(serviceId, repoPath);
  routes.push(...detectSoapEndpoints(serviceId, repoPath));
  const listeners = detectListeners(serviceId, repoPath, listenerAnnotations);
  const scheduled = detectScheduled(serviceId, repoPath, epAnnotations);
  return { routes, listeners, scheduled };
};

/** Detect all entry points and persist to Neo4j */
export const detectAndPersistEntryPoints = async (
  serviceId: string,
  repoPath: string,
  listenerAnnotations: ListenerAnnotation[],
  epAnnotations: EntryPointAnnotation[],
): Promise<EntryPointResult> => {
  const { routes, listeners, scheduled } = collectEntryPoints(
    serviceId,
    repoPath,
    listenerAnnotations,
    epAnnotations,
  );

  const backend = await getGraphBackend();
  const BATCH = 200;

  // Persist Routes
  for (let i = 0; i < routes.length; i += BATCH) {
    const batch = routes.slice(i, i + BATCH).map((r) => ({
      id: r.id,
      repoId: r.repoId,
      name: r.name,
      routePath: r.name,
      httpMethod: r.httpMethod,
      controllerName: r.controllerName,
      filePath: r.filePath,
      startLine: r.startLine,
    }));
    await backend
      .executeQuery(
        `UNWIND $batch AS props
       MERGE (r:Route {id: props.id})
       SET r += props`,
        { batch },
      )
      .catch((err: unknown) => mvLog.warn(LOG, `Failed to persist routes batch`, err));
  }

  // Persist Listeners (messaging + scheduled)
  const allListeners = [...listeners, ...scheduled];
  for (let i = 0; i < allListeners.length; i += BATCH) {
    const batch = allListeners.slice(i, i + BATCH).map((l) => ({
      id: l.id,
      repoId: l.repoId,
      name: l.name,
      listenerType: l.listenerType,
      topic: l.topic,
      filePath: l.filePath,
      startLine: l.startLine,
      className: l.className,
    }));
    await backend
      .executeQuery(
        `UNWIND $batch AS props
       MERGE (l:Listener {id: props.id})
       SET l += props`,
        { batch },
      )
      .catch((err: unknown) => mvLog.warn(LOG, `Failed to persist listeners batch`, err));
  }

  mvLog.info(
    LOG,
    `${serviceId}: ${routes.length} routes, ${listeners.length} listeners, ${scheduled.length} scheduled`,
  );

  // Create HANDLES_ROUTE edges: File → Route, Method → Route
  const allEntryPoints = [
    ...routes.map((r) => ({
      id: r.id,
      filePath: r.filePath,
      startLine: r.startLine,
      label: 'Route',
    })),
    ...allListeners.map((l) => ({
      id: l.id,
      filePath: l.filePath,
      startLine: l.startLine,
      label: 'Listener',
    })),
  ];
  for (let i = 0; i < allEntryPoints.length; i += BATCH) {
    const batch = allEntryPoints.slice(i, i + BATCH).map((ep) => ({
      epId: ep.id,
      filePath: ep.filePath,
      startLine: ep.startLine,
      repoId: serviceId,
    }));
    // Link File → Route/Listener
    await backend
      .executeQuery(
        `UNWIND $batch AS b
       MATCH (f:File {repoId: b.repoId}) WHERE f.filePath = b.filePath OR f.name = b.filePath
       MATCH (ep {id: b.epId})
       MERGE (f)-[:CodeRelation {type: 'HANDLES_ROUTE'}]->(ep)`,
        { batch },
      )
      .catch(() => {});
    // Link nearest Method → Route/Listener
    await backend
      .executeQuery(
        `UNWIND $batch AS b
       MATCH (m:Method {repoId: b.repoId})
       WHERE m.filePath = b.filePath AND m.startLine <= b.startLine AND m.endLine >= b.startLine
       MATCH (ep {id: b.epId})
       MERGE (m)-[:CodeRelation {type: 'HANDLES_ROUTE'}]->(ep)`,
        { batch },
      )
      .catch(() => {});
  }

  return { routes: routes.length, listeners: listeners.length, scheduled: scheduled.length };
};
