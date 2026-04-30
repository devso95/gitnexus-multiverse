/**
 * Sinks MCP Tool Handler — unified sink management
 *
 * Actions: list, analyze, resolve (batch), promote, fan-out, llm-resolve
 * Replaces: find-unresolved, resolve-sink, sink-context
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { saveManualResolution } from '../engine/manual-resolutions.js';
import { resolveServiceRepoPath } from '../util/repo-path.js';

const _LOG = 'sinks-handler';

/** Escape string for use in RegExp constructor */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function handleSinks(params: Record<string, unknown>): Promise<unknown> {
  const { action } = params;
  switch (action) {
    case 'list':
      return sinksList(params);
    case 'analyze':
      return sinksAnalyze(params);
    case 'resolve':
      return sinksResolve(params);
    case 'promote':
      return sinksPromote(params);
    case 'fan-out':
      return sinksFanOut(params);
    case 'llm-resolve':
      return sinksLlmResolve(params);
    default:
      return {
        error: `Unknown action: ${action}. Use: list, analyze, resolve, promote, fan-out, llm-resolve`,
      };
  }
}

// ── list — rich filters + groupBy + optional enrich ──

async function sinksList(params: Record<string, any>) {
  const { service, status, type, category, groupBy, limit = 50, enrich = false } = params;
  const backend = await getGraphBackend();

  const conditions: string[] = [];
  const qp: Record<string, any> = {};

  if (service) {
    conditions.push('d.repoId = $service');
    qp.service = service;
  }
  if (status === 'unresolved') {
    conditions.push("(d.confidence < 0.5 OR d.resolvedVia = 'unresolvable' OR d.resolvedVia = '')");
  } else if (status === 'resolved') {
    conditions.push('d.confidence >= 0.5');
  }
  if (type) {
    conditions.push('d.sinkType = $type');
    qp.type = type;
  }
  if (category) {
    conditions.push('d.sinkCategory = $category');
    qp.category = category;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = (await backend
    .executeQuery(
      `MATCH (d:DetectedSink) ${where}
       RETURN d.id AS id, d.repoId AS service, d.sinkType AS type,
              d.targetExpression AS target, d.calleeMethod AS method,
              d.callSiteMethod AS callSiteMethod, d.filePath AS file,
              d.lineNumber AS line, d.confidence AS confidence,
              d.resolvedVia AS resolvedVia, d.resolvedUrl AS resolvedUrl,
              d.resolvedTopic AS resolvedTopic, d.patternId AS patternId,
              d.sinkCategory AS sinkCategory, d.callSiteNodeId AS callSiteNodeId
       ORDER BY d.confidence ASC
       LIMIT ${Math.min(Number(limit), 200)}`,
      qp,
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  // Enrich: attach source context + class metadata per unique file
  let fileContext: Record<string, any> | undefined;
  if (enrich && service && rows.length > 0) {
    fileContext = await enrichSinksWithContext(rows, service);
  }

  if (groupBy === 'calleeMethod') {
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = String(r.method || 'unknown');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const grouped = [...groups.entries()].map(([method, sinks]) => {
      const isWrapper =
        sinks.length >= 2 &&
        sinks.some((s) => {
          const t = (s.target as string) || '';
          return /^\w+$/.test(t) && !t.includes('$') && !t.includes('"');
        });
      return {
        calleeMethod: method,
        file: sinks[0]?.file as string,
        sinks,
        count: sinks.length,
        isWrapper,
        hint: isWrapper
          ? 'Wrapper pattern detected. Use action=promote or action=fan-out to resolve callers.'
          : undefined,
      };
    });
    const result: Record<string, unknown> = { groups: grouped, total: rows.length };
    if (fileContext) result.fileContext = fileContext;
    return result;
  }

  const result: Record<string, unknown> = { sinks: rows, total: rows.length };
  if (fileContext) result.fileContext = fileContext;
  return result;
}

/**
 * Enrich sinks with source context and class-level metadata.
 * Reads each unique file ONCE, then attaches sourceSnippet per sink.
 * Returns fileContext map (classInfo per file) separately to avoid duplication.
 */
async function enrichSinksWithContext(
  sinks: Record<string, any>[],
  service: string,
): Promise<Record<string, unknown>> {
  const pathMod = await import('path');
  const fs = await import('fs');
  const repoPath = (await resolveServiceRepoPath(service)).repoPath;

  // Cache file contents + class metadata by filePath
  const fileCache = new Map<
    string,
    { lines: string[]; classInfo: Record<string, unknown> | null }
  >();

  const getFileData = (filePath: string) => {
    if (fileCache.has(filePath)) return fileCache.get(filePath)!;

    const fullPath = pathMod.join(repoPath, filePath);
    if (!fs.existsSync(fullPath)) {
      fileCache.set(filePath, { lines: [], classInfo: null });
      return fileCache.get(filePath)!;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Extract class-level metadata in one pass
    const valueFields: Array<{ field: string; key: string; defaultValue?: string }> = [];
    const injectedBeans: string[] = [];
    let configPrefix: string | null = null;

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

      // Constructor injection
      if (line.includes('private final') && line.includes(';')) {
        const beanMatch = line.match(/private\s+final\s+(\w+)\s+(\w+)/);
        if (beanMatch) injectedBeans.push(`${beanMatch[1]} ${beanMatch[2]}`);
      }
    }

    const classInfo = { valueFields, injectedBeans, configPrefix };
    fileCache.set(filePath, { lines, classInfo });
    return fileCache.get(filePath)!;
  };

  // Attach source snippet per sink
  for (const sink of sinks) {
    if (!sink.file) continue;
    const { lines } = getFileData(sink.file);
    if (!lines.length) continue;

    // 10 lines around sink: 6 before + 3 after — enough to see URI construction
    const sinkLine = sink.line || 1;
    const start = Math.max(0, sinkLine - 7);
    const end = Math.min(lines.length, sinkLine + 3);
    sink.sourceSnippet = lines
      .slice(start, end)
      .map((l: string, i: number) => `${start + i + 1}: ${l}`)
      .join('\n');
  }

  // Return classInfo as a separate map keyed by file — avoids duplication
  const fileContext: Record<string, any> = {};
  for (const [filePath, data] of fileCache) {
    if (data.classInfo) fileContext[filePath] = data.classInfo;
  }
  return fileContext;
}

// ── analyze — source context + callers + suggestions ──

async function sinksAnalyze(params: Record<string, any>) {
  const { sinkId, service } = params;
  if (!sinkId && !service) return { error: 'Required: sinkId or service' };

  const backend = await getGraphBackend();

  // Find sink
  const sinkRows = await backend
    .executeQuery('MATCH (d:DetectedSink {id: $sinkId}) RETURN properties(d) AS s', { sinkId })
    .catch(() => []);
  if (!sinkRows.length) return { error: 'Sink not found' };
  const sink = sinkRows[0].s;
  const svcId = sink.repoId;

  // Read source context
  const path = await import('path');
  const fs = await import('fs');
  const repoPath = (await resolveServiceRepoPath(svcId)).repoPath;
  const fullPath = path.join(repoPath, sink.filePath);

  let sourceContext = '';
  let classFields: string[] = [];
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const sinkLine = sink.lineNumber || 1;
    const start = Math.max(0, sinkLine - 20);
    const end = Math.min(lines.length, sinkLine + 10);
    sourceContext = lines
      .slice(start, end)
      .map((l: string, i: number) => {
        const num = start + i + 1;
        const marker = num === sinkLine ? '>>>' : '   ';
        return `${marker} ${num}: ${l}`;
      })
      .join('\n');

    for (let i = 0; i < Math.min(lines.length, sinkLine); i++) {
      const l = lines[i].trim();
      if (l.includes('@Value') || (l.includes('private') && l.includes('Properties'))) {
        classFields.push(`  ${i + 1}: ${l}`);
      }
    }
    classFields = classFields.slice(-10);
  }

  // Find callers of the method containing this sink
  const callers = await backend
    .executeQuery(
      `MATCH (caller:Method {repoId: $svc})-[:CodeRelation {type:'CALLS'}]->(m:Method {id: $methodId})
       RETURN caller.id AS id, caller.name AS name, caller.filePath AS file, caller.startLine AS line`,
      { svc: svcId, methodId: sink.callSiteNodeId },
    )
    .catch(() => []);

  // Get relevant config
  const { resolveConfig } = await import('../engine/config-resolver.js');
  const configMap = await resolveConfig(svcId, repoPath);
  const relevantConfig: string[] = [];
  const sinkType = sink.sinkType || '';
  for (const [key, val] of configMap) {
    if (sinkType === 'http' && (key.includes('url') || key.includes('base')))
      relevantConfig.push(`${key} = ${val}`);
    else if (sinkType === 'kafka' && key.includes('topic')) relevantConfig.push(`${key} = ${val}`);
    else if (sinkType === 'rabbit' && (key.includes('queue') || key.includes('exchange')))
      relevantConfig.push(`${key} = ${val}`);
    if (relevantConfig.length >= 20) break;
  }

  // Suggest resolutions for callers by scanning their source
  const callerAnalysis: any[] = [];
  for (const caller of callers) {
    const callerFile = path.join(repoPath, caller.file);
    let argExpression = '';
    let suggestedValue: string | null = null;
    let suggestConfidence = 0;

    if (fs.existsSync(callerFile)) {
      const callerContent = fs.readFileSync(callerFile, 'utf-8');
      const callerLines = callerContent.split('\n');
      // Find the call to the wrapper method
      const wrapperMethodName = sink.callSiteMethod;
      for (let i = 0; i < callerLines.length; i++) {
        if (
          callerLines[i].includes(wrapperMethodName + '(') ||
          callerLines[i].includes(wrapperMethodName + '\n')
        ) {
          // Extract first argument
          const block = callerLines.slice(i, Math.min(i + 5, callerLines.length)).join(' ');
          const argMatch = block.match(
            new RegExp(`${escapeRegex(wrapperMethodName)}\\s*\\(([^,)]+)`),
          );
          if (argMatch) {
            argExpression = argMatch[1].trim();
            // Try to resolve: configObj.getXxx() → kebab-case → config key match
            const getterMatch = argExpression.match(/\w+\.get(\w+)\(\)/);
            if (getterMatch) {
              const fieldName = getterMatch[1];
              const kebab = fieldName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
              for (const [key, val] of configMap) {
                if (key.includes(kebab)) {
                  suggestedValue = val;
                  suggestConfidence = 0.9;
                  break;
                }
              }
            }
            // Try @Value field
            const valFieldMatch = argExpression.match(/^(\w+)$/);
            if (valFieldMatch && !suggestedValue) {
              for (let j = 0; j < callerLines.length; j++) {
                if (
                  callerLines[j].includes(`@Value`) &&
                  callerLines[j + 1]?.includes(valFieldMatch[1])
                ) {
                  const keyMatch = callerLines[j].match(/\$\{([^}]+)\}/);
                  if (keyMatch) {
                    const val = configMap.get(keyMatch[1]);
                    if (val) {
                      suggestedValue = val;
                      suggestConfidence = 0.95;
                    }
                  }
                  break;
                }
              }
            }
          }
          break;
        }
      }
    }

    callerAnalysis.push({
      method: caller.name,
      file: caller.file,
      argExpression: argExpression || 'unknown',
      suggestedValue,
      confidence: suggestConfidence,
    });
  }

  return {
    sink: {
      id: sink.id,
      type: sink.sinkType,
      method: sink.calleeMethod,
      target: sink.targetExpression,
      file: sink.filePath,
      line: sink.lineNumber,
    },
    sourceContext,
    classFields,
    relevantConfig,
    callers: callerAnalysis,
    isWrapper: callers.length >= 2,
    hint:
      callers.length >= 2
        ? `Wrapper with ${callers.length} callers. Use action=fan-out with sinkId to resolve all.`
        : 'Use action=resolve with resolutions array to set the value.',
  };
}

// ── resolve — batch resolve ──

async function sinksResolve(params: Record<string, any>) {
  const { resolutions, sinkId, value, confidence = 0.7 } = params;

  // Single resolve (backward compat)
  const items: Array<{ sinkId: string; value: string; confidence: number }> =
    resolutions || (sinkId && value ? [{ sinkId, value, confidence }] : []);

  if (!items.length) return { error: 'Required: resolutions array or sinkId + value' };

  const backend = await getGraphBackend();
  const results: any[] = [];

  for (const item of items) {
    const sinkRows = await backend
      .executeQuery('MATCH (d:DetectedSink {id: $id}) RETURN properties(d) AS s', {
        id: item.sinkId,
      })
      .catch(() => []);
    if (!sinkRows.length) {
      results.push({ sinkId: item.sinkId, error: 'not found' });
      continue;
    }
    const sink = sinkRows[0].s;
    const isHttp = sink.sinkType === 'http';

    await backend.executeQuery(
      `MATCH (d:DetectedSink {id: $id})
       SET d.resolvedUrl = $url, d.resolvedTopic = $topic,
           d.confidence = $conf, d.resolvedVia = 'manual-ai'`,
      {
        id: item.sinkId,
        url: isHttp ? item.value : '',
        topic: isHttp ? '' : item.value,
        conf: item.confidence,
      },
    );

    await saveManualResolution({
      serviceId: sink.repoId,
      patternId: sink.patternId || '',
      filePath: sink.filePath || '',
      lineNumber: sink.lineNumber || 0,
      resolvedValue: item.value,
      sinkType: sink.sinkType || 'http',
      confidence: item.confidence,
    }).catch((_err) => {
      /* manual resolution cache — non-critical */
    });

    results.push({
      sinkId: item.sinkId,
      resolved: item.value,
      confidence: item.confidence,
    });
  }

  return {
    results,
    summary: {
      total: items.length,
      resolved: results.filter((r) => !r.error).length,
      errors: results.filter((r) => r.error).length,
    },
    hint: 'Run services(action: "relink") to update cross-service graph.',
  };
}

// ── promote — wrapper sink → N caller-sinks ──

async function sinksPromote(params: Record<string, any>) {
  const { sinkId, wrapperConfig } = params;
  if (!sinkId) return { error: 'Required: sinkId' };

  const targetArgIndex = wrapperConfig?.targetArgIndex ?? 0;
  const backend = await getGraphBackend();

  // Get the wrapper sink
  const sinkRows = await backend
    .executeQuery('MATCH (d:DetectedSink {id: $id}) RETURN properties(d) AS s', { id: sinkId })
    .catch(() => []);
  if (!sinkRows.length) return { error: 'Sink not found' };
  const sink = sinkRows[0].s;
  const svcId = sink.repoId;

  // Find the method containing this sink
  const methodId = sink.callSiteNodeId;
  if (!methodId) return { error: 'Sink has no callSiteNodeId — cannot find callers' };

  // Find all callers of this method
  const callers = await backend
    .executeQuery(
      `MATCH (caller:Method {repoId: $svc})-[:CodeRelation {type:'CALLS'}]->(m:Method {id: $mid})
       RETURN caller.id AS id, caller.name AS name, caller.filePath AS file,
              caller.startLine AS startLine, caller.endLine AS endLine`,
      { svc: svcId, mid: methodId },
    )
    .catch(() => []);

  if (!callers.length) return { error: 'No callers found for this method' };

  // Read source to extract argument at each call-site
  const pathMod = await import('path');
  const fs = await import('fs');
  const repoPath = (await resolveServiceRepoPath(svcId)).repoPath;

  const wrapperMethodName = sink.callSiteMethod;
  const callerSinks: any[] = [];

  for (const caller of callers) {
    const callerFile = pathMod.join(repoPath, caller.file);
    if (!fs.existsSync(callerFile)) continue;

    const content = fs.readFileSync(callerFile, 'utf-8');
    const lines = content.split('\n');

    // Find the line where caller invokes the wrapper method
    let argExpression = '';
    let callLine = 0;
    for (
      let i = (caller.startLine || 1) - 1;
      i < Math.min(caller.endLine || lines.length, lines.length);
      i++
    ) {
      if (lines[i].includes(wrapperMethodName)) {
        const block = lines.slice(i, Math.min(i + 5, lines.length)).join(' ');
        const argMatch = block.match(
          new RegExp(`(?:\\w+\\.)?${escapeRegex(wrapperMethodName)}\\s*\\(([^)]*)`),
        );
        if (argMatch) {
          const args = argMatch[1].split(',').map((a: string) => a.trim());
          argExpression = args[targetArgIndex] || args[0] || '';
          callLine = i + 1;
        }
        break;
      }
    }

    if (!argExpression) continue;

    // Create caller-sink node
    const callerSinkId = `sink:${svcId}:${caller.file}:${callLine}:caller:${sink.patternId}`;
    await backend.executeQuery(
      `MERGE (d:DetectedSink {id: $id})
       SET d.repoId = $svc, d.filePath = $file, d.lineNumber = $line,
           d.callSiteNodeId = $callerId, d.callSiteMethod = $callerName,
           d.calleeMethod = $calleeMethod, d.sinkType = $sinkType,
           d.patternId = $patternId, d.targetExpression = $target,
           d.sinkCategory = 'caller', d.wrapperSinkId = $wrapperSinkId,
           d.confidence = 0, d.resolvedVia = '', d.resolvedUrl = '', d.resolvedTopic = ''`,
      {
        id: callerSinkId,
        svc: svcId,
        file: caller.file,
        line: callLine,
        callerId: caller.id,
        callerName: caller.name,
        calleeMethod: sink.calleeMethod,
        sinkType: sink.sinkType,
        patternId: sink.patternId,
        target: argExpression,
        wrapperSinkId: sinkId,
      },
    );

    callerSinks.push({
      id: callerSinkId,
      caller: caller.name,
      file: caller.file,
      line: callLine,
      target: argExpression,
      status: 'unresolved',
    });
  }

  // Mark original sink as wrapper
  await backend.executeQuery(`MATCH (d:DetectedSink {id: $id}) SET d.sinkCategory = 'wrapper'`, {
    id: sinkId,
  });

  return {
    promoted: true,
    originalSink: sinkId,
    callerSinks,
    total: callerSinks.length,
    hint: `${callerSinks.length} caller-sinks created. Use action=analyze or action=resolve to process them.`,
  };
}

// ── fan-out — promote + auto-resolve ──

async function sinksFanOut(params: Record<string, any>) {
  const { sinkId, targetArgIndex = 0, autoResolve = true } = params;
  if (!sinkId) return { error: 'Required: sinkId' };

  // Step 1: Promote
  const promoteResult = await sinksPromote({
    sinkId,
    wrapperConfig: { targetArgIndex },
  });
  if (promoteResult.error) return promoteResult;

  if (!autoResolve) return promoteResult;

  // Step 2: Auto-resolve each caller-sink via config scan
  const backend = await getGraphBackend();
  const sinkRows = await backend
    .executeQuery('MATCH (d:DetectedSink {id: $id}) RETURN properties(d) AS s', { id: sinkId })
    .catch(() => []);
  const svcId = sinkRows[0]?.s?.repoId;
  if (!svcId) return promoteResult;

  const pathMod = await import('path');
  const repoPath = (await resolveServiceRepoPath(svcId)).repoPath;
  const { resolveConfig } = await import('../engine/config-resolver.js');
  const configMap = await resolveConfig(svcId, repoPath);

  const results: any[] = [];
  for (const cs of promoteResult.callerSinks) {
    const target = cs.target;
    let resolved: string | null = null;
    let via = 'unresolved';
    let conf = 0;

    // Strategy 1: literal string
    if (/^"[^"]+"|^'[^']+'/.test(target)) {
      resolved = target.replace(/^["']|["']$/g, '');
      via = 'literal';
      conf = 0.95;
    }

    // Strategy 2: ${config.key}
    if (!resolved && target.includes('${')) {
      const keyMatch = target.match(/\$\{([^}]+)\}/);
      if (keyMatch) {
        const val = configMap.get(keyMatch[1]);
        if (val) {
          resolved = val;
          via = 'config-key';
          conf = 0.9;
        }
      }
    }

    // Strategy 3: configObj.getXxx() → kebab-case → fuzzy config match
    if (!resolved) {
      const getterMatch = target.match(/\w+\.get(\w+)\(\)/);
      if (getterMatch) {
        const fieldName = getterMatch[1];
        const kebab = fieldName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        for (const [key, val] of configMap) {
          if (key.includes(kebab)) {
            resolved = val;
            via = 'config-getter';
            conf = 0.9;
            break;
          }
        }
      }
    }

    // Strategy 4: simple variable name → check @Value in caller file
    if (!resolved && /^\w+$/.test(target)) {
      const fs = await import('fs');
      const callerFile = pathMod.join(repoPath, cs.file);
      if (fs.existsSync(callerFile)) {
        const content = fs.readFileSync(callerFile, 'utf-8');
        const valMatch = content.match(
          new RegExp(`@Value\\s*\\(\\s*"\\$\\{([^}]+)\\}"\\s*\\)[^;]*${escapeRegex(target)}`),
        );
        if (valMatch) {
          const val = configMap.get(valMatch[1]);
          if (val) {
            resolved = val;
            via = 'value-annotation';
            conf = 0.95;
          }
        }
      }
    }

    if (resolved) {
      const sinkType = sinkRows[0]?.s?.sinkType || 'kafka';
      const isHttp = sinkType === 'http';

      await backend.executeQuery(
        `MATCH (d:DetectedSink {id: $id})
         SET d.resolvedUrl = $url, d.resolvedTopic = $topic,
             d.confidence = $conf, d.resolvedVia = $via`,
        {
          id: cs.id,
          url: isHttp ? resolved : '',
          topic: isHttp ? '' : resolved,
          conf,
          via,
        },
      );

      await saveManualResolution({
        serviceId: svcId,
        patternId: sinkRows[0]?.s?.patternId || '',
        filePath: cs.file,
        lineNumber: cs.line,
        resolvedValue: resolved,
        sinkType,
        confidence: conf,
      }).catch((_err) => {
        /* manual resolution cache — non-critical */
      });

      results.push({ ...cs, resolved, confidence: conf, via });
    } else {
      results.push({ ...cs, resolved: null, confidence: 0, via: 'unresolved' });
    }
  }

  return {
    originalSink: sinkId,
    results,
    summary: {
      total: results.length,
      resolved: results.filter((r) => r.resolved).length,
      unresolved: results.filter((r) => !r.resolved).length,
    },
    hint: results.some((r) => !r.resolved)
      ? 'Some sinks unresolved. Use action=analyze on individual sinkIds, then action=resolve.'
      : 'All resolved! Run services(action: "relink") to update cross-service graph.',
  };
}

// ── llm-resolve — resolve one or many sinks with configured LLM ──

async function sinksLlmResolve(params: Record<string, any>) {
  let service = params.service as string | undefined;
  const sinkId = params.sinkId as string | undefined;
  const relink = params.relink as boolean | undefined;
  const backend = await getGraphBackend();

  if (!service && sinkId) {
    const rows = await backend
      .executeQuery('MATCH (d:DetectedSink {id: $id}) RETURN d.repoId AS service', { id: sinkId })
      .catch(() => []);
    service = rows[0]?.service;
  }

  if (!service) return { error: 'Required: service (or sinkId for auto-detection)' };

  const { loadConfig } = await import('../config/loader.js');
  const { resolveWikiLLMConfig } = await import('../wiki/llm-wiki-client.js');
  const { clearConfigCache, resolveConfig } = await import('../engine/config-resolver.js');
  const { llmResolveSinks } = await import('../engine/llm-sink-resolver.js');

  const config = await loadConfig();
  const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
  if (!llmConfig) {
    return {
      error:
        'No LLM configured. Set MV_WIKI_LLM_BASE_URL + MV_WIKI_LLM_API_KEY (or Anthropic envs).',
    };
  }

  const repoPath = (await resolveServiceRepoPath(service)).repoPath;
  clearConfigCache(service);
  const configMap = await resolveConfig(service, repoPath);
  const result = await llmResolveSinks(
    service,
    repoPath,
    configMap,
    llmConfig,
    sinkId ? { sinkIds: [sinkId] } : undefined,
  );

  const didRelink = relink !== false && result.resolved > 0;
  if (didRelink) {
    const { relinkService } = await import('../engine/orchestrator.js');
    await relinkService(service, repoPath).catch(() => {});
  }

  return {
    service,
    scope: sinkId ? 'single-sink' : 'service',
    sinkId: sinkId || null,
    ...result,
    relinked: didRelink,
    hint:
      result.resolved > 0
        ? didRelink
          ? 'LLM resolutions saved and the cross-service graph was re-linked.'
          : 'LLM resolutions saved. Run services(action: "relink") to refresh cross-service links.'
        : 'No sinks were resolved by the LLM. Use analyze/list/source/config to inspect unresolved targets.',
  };
}
