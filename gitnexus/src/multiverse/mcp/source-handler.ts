/**
 * Source MCP Tool Handler — read raw source code, class metadata, callers
 *
 * Actions: read, class, method, callers, grep
 * Enables LLM to read any source context directly instead of relying on hard-coded analyze logic.
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import fs from 'fs';
import path from 'path';
import { resolveServiceRepoPath } from '../util/repo-path.js';

export async function handleSource(params: Record<string, unknown>): Promise<unknown> {
  const { action } = params;
  switch (action) {
    case 'read':
      return sourceRead(params);
    case 'class':
      return sourceClass(params);
    case 'method':
      return sourceMethod(params);
    case 'callers':
      return sourceCallers(params);
    case 'grep':
      return sourceGrep(params);
    default:
      return { error: `Unknown action: ${action}. Use: read, class, method, callers, grep` };
  }
}

async function getRepoPath(service: string): Promise<string> {
  return (await resolveServiceRepoPath(service)).repoPath;
}

function readLines(filePath: string, start: number, end: number): string | null {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const s = Math.max(0, start - 1);
  const e = Math.min(lines.length, end);
  return lines
    .slice(s, e)
    .map((l, i) => `${s + i + 1}: ${l}`)
    .join('\n');
}

/** Validate resolved path is within repo root to prevent path traversal */
function validatePath(repoPath: string, file: string): string | null {
  const fullPath = path.join(repoPath, file);
  if (!fullPath.startsWith(path.resolve(repoPath))) return null;
  return fullPath;
}

