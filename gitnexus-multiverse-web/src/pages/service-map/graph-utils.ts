import {
  getEntryPointDisplayName,
  getEntryPointKind,
  getEntryPointKindMeta,
} from '../../lib/entrypoints';
import type { GEdge, GNode, GraphResponse, NodeDetailResponse, ServiceMapResponse } from './types';
import type { TransportFilter } from './constants';

export function isTransportNode(node: Pick<GNode, 'label'>): boolean {
  return Boolean(node.label?.includes('Transport'));
}

export function isServiceNode(node: Pick<GNode, 'label'>): boolean {
  return node.label === 'service' || node.label === 'lib';
}

export function getTransportLabel(type: string): string {
  if (type === 'api' || type === 'soap') return 'ApiTransport';
  if (type === 'rabbit') return 'RabbitTransport';
  if (type === 'redis') return 'RedisTransport';
  if (type === 'activemq') return 'ActiveMQTransport';
  return 'KafkaTransport';
}

export function getTransportEdgeType(type: string): string {
  return type === 'api' ? 'http' : type;
}

export function buildServiceOverviewGraph(response: ServiceMapResponse): GraphResponse {
  const serviceNodes: GNode[] = (response.nodes || []).map((node) => ({
    ...node,
    label: node.type,
  }));
  const transportNodes: GNode[] = [];
  const allEdges: GEdge[] = [];
  const seenTransportNodes = new Set<string>();

  for (const edge of response.edges || []) {
    if (edge.type === 'lib') {
      allEdges.push({ source: edge.from, target: edge.to, type: 'lib' });
      continue;
    }

    for (const via of edge.via || []) {
      const transportId = `t:${edge.type}:${via}`;
      if (!seenTransportNodes.has(transportId)) {
        seenTransportNodes.add(transportId);
        transportNodes.push({
          id: transportId,
          name: via,
          label: getTransportLabel(edge.type),
          type: edge.type,
        });
      }

      const transportEdgeType = getTransportEdgeType(edge.type);
      allEdges.push({
        source: edge.from,
        target: transportId,
        type: `${transportEdgeType}-out`,
        from: edge.from,
        to: edge.to,
        via,
        count: edge.count,
        confidence: edge.confidence,
      });
      allEdges.push({
        source: transportId,
        target: edge.to,
        type: `${transportEdgeType}-in`,
        from: edge.from,
        to: edge.to,
        via,
        count: edge.count,
        confidence: edge.confidence,
      });
    }
  }

  for (const unmatched of response.unmatchedTransports || []) {
    const transportId = `t:${unmatched.type}:${unmatched.via}`;
    if (!seenTransportNodes.has(transportId)) {
      seenTransportNodes.add(transportId);
      transportNodes.push({
        id: transportId,
        name: unmatched.via,
        label: getTransportLabel(unmatched.type),
        type: unmatched.type,
      });
    }

    if (!allEdges.some((edge) => edge.source === unmatched.from && edge.target === transportId)) {
      allEdges.push({
        source: unmatched.from,
        target: transportId,
        type: `${getTransportEdgeType(unmatched.type)}-out`,
        from: unmatched.from,
        to: '?',
        via: unmatched.via,
        count: 1,
        confidence: unmatched.confidence || 0.5,
      });
    }
  }

  return mergeGraphData(
    { nodes: [], edges: [], seeds: [] },
    { nodes: [...serviceNodes, ...transportNodes], edges: allEdges, seeds: [] },
  );
}

export function filterServiceOverviewGraph(
  graph: GraphResponse,
  transportFilter: TransportFilter,
): GraphResponse {
  if (transportFilter === 'all') return graph;

  const typeMap: Record<string, string[]> = {
    api: ['ApiTransport', 'http'],
    kafka: ['KafkaTransport', 'kafka'],
    rabbit: ['RabbitTransport', 'rabbit'],
    redis: ['RedisTransport', 'redis'],
    activemq: ['ActiveMQTransport', 'activemq'],
    soap: ['ApiTransport', 'soap'],
  };
  const labels = typeMap[transportFilter] || [];
  const keepTransportIds = new Set(
    graph.nodes
      .filter((node) => labels.includes(node.label || '') || labels.includes(node.type || ''))
      .map((node) => node.id),
  );

  const edges = graph.edges.filter(
    (edge) => keepTransportIds.has(edge.source) || keepTransportIds.has(edge.target),
  );
  const connectedIds = new Set<string>();
  edges.forEach((edge) => {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  });

  return {
    ...graph,
    nodes: graph.nodes.filter((node) => connectedIds.has(node.id)),
    edges,
  };
}

export function mergeGraphData(
  base: GraphResponse,
  incoming?: Partial<GraphResponse> | null,
): GraphResponse {
  if (!incoming) return base;

  const nodeMap = new Map<string, GNode>();
  for (const node of base.nodes || []) nodeMap.set(node.id, node);
  for (const node of incoming.nodes || [])
    nodeMap.set(node.id, { ...nodeMap.get(node.id), ...node });

  const edgeMap = new Map<string, GEdge>();
  for (const edge of base.edges || [])
    edgeMap.set(`${edge.source}→${edge.target}:${edge.type}`, edge);
  for (const edge of incoming.edges || []) {
    edgeMap.set(`${edge.source}→${edge.target}:${edge.type}`, {
      ...edgeMap.get(`${edge.source}→${edge.target}:${edge.type}`),
      ...edge,
    });
  }

  const seeds = new Set([...(base.seeds || []), ...(incoming.seeds || [])]);

  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    seeds: [...seeds],
    availableSeeds: incoming.availableSeeds || base.availableSeeds,
    focus: incoming.focus ?? base.focus,
  };
}

export function mergeNodeDetailIntoGraph(
  graph: GraphResponse,
  detail?: NodeDetailResponse | null,
): GraphResponse {
  if (!detail?.graph) return graph;
  return mergeGraphData(graph, detail.graph);
}

export function getNodeDisplayName(node: Partial<GNode>): string {
  if (node.label === 'DetectedSink') {
    return (
      node.resolvedUrl || node.topic || node.targetExpression || node.name || node.id || 'Sink'
    );
  }
  if (node.label === 'Route' || node.label === 'Listener' || node.label === 'Tool' || node.kind) {
    const display = getEntryPointDisplayName(node);
    if (display) return display;
  }
  if (node.routePath != null) {
    const path = node.routePath || '';
    if (path) return `${node.httpMethod || ''} ${path}`.trim();
  }
  return node.name || node.id || 'Unnamed node';
}

export function getNodeSecondaryText(node: Partial<GNode>): string | null {
  if (node.label === 'DetectedSink') {
    return node.sinkType ? `${node.sinkType.toUpperCase()} sink` : 'Sink';
  }
  const kind = getEntryPointKind(node);
  if (kind !== 'OTHER') {
    return getEntryPointKindMeta(kind).label;
  }
  return node.label || null;
}