/** Safely compile a user-provided regex, returning null on invalid/dangerous patterns */
function safeRegex(pattern: string, flags: string = 'gi'): RegExp | null {
  try {
    const re = new RegExp(pattern, flags);
    // Basic ReDoS guard: reject nested quantifiers
    if (/(\+|\*|\{)\s*\)?\s*(\+|\*|\{)/.test(pattern)) return null;
    return re;
  } catch {
    return null;
  }
}

// ── read: raw source lines ──

async function sourceRead(params: Record<string, unknown>) {
  const service = params.service as string;
  const file = params.file as string;
  const line = params.line as number | undefined;
  const range = Number(params.range || 30);
  if (!service || !file) return { error: 'Required: service, file' };

  const repoPath = await getRepoPath(service);
  const fullPath = validatePath(repoPath, file);
  if (!fullPath || !fs.existsSync(fullPath)) return { error: `File not found: ${file}` };

  const allLines = fs.readFileSync(fullPath, 'utf-8').split('\n');
  const totalLines = allLines.length;
  const center = line || 1;
  const start = Math.max(1, center - Math.floor(range / 2));
  const end = Math.min(totalLines, start + range);
  const content = allLines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}: ${l}`)
    .join('\n');

  return { file, start, end, totalLines, content };
}

// ── class: metadata, fields, @Value annotations, injected beans ──

async function sourceClass(params: Record<string, unknown>) {
  const service = params.service as string;
  const file = params.file as string | undefined;
  const className = params.className as string | undefined;
  const includeSource = !!params.includeSource;
  if (!service) return { error: 'Required: service' };
  if (!file && !className) return { error: 'Required: file or className' };

  const backend = await getGraphBackend();

  // Find class node
  const classQuery = file
    ? `MATCH (c:Class {repoId: $svc}) WHERE c.filePath CONTAINS $file RETURN c.id AS id, c.name AS name, c.filePath AS filePath, c.startLine AS startLine, c.annotations AS annotations LIMIT 1`
    : `MATCH (c:Class {repoId: $svc}) WHERE n.name = $name RETURN c.id AS id, c.name AS name, c.filePath AS filePath, c.startLine AS startLine, c.annotations AS annotations LIMIT 1`;
  const classRows = (await backend
    .executeQuery(classQuery, file ? { svc: service, file } : { svc: service, name: className })
    .catch(() => [])) as Array<Record<string, unknown>>;
  if (!classRows.length) return { error: 'Class not found' };
  const cls = classRows[0];

  // Get fields (properties) with annotations
  const fields = await backend
    .executeQuery(
      `MATCH (c:Class {id: $cid})-[:CodeRelation {type:'CONTAINS'}]->(p:Property)
       RETURN p.name AS name, p.type AS type, p.annotations AS annotations
       ORDER BY p.startLine`,
      { cid: cls.id },
    )
    .catch(() => []);

  // Get methods
  const methods = await backend
    .executeQuery(
      `MATCH (c:Class {id: $cid})-[:CodeRelation {type:'CONTAINS'}]->(m:Method)
       RETURN m.id AS id, m.name AS name, m.startLine AS line, m.annotations AS annotations
       ORDER BY m.startLine`,
      { cid: cls.id },
    )
    .catch(() => []);

  // Extract @Value fields and injected beans from source
  const repoPath = await getRepoPath(service);
  const fullPath = validatePath(repoPath, String(cls.filePath || ''));
  const valueFields: Array<{ field: string; key: string; defaultValue?: string }> = [];
  const injectedBeans: string[] = [];
  let configPrefix: string | null = null;
  let sourceCode: string | null = null;

  if (fullPath && fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    if (includeSource) {
      // Cap at 200 lines to avoid token explosion on large files (e.g. 1800-line UseCaseImpl)
      const maxLines = 200;
      if (lines.length <= maxLines) {
        sourceCode = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
      } else {
        sourceCode =
          lines
            .slice(0, maxLines)
            .map((l, i) => `${i + 1}: ${l}`)
            .join('\n') +
          `\n... (truncated, ${lines.length} total lines. Use source(read) for specific ranges)`;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // @ConfigurationProperties(prefix = "...")
      const cpMatch = line.match(/@ConfigurationProperties\s*\(\s*prefix\s*=\s*"([^"]+)"/);
      if (cpMatch) configPrefix = cpMatch[1];

      // @Value("${key:default}")
      const valMatch = line.match(/@Value\s*\(\s*(?:value\s*=\s*)?"([^"]+)"\s*\)/);
      if (valMatch) {
        const keyMatch = valMatch[1].match(/\$\{([^}]+)\}/);
        if (keyMatch) {
          const [key, def] = keyMatch[1].split(':');
          // Find field name on next lines
          for (let j = i; j < Math.min(i + 3, lines.length); j++) {
            const fieldMatch = lines[j].match(/(?:private|protected|public)?\s*\w+\s+(\w+)\s*[;=]/);
            if (fieldMatch) {
              valueFields.push({
                field: fieldMatch[1],
                key: key.trim(),
                defaultValue: def?.trim(),
              });
              break;
            }
          }
        }
      }
      // Constructor injection / @Autowired
      if (line.includes('private final') && line.includes(';')) {
        const beanMatch = line.match(/private\s+final\s+(\w+)\s+(\w+)/);
        if (beanMatch) injectedBeans.push(`${beanMatch[1]} ${beanMatch[2]}`);
      }
    }
  }

  // Interfaces implemented
  const interfaces = await backend
    .executeQuery(
      `MATCH (c:Class {id: $cid})-[:CodeRelation {type:'IMPLEMENTS'}]->(i:Interface)
       RETURN i.name AS name`,
      { cid: cls.id },
    )
    .catch(() => []);

  const result: Record<string, unknown> = {
    class: { id: cls.id, name: cls.name, file: cls.filePath, annotations: cls.annotations },
    valueFields,
    injectedBeans,
    fields: (fields as any[]).map((f) => ({
      name: f.name,
      type: f.type,
      annotations: f.annotations,
    })),
    methods: (methods as any[]).map((m) => ({
      id: m.id,
      name: m.name,
      line: m.line,
      annotations: m.annotations,
    })),
    interfaces: (interfaces as any[]).map((i) => i.name),
  };
  if (configPrefix) result.configPrefix = configPrefix;
  if (sourceCode) result.source = sourceCode;
  return result;
}

// ── method: body + annotations ──

async function sourceMethod(params: Record<string, unknown>) {
  const service = params.service as string;
  const nodeId = params.nodeId as string | undefined;
  const name = params.name as string | undefined;
  const file = params.file as string | undefined;
  if (!service) return { error: 'Required: service' };
  if (!nodeId && !name) return { error: 'Required: nodeId or name' };

  const backend = await getGraphBackend();
  const query = nodeId
    ? `MATCH (m:Method {id: $id}) RETURN m.id AS id, m.name AS name, m.filePath AS filePath, m.startLine AS startLine, m.endLine AS endLine, m.annotations AS annotations, m.qualifiedName AS qualifiedName`
    : file
      ? `MATCH (m:Method {repoId: $svc}) WHERE m.name = $name AND m.filePath CONTAINS $file RETURN m.id AS id, m.name AS name, m.filePath AS filePath, m.startLine AS startLine, m.endLine AS endLine, m.annotations AS annotations, m.qualifiedName AS qualifiedName LIMIT 1`
      : `MATCH (m:Method {repoId: $svc}) WHERE m.name = $name RETURN m.id AS id, m.name AS name, m.filePath AS filePath, m.startLine AS startLine, m.endLine AS endLine, m.annotations AS annotations, m.qualifiedName AS qualifiedName LIMIT 3`;

  const qp: Record<string, unknown> = { svc: service };
  if (nodeId) qp.id = nodeId;
  if (name) qp.name = name;
  if (file) qp.file = file;

  const rows = (await backend.executeQuery(query, qp).catch(() => [])) as Array<
    Record<string, unknown>
  >;
  if (!rows.length) return { error: 'Method not found' };

  const repoPath = await getRepoPath(service);
  const results = rows.map((m: any) => {
    const fullPath = path.join(repoPath, m.filePath);
    const body =
      m.startLine && m.endLine
        ? readLines(fullPath, Math.max(1, m.startLine - 2), m.endLine + 1)
        : readLines(fullPath, m.startLine || 1, (m.startLine || 1) + 30);
    return {
      id: m.id,
      name: m.name,
      file: m.filePath,
      line: m.startLine,
      annotations: m.annotations,
      qualifiedName: m.qualifiedName,
      body,
    };
  });

  return results.length === 1 ? results[0] : { methods: results };
}

// ── callers: who calls a method, with call-site snippet ──

async function sourceCallers(params: Record<string, any>) {
  const { service, nodeId, name, file, limit = 20 } = params;
  if (!service) return { error: 'Required: service' };
  if (!nodeId && !name) return { error: 'Required: nodeId or name' };

  const backend = await getGraphBackend();

  // Resolve target method ID
  let targetId = nodeId;
  if (!targetId) {
    const findQ = file
      ? `MATCH (m:Method {repoId: $svc}) WHERE m.name = $name AND m.filePath CONTAINS $file RETURN m.id AS id LIMIT 1`
      : `MATCH (m:Method {repoId: $svc}) WHERE m.name = $name RETURN m.id AS id LIMIT 1`;
    const found = await backend.executeQuery(findQ, { svc: service, name, file }).catch(() => []);
    if (!found.length) return { error: 'Method not found' };
    targetId = found[0].id;
  }

  const callers = await backend
    .executeQuery(
      `MATCH (caller:Method)-[:CodeRelation {type:'CALLS'}]->(m:Method {id: $mid})
       RETURN caller.id AS id, caller.name AS name, caller.filePath AS file,
              caller.startLine AS startLine, caller.endLine AS endLine, caller.repoId AS service
       LIMIT $lim`,
      { mid: targetId, lim: Math.min(Number(limit), 50) },
    )
    .catch(() => []);

  const repoPath = await getRepoPath(service);
  const results = callers.map((c: any) => {
    const callerRepoPath = c.service === service ? repoPath : null;
    let snippet: string | null = null;
    if (callerRepoPath) {
      const fullPath = path.join(callerRepoPath, c.file);
      snippet = readLines(fullPath, c.startLine || 1, c.endLine || (c.startLine || 1) + 20);
    }
    return { id: c.id, name: c.name, file: c.file, service: c.service, line: c.startLine, snippet };
  });

  return { target: targetId, callers: results, total: results.length };
}

// ── grep: regex search in service source files ──

async function sourceGrep(params: Record<string, any>) {
  const { service, pattern, filePattern, maxResults = 30 } = params;
  if (!service || !pattern) return { error: 'Required: service, pattern' };

  const repoPath = await getRepoPath(service);
  const srcDir = path.join(repoPath, 'src', 'main');
  if (!fs.existsSync(srcDir)) return { error: 'Source directory not found' };

  const regex = safeRegex(pattern, 'gi');
  if (!regex) return { error: 'Invalid or unsafe regex pattern' };
  const fileRegex = filePattern ? safeRegex(filePattern, 'i') : null;
  const matches: Array<{ file: string; line: number; content: string }> = [];

  const walk = (dir: string) => {
    if (matches.length >= maxResults) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (matches.length >= maxResults) return;
      const full = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !['test', 'node_modules', '.git', 'target', 'build'].includes(entry.name)
      ) {
        walk(full);
      } else if (/\.(java|kt|xml|yml|yaml|properties)$/.test(entry.name)) {
        const relPath = path.relative(repoPath, full).replace(/\\/g, '/');
        if (fileRegex && !fileRegex.test(relPath)) continue;
        let content: string;
        try {
          content = fs.readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: relPath, line: i + 1, content: lines[i].trim() });
            regex.lastIndex = 0;
            if (matches.length >= maxResults) return;
          }
        }
      }
    }
  };
  walk(srcDir);

  return { pattern, matches, total: matches.length, truncated: matches.length >= maxResults };
}
