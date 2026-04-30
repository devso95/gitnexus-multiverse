import { useEffect, useRef, useState, useCallback } from 'react';
import { get, post } from '../api';
import { useSearchParams, useNavigate } from 'react-router-dom';
import * as d3 from 'd3';
import { GraphLegend } from '../components/GraphLegend';
import { BreadcrumbNav } from '../components/BreadcrumbNav';
import { LoadingProgress } from '../components/LoadingProgress';
import { useResponsive } from '../components/ResponsiveServiceMap';
import { setupHoverHighlights } from '../lib/graph-effects';
import {
  SEED_OPTIONS,
  type SeedType,
  getEntryPointDisplayName,
  getEntryPointKind,
  getEntryPointKindMeta,
} from '../lib/entrypoints';

interface GNode {
  id: string;
  name?: string;
  label?: string;
  filePath?: string;
  startLine?: number;
  routePath?: string;
  httpMethod?: string;
  topic?: string;
  project?: string;
  type?: string;
  entryPoints?: number;
  description?: string;
  kind?: string;
  listenerType?: string;
}
interface GEdge {
  source: string;
  target: string;
  type: string;
  via?: string;
  from?: string;
  to?: string;
  count?: number;
  confidence?: number;
}
interface SearchResult {
  id: string;
  name: string;
  label: string;
  filePath?: string;
}

const COLORS: Record<string, string> = {
  Class: '#f59e0b',
  Interface: '#ec4899',
  Method: '#14b8a6',
  Function: '#10b981',
  Route: '#3b82f6',
  Listener: '#ff7675',
  Tool: '#8b5cf6',
  Enum: '#f97316',
  Constructor: '#10b981',
  Property: '#64748b',
  Const: '#64748b',
  service: '#6c5ce7',
  lib: '#a29bfe',
  ApiTransport: '#74b9ff',
  KafkaTransport: '#ff7675',
  RabbitTransport: '#a29bfe',
  RedisTransport: '#e17055',
  ActiveMQTransport: '#f59e0b',
  Gateway: '#fdcb6e',
};
const SIZES: Record<string, number> = {
  Class: 10,
  Interface: 9,
  Route: 8,
  Listener: 8,
  Tool: 8,
  Enum: 6,
  Method: 4,
  Constructor: 4,
  Property: 3,
};
const EDGE_COLORS: Record<string, string> = {
  CALLS: '#74b9ff',
  HAS_METHOD: '#4a6785',
  MEMBER_OF: '#4a6785',
  CONTAINS: '#4a6785',
  IMPLEMENTS: '#ec4899',
  EXTENDS: '#f59e0b',
  STEP_IN_PROCESS: '#f43f5e',
  'http-out': '#74b9ff',
  'http-in': '#74b9ff',
  'kafka-out': '#ff7675',
  'kafka-in': '#ff7675',
  'rabbit-out': '#a29bfe',
  'rabbit-in': '#a29bfe',
  'redis-out': '#e17055',
  'redis-in': '#e17055',
  'activemq-out': '#f59e0b',
  'activemq-in': '#f59e0b',
  'soap-out': '#d4a017',
  'soap-in': '#d4a017',
  http: '#74b9ff',
  kafka: '#ff7675',
  rabbit: '#a29bfe',
  redis: '#e17055',
  activemq: '#f59e0b',
  soap: '#d4a017',
  lib: '#a29bfe',
};

type Mode = 'services' | 'explore';

export default function ServiceMap() {
  const svgRef = useRef<SVGSVGElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { isMobile } = useResponsive();

  const [mode, setMode] = useState<Mode>('services');
  const [svcId, setSvcId] = useState('');
  const [nodes, setNodes] = useState<GNode[]>([]);
  const [edges, setEdges] = useState<GEdge[]>([]);
  const [seedIds, setSeedIds] = useState<string[]>([]);
  const [focusId, setFocusId] = useState('');
  const [seedType, setSeedType] = useState<SeedType>('ENTRYPOINT');
  const [detail, setDetail] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transportFilter, setTransportFilter] = useState<string>('all');
  const [selectedEdge, setSelectedEdge] = useState<{
    from: string;
    to: string;
    type: string;
    via: string[];
    count: number;
    confidence: number;
  } | null>(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Sync from URL params on mount
  useEffect(() => {
    const svc = searchParams.get('service');
    const node = searchParams.get('node');
    if (svc) {
      setSvcId(svc);
      setMode('explore');
      if (node) {
        setFocusId(node);
        explore(svc, seedType, node);
        get(`/api/mv/graph/${svc}/node/${encodeURIComponent(node)}`)
          .then(setDetail)
          .catch(() => {});
      } else {
        explore(svc, seedType);
      }
    } else {
      loadServices();
    }
  }, []);

  // Load service-level with Gateway + Transport
  const loadServices = useCallback(() => {
    // Cancel any pending request
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    setMode('services');
    setSvcId('');
    setDetail(null);
    setSelectedEdge(null);
    setFocusId('');
    setNodes([]);
    setEdges([]);
    setLoading(true);
    navigate('/map', { replace: true });

    post('/api/mv/tools/service-map', {}, abortControllerRef.current.signal)
      .then((r) => {
        const svcNodes: GNode[] = (r.nodes || []).map((n: any) => ({ ...n, label: n.type }));
        const allEdges: GEdge[] = [];
        const transportNodes: GNode[] = [];
        const seen = new Set<string>();

        const transportLabel = (t: string) => {
          if (t === 'api' || t === 'soap') return 'ApiTransport';
          if (t === 'rabbit') return 'RabbitTransport';
          if (t === 'redis') return 'RedisTransport';
          if (t === 'activemq') return 'ActiveMQTransport';
          return 'KafkaTransport';
        };
        const edgeType = (t: string) => (t === 'api' ? 'http' : t);

        for (const e of r.edges || []) {
          if (e.type === 'lib') {
            allEdges.push({ source: e.from, target: e.to, type: 'lib' });
            continue;
          }
          // Create Transport hub nodes from via[]
          for (const v of e.via || []) {
            const tid = `t:${e.type}:${v}`;
            if (!seen.has(tid)) {
              seen.add(tid);
              transportNodes.push({
                id: tid,
                name: v,
                label: transportLabel(e.type),
                type: e.type,
              });
            }
            allEdges.push({
              source: e.from,
              target: tid,
              type: `${edgeType(e.type)}-out`,
              from: e.from,
              to: e.to,
              via: v,
              count: e.count,
              confidence: e.confidence,
            });
            allEdges.push({
              source: tid,
              target: e.to,
              type: `${edgeType(e.type)}-in`,
              from: e.from,
              to: e.to,
              via: v,
              count: e.count,
              confidence: e.confidence,
            });
          }
        }
        // Unmatched transports (outgoing only, no consumer yet)
        for (const u of r.unmatchedTransports || []) {
          const tid = `t:${u.type}:${u.via}`;
          if (!seen.has(tid)) {
            seen.add(tid);
            transportNodes.push({
              id: tid,
              name: u.via,
              label: transportLabel(u.type),
              type: u.type,
            });
          }
          if (!allEdges.some((e) => e.source === u.from && e.target === tid)) {
            allEdges.push({
              source: u.from,
              target: tid,
              type: `${edgeType(u.type)}-out`,
              from: u.from,
              to: '?',
              via: u.via,
              count: 1,
              confidence: u.confidence || 0.5,
            });
          }
        }
        // Deduplicate edges
        const edgeSet = new Set<string>();
        const dedupEdges = allEdges.filter((e) => {
          const k = `${e.source}→${e.target}:${e.type}`;
          if (edgeSet.has(k)) return false;
          edgeSet.add(k);
          return true;
        });

        setNodes([...svcNodes, ...transportNodes]);
        setEdges(dedupEdges);
        setSeedIds([]);
        setError(null);
      })
      .catch((err: any) => {
        // Don't show error if request was aborted (user navigated away)
        if (err?.name === 'AbortError') return;

        const message =
          err?.status === 404
            ? 'Service map not found. No services indexed yet.'
            : err?.status >= 500
              ? 'Server error. Please try again later.'
              : err?.message?.includes('Network')
                ? 'Network error. Check your connection.'
                : 'Failed to load service map. Please try again.';
        setError(message);
        setNodes([]);
        setEdges([]);
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  // Explore service graph
  const explore = useCallback((id: string, seeds: SeedType, focus?: string) => {
    // Cancel any pending request
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    setMode('explore');
    setSvcId(id);
    setDetail(null);
    setNodes([]);
    setEdges([]);
    setSeedIds([]);
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ seeds, down: '2', up: '2', limit: '200' });
    if (focus) params.set('focus', focus);

    get(`/api/mv/graph/${id}/explore?${params}`, abortControllerRef.current.signal)
      .then((r) => {
        setNodes(r.nodes || []);
        setEdges(r.edges || []);
        setSeedIds(r.seeds || []);
        setError(null);
      })
      .catch((err: any) => {
        // Don't show error if request was aborted (user navigated away)
        if (err?.name === 'AbortError') return;

        const message =
          err?.status === 404
            ? 'Service not found.'
            : err?.status >= 500
              ? 'Server error. Please try again later.'
              : 'Failed to load service graph.';
        setError(message);
        setNodes([]);
        setEdges([]);
      })
      .finally(() => setLoading(false));
  }, []);

  // Focus on a specific node (click or search)
  const focusNode = useCallback(
    (nodeId: string) => {
      if (!svcId) return;
      setFocusId(nodeId);
      setSearch('');
      setResults([]);
      navigate(`/map?service=${svcId}&node=${encodeURIComponent(nodeId)}`, { replace: true });
      get(`/api/mv/graph/${svcId}/node/${encodeURIComponent(nodeId)}`)
        .then(setDetail)
        .catch(() => {});
      explore(svcId, seedType, nodeId);
    },
    [svcId, seedType, explore, navigate],
  );

  // Search
  useEffect(() => {
    if (!search || !svcId) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      get(`/api/mv/graph/${svcId}/search?q=${encodeURIComponent(search)}`).then((r) =>
        setResults(r.results || []),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [search, svcId]);

  // D3 render
  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;
    // Apply transport filter in service map mode
    let filteredNodes = nodes;
    let filteredEdges = edges;
    if (mode === 'services' && transportFilter !== 'all') {
      const typeMap: Record<string, string[]> = {
        api: ['ApiTransport', 'http'],
        kafka: ['KafkaTransport', 'kafka'],
        rabbit: ['RabbitTransport', 'rabbit'],
        redis: ['RedisTransport', 'redis'],
        activemq: ['ActiveMQTransport', 'activemq'],
        soap: ['ApiTransport', 'soap'],
      };
      const labels = typeMap[transportFilter] || [];
      const keepTransports = new Set(
        filteredNodes
          .filter((n) => labels.includes(n.label || '') || labels.includes(n.type || ''))
          .map((n) => n.id),
      );
      // Keep edges that touch a matching transport, drop lib edges too when filtering
      filteredEdges = filteredEdges.filter(
        (e) => keepTransports.has(e.source) || keepTransports.has(e.target),
      );
      // Only keep nodes that are connected in the filtered edge set
      const connectedIds = new Set<string>();
      filteredEdges.forEach((e) => {
        connectedIds.add(e.source);
        connectedIds.add(e.target);
      });
      filteredNodes = filteredNodes.filter((n) => connectedIds.has(n.id));
    }
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    const w = svgRef.current.clientWidth,
      h = svgRef.current.clientHeight;
    const isService = mode === 'services';
    const seedSet = new Set(seedIds);

    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const safeEdges = filteredEdges
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e) => ({ ...e }));
    const simNodes = filteredNodes.map((n) => ({
      ...n,
      x: undefined,
      y: undefined,
      vx: undefined,
      vy: undefined,
    }));

    const sim = d3
      .forceSimulation(simNodes as any)
      .force(
        'link',
        d3
          .forceLink(safeEdges as any)
          .id((d: any) => d.id)
          .distance((d: any) => {
            if (isService) {
              const isTransport =
                (d.source as any).label?.includes('Transport') ||
                (d.target as any).label?.includes('Transport');
              return isTransport ? 60 : 120;
            }
            return 40;
          })
          .strength(isService ? 0.5 : 0.3),
      )
      .force('charge', d3.forceManyBody().strength(isService ? -400 : -35))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force(
        'collision',
        d3.forceCollide((d: any) => {
          if (isService) return d.label?.includes('Transport') ? 12 : 35;
          return 10;
        }),
      );

    const g = svg.append('g');
    svg.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 10])
        .on('zoom', (e) => g.attr('transform', e.transform)) as any,
    );

    // Arrow markers
    const defs = svg.append('defs');
    [
      { id: 'arrow', color: '#5a7a9a', refX: 14 },
      { id: 'arrow-api', color: '#74b9ff', refX: 10 },
      { id: 'arrow-kafka', color: '#ff7675', refX: 10 },
      { id: 'arrow-rabbit', color: '#a29bfe', refX: 10 },
      { id: 'arrow-redis', color: '#e17055', refX: 10 },
      { id: 'arrow-activemq', color: '#f59e0b', refX: 10 },
      { id: 'arrow-soap', color: '#d4a017', refX: 10 },
      { id: 'arrow-lib', color: '#a29bfe', refX: 20 },
    ].forEach((m) => {
      defs
        .append('marker')
        .attr('id', m.id)
        .attr('viewBox', '0 0 6 6')
        .attr('refX', m.refX)
        .attr('refY', 3)
        .attr('markerWidth', 4)
        .attr('markerHeight', 4)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,0 L6,3 L0,6 Z')
        .attr('fill', m.color);
    });

    // Edges
    g.selectAll('line.edge')
      .data(safeEdges)
      .join('line')
      .attr('class', 'edge')
      .attr('stroke', (d: any) => EDGE_COLORS[d.type] || '#5a6a8a')
      .attr('stroke-width', (d: any) =>
        isService ? (d.type === 'lib' ? 1 : 1.2) : d.type === 'CALLS' ? 1.2 : 0.5,
      )
      .attr('stroke-dasharray', (d: any) =>
        d.type === 'lib'
          ? '4,3'
          : d.type?.includes('kafka') ||
              d.type?.includes('rabbit') ||
              d.type?.includes('redis') ||
              d.type?.includes('activemq')
            ? '3,2'
            : 'none',
      )
      .attr('opacity', 0.6)
      .attr('marker-end', (d: any) => {
        if (isService) {
          if (d.type?.includes('kafka')) return 'url(#arrow-kafka)';
          if (d.type?.includes('rabbit')) return 'url(#arrow-rabbit)';
          if (d.type?.includes('redis')) return 'url(#arrow-redis)';
          if (d.type?.includes('activemq')) return 'url(#arrow-activemq)';
          if (d.type?.includes('soap')) return 'url(#arrow-soap)';
          if (d.type?.includes('http')) return 'url(#arrow-api)';
          if (d.type === 'lib') return 'url(#arrow-lib)';
          return '';
        }
        return 'url(#arrow)';
      })
      .style('cursor', (d: any) => (isService && d.from ? 'pointer' : 'default'))
      .on('click', (_e: any, d: any) => {
        if (!isService || !d.from) return;
        // Aggregate all edges between same from→to with same base type
        const baseType = d.type?.replace(/-(?:in|out)$/, '') || '';
        const related = safeEdges.filter(
          (e: any) =>
            e.from === d.from && e.to === d.to && e.type?.replace(/-(?:in|out)$/, '') === baseType,
        );
        const vias = [...new Set(related.map((e: any) => e.via).filter(Boolean))];
        setSelectedEdge({
          from: d.from,
          to: d.to || '?',
          type: baseType,
          via: vias,
          count: vias.length || d.count || 1,
          confidence: d.confidence || 0,
        });
      });

    // Node size
    const r = (d: any) => {
      if (isService) {
        if (d.label?.includes('Transport')) return 14; // Increased from 6 for better visibility
        return Math.max(20, 15 + Math.log2(1 + (d.entryPoints || 0)) * 5);
      }
      const base = SIZES[d.label] || 4;
      const depth = d.depth ?? 0;
      if (d.id === focusId) return base * 2;
      if (seedSet.has(d.id)) return base * 1.5;
      if (depth < 0) return base * 1.8; // upstream = bigger
      if (depth > 1) return base * 0.6; // deep downstream = smaller
      return base;
    };

    // Node color: upstream warm, downstream cool
    const nodeColor = (d: any) => {
      const base = COLORS[d.label || d.type || ''] || '#6c5ce7';
      if (isService) return base;
      const depth = d.depth ?? 0;
      if (depth < 0) return d3.interpolateRgb(base, '#fdcb6e')(0.3);
      return base;
    };

    // Nodes
    const node = g
      .selectAll('g.node')
      .data(simNodes)
      .join('g')
      .attr('class', 'node')
      .style('cursor', 'pointer')
      .on('click', (_e: any, d: any) => {
        if (isService) {
          if (d.label?.includes('Transport')) return; // Don't drill into transports
          // Navigate to service detail page
          navigate(`/services/${d.id}`);
        } else focusNode(d.id);
      })
      .call(
        d3
          .drag<any, any>()
          .on('start', (e, d) => {
            if (!e.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (e, d) => {
            d.fx = e.x;
            d.fy = e.y;
          })
          .on('end', (e, d) => {
            if (!e.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      );

    node.each(function (d: any) {
      const el = d3.select(this);
      if (isService && d.label?.includes('Transport')) {
        const s = 7;
        const color = COLORS[d.label] || '#74b9ff';
        el.append('polygon')
          .attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`)
          .attr('fill', color)
          .attr('stroke', color + '55')
          .attr('stroke-width', 1);
      } else {
        el.append('circle')
          .attr('r', r)
          .attr('fill', nodeColor)
          .attr('stroke', (dd: any) =>
            dd.id === focusId
              ? '#fff'
              : seedSet.has(dd.id)
                ? '#a29bfe'
                : (dd.depth ?? 0) < 0
                  ? '#fdcb6e55'
                  : 'none',
          )
          .attr('stroke-width', (dd: any) =>
            dd.id === focusId ? 3 : seedSet.has(dd.id) ? 2 : (dd.depth ?? 0) < 0 ? 1 : 0,
          );
      }
    });

    // Labels
    const showLabel = (d: any) =>
      isService ||
      d.id === focusId ||
      seedSet.has(d.id) ||
      ['Class', 'Interface', 'Route', 'Listener', 'Tool', 'Enum'].includes(d.label);
    node
      .append('text')
      .text((d: any) => {
        if (d.label?.includes('Transport')) {
          const name = d.name || '';
          return name.length > 25 ? '…' + name.slice(-25) : name;
        }
        if (d.label === 'Route' || d.label === 'Listener' || d.label === 'Tool' || d.kind) {
          const display = getEntryPointDisplayName(d);
          if (display) return display.slice(0, 40);
        }
        if (d.routePath != null) {
          const path = d.routePath || '';
          if (path) return `${d.httpMethod || ''} ${path}`.trim().slice(0, 40);
          // Empty path — show controller name
          const name = d.name?.trim();
          if (name && name.length > 4) return name.slice(0, 40);
          // Fallback: extract controller from id
          const ctrl = d.id?.match(/\/(\w+Controller)\./)?.[1] || d.httpMethod || '?';
          return `${d.httpMethod || ''} /${ctrl}`.trim().slice(0, 40);
        }
        if (d.topic) return d.topic.length > 35 ? '…' + d.topic.slice(-35) : d.topic;
        const name = d.name || '';
        return name.length > 30 ? name.slice(0, 28) + '…' : name;
      })
      .attr('dy', (d: any) => r(d) + 10)
      .attr('text-anchor', 'middle')
      .attr('fill', (d: any) =>
        isService && d.label?.includes('Transport') ? COLORS[d.label] || '#8ecfff' : '#c8cee0',
      )
      .attr('font-size', (d: any) =>
        isService ? (d.label?.includes('Transport') ? 7 : 11) : d.id === focusId ? 10 : 7,
      )
      .attr('display', (d: any) => (showLabel(d) ? 'block' : 'none'));

    if (isService) {
      node
        .on('mouseenter', function (event: any, d: any) {
          d3.select(this)
            .select('circle,polygon')
            .transition()
            .duration(80)
            .attr('r', (dd: any) => r(dd) * 1.15);
          const tip = tooltipRef.current;
          if (tip) {
            if (d.label?.includes('Transport')) {
              const typeMap: Record<string, [string, string]> = {
                KafkaTransport: ['📡', 'Kafka Topic'],
                RabbitTransport: ['🐰', 'RabbitMQ Queue'],
                RedisTransport: ['🔴', 'Redis Channel'],
                ActiveMQTransport: ['📨', 'ActiveMQ Queue'],
                ApiTransport: ['🔗', 'API Endpoint'],
              };
              const [icon, typeName] = typeMap[d.label] || ['🔗', 'Transport'];
              tip.innerHTML =
                `<div class="font-medium text-sm">${icon} ${d.name}</div>` +
                `<div class="text-text2">${typeName}</div>`;
            } else {
              tip.innerHTML =
                `<div class="font-medium text-sm">${d.name || d.id}</div>` +
                `<div class="text-text2">Type: ${d.type || '—'} · Project: ${d.project || '—'}</div>` +
                `<div class="text-text2">Entry Points: ${d.entryPoints || 0}</div>` +
                `<div class="text-info text-[10px] mt-1">Click to explore graph →</div>`;
            }
            tip.style.display = 'block';
            tip.style.left = `${event.clientX + 12}px`;
            tip.style.top = `${event.clientY - 10}px`;
          }
        })
        .on('mousemove', function (event: any) {
          const tip = tooltipRef.current;
          if (tip) {
            tip.style.left = `${event.clientX + 12}px`;
            tip.style.top = `${event.clientY - 10}px`;
          }
        })
        .on('mouseleave', function () {
          d3.select(this).select('circle,polygon').transition().duration(80).attr('r', r);
          if (tooltipRef.current) tooltipRef.current.style.display = 'none';
        });
    }

    if (!isService) {
      node
        .on('mouseenter', function (event: any, d: any) {
          d3.select(this).select('text').attr('display', 'block').attr('font-size', 9);
          d3.select(this)
            .select('circle')
            .transition()
            .duration(80)
            .attr('r', (dd: any) => r(dd) * 1.3);
          // Show tooltip
          const tip = tooltipRef.current;
          if (tip) {
            const label = d.label || '';
            const path = d.routePath || '';
            let name = path ? `${d.httpMethod || ''} ${path}`.trim() : d.topic || d.name || d.id;
            const kind = getEntryPointKind(d);
            const kindMeta = getEntryPointKindMeta(kind);
            // For routes with empty path, show controller
            if (label === 'Route' && !path) {
              const ctrl = d.id?.match(/\/(\w+Controller)\./)?.[1] || '';
              name = ctrl ? `${d.httpMethod || 'GET'} — ${ctrl}` : d.name?.trim() || d.id;
            }
            const file = d.filePath ? `${d.filePath}${d.startLine ? ':' + d.startLine : ''}` : '';
            tip.innerHTML =
              `<div class="font-medium">${name}</div>` +
              `<div class="text-text2 text-[10px]">${kindMeta.icon} ${kindMeta.label}${label ? ` · ${label}` : ''}</div>` +
              (file
                ? `<div class="text-text2 text-[10px] font-mono truncate max-w-[250px]">${file}</div>`
                : '');
            tip.style.display = 'block';
            tip.style.left = `${event.clientX + 12}px`;
            tip.style.top = `${event.clientY - 10}px`;
          }
        })
        .on('mousemove', function (event: any) {
          const tip = tooltipRef.current;
          if (tip) {
            tip.style.left = `${event.clientX + 12}px`;
            tip.style.top = `${event.clientY - 10}px`;
          }
        })
        .on('mouseleave', function (_e: any, d: any) {
          d3.select(this)
            .select('text')
            .attr('display', showLabel(d) ? 'block' : 'none')
            .attr('font-size', 7);
          d3.select(this).select('circle').transition().duration(80).attr('r', r(d));
          if (tooltipRef.current) tooltipRef.current.style.display = 'none';
        });
    }

    // Add hover highlights for connected nodes in explore mode
    if (!isService) {
      setupHoverHighlights(g, nodes, edges, node, g.selectAll('line.edge'));
    }

    sim.on('tick', () => {
      g.selectAll('line.edge')
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    return () => {
      sim.stop();
    };
  }, [nodes, edges, mode, seedIds, focusId, transportFilter]);

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col">
        {/* Breadcrumb Navigation */}
        <div className="border-border flex items-center justify-between border-b bg-surface/50 px-5 py-2">
          <BreadcrumbNav
            items={[
              { label: '📊 Services', onClick: () => mode !== 'services' && loadServices() },
              ...(svcId ? [{ label: svcId, onClick: () => focusNode('') }] : []),
              ...(focusId ? [{ label: focusId, active: true }] : []),
            ]}
          />
          {mode === 'explore' && (
            <span className="text-text2 rounded bg-surface px-2 py-0.5 text-xs">
              {seedType === 'ENTRYPOINT' && '⚡ Entry Points'}
              {seedType === 'API' && '🌐 APIs'}
              {seedType === 'MCP_TOOL' && '🛠️ MCP Tools'}
              {seedType === 'MESSAGE' && '📡 Messages'}
              {seedType === 'SCHEDULED' && '⏰ Scheduled'}
              {seedType === 'SINK' && '🪤 Sinks'}
              {seedType === 'Class' && '📦 Classes'}
              {seedType === 'Interface' && '📋 Interfaces'}
            </span>
          )}
        </div>

        {/* Toolbar */}
        <div className="border-border flex items-center gap-2 border-b bg-surface px-5 py-2">
          {mode === 'explore' && (
            <button
              onClick={loadServices}
              className="bg-surface2 border-border rounded border px-2 py-1 text-xs hover:bg-accent hover:text-white"
            >
              ← Services
            </button>
          )}
          <h1 className="text-sm font-semibold">{mode === 'services' ? 'Service Map' : svcId}</h1>

          {mode === 'services' && (
            <div className="ml-2 flex gap-1">
              {[
                { v: 'all', l: 'All' },
                { v: 'api', l: '🌐 API' },
                { v: 'kafka', l: '📡 Kafka' },
                { v: 'rabbit', l: '🐰 Rabbit' },
                { v: 'redis', l: '🔴 Redis' },
                { v: 'activemq', l: '📨 ActiveMQ' },
                { v: 'soap', l: '🧼 SOAP' },
              ].map((o) => (
                <button
                  key={o.v}
                  onClick={() => setTransportFilter(o.v)}
                  className={`rounded border px-2 py-1 text-xs transition-colors ${transportFilter === o.v ? 'border-accent bg-accent text-white' : 'bg-surface2 border-border text-text2 hover:text-text'}`}
                >
                  {o.l}
                </button>
              ))}
            </div>
          )}

          {mode === 'explore' && (
            <>
              {/* Seed type selector */}
              <div className="ml-2 flex gap-1">
                {SEED_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => {
                      setSeedType(o.value);
                      setFocusId('');
                      explore(svcId, o.value);
                    }}
                    className={`rounded border px-2 py-1 text-xs transition-colors ${seedType === o.value ? 'border-accent bg-accent text-white' : 'bg-surface2 border-border text-text2 hover:text-text'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>

              {/* Search */}
              <div className="relative ml-2 max-w-xs flex-1">
                <input
                  className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-1 text-sm outline-none focus:border-accent"
                  placeholder="Search..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {results.length > 0 && (
                  <div className="border-border absolute top-full right-0 left-0 z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border bg-surface shadow-xl">
                    {results.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => focusNode(r.id)}
                        className="hover:bg-surface2 border-border/50 flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-0"
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: COLORS[r.label] || '#666' }}
                        />
                        <span className="truncate font-medium">{r.name}</span>
                        <span className="text-text2 shrink-0 text-[10px]">{r.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Graph */}
        <div className="relative flex-1">
          {/* Loading Progress */}
          {loading && nodes.length > 0 && (
            <LoadingProgress
              isLoading={true}
              label={mode === 'services' ? 'Loading service map...' : 'Loading graph...'}
              showPercentage={true}
              showETA={true}
              estimatedDuration={3000}
            />
          )}

          {/* Tooltip */}
          <div
            ref={tooltipRef}
            className="border-border pointer-events-none fixed z-50 rounded-lg border bg-surface px-3 py-2 text-xs shadow-xl"
            style={{ display: 'none' }}
          />
          {error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <div className="text-3xl">⚠️</div>
              <div className="text-center">
                <div className="text-text font-medium">{error}</div>
                <div className="text-text2 mt-2 text-sm">
                  {mode === 'services' && (
                    <p>
                      Need to index services first? Run:
                      <br />
                      <code className="bg-surface2 mt-1 inline-block rounded px-2 py-1 text-xs">
                        npx multiverse index &lt;path&gt;
                      </code>
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => {
                  setError(null);
                  if (mode === 'services') loadServices();
                  else if (svcId) explore(svcId, seedType);
                }}
                className="rounded bg-accent px-4 py-2 text-sm text-white hover:opacity-90"
              >
                🔄 Try again
              </button>
            </div>
          ) : nodes.length === 0 ? (
            <div className="text-text2 flex h-full items-center justify-center">
              {loading ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                  <span className="text-sm">
                    {mode === 'services' ? 'Loading service map...' : 'Loading graph...'}
                  </span>
                </div>
              ) : mode === 'services' ? (
                <div className="text-center">
                  <div className="mb-2 text-2xl">📭</div>
                  <div className="font-medium">No services yet</div>
                  <div className="text-text2 mt-1 text-sm">
                    Index your repositories to see the service map
                  </div>
                </div>
              ) : (
                <div className="text-center">
                  <div className="mb-2 text-2xl">🔍</div>
                  <div className="font-medium">No nodes found</div>
                  <div className="text-text2 mt-1 text-sm">
                    Try a different seed type or search term
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <svg ref={svgRef} className="h-full w-full" style={{ background: '#12141e' }} />
              {mode === 'services' && <GraphLegend />}
            </>
          )}
          <div className="text-text2 absolute right-3 bottom-3 rounded bg-surface/80 px-2 py-1 text-[10px]">
            {nodes.length} nodes · {edges.length} edges
          </div>
        </div>
      </div>

      {/* Edge detail panel */}
      {selectedEdge && mode === 'services' && (
        <div className="border-border w-72 shrink-0 overflow-y-auto border-l bg-surface">
          <div className="border-border border-b p-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-text2 text-[10px] tracking-wide uppercase">
                Connection Detail
              </span>
              <button
                onClick={() => setSelectedEdge(null)}
                className="text-text2 hover:text-text text-xs"
              >
                ✕
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2 text-sm font-semibold">
              <span className="text-accent2">{selectedEdge.from}</span>
              <span className="text-text2">→</span>
              <span className="text-accent2">{selectedEdge.to}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{ background: EDGE_COLORS[selectedEdge.type] || '#5a6a8a', color: '#fff' }}
              >
                {selectedEdge.type.toUpperCase()}
              </span>
              <span className="text-text2 text-xs">
                {selectedEdge.count} transport{selectedEdge.count > 1 ? 's' : ''}
              </span>
              {selectedEdge.confidence > 0 && (
                <span className="text-text2 text-[10px]">
                  conf: {(selectedEdge.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
          <div className="p-3">
            <h4 className="text-text2 mb-2 text-[10px] tracking-wide uppercase">
              Transports ({selectedEdge.via.length})
            </h4>
            <div className="space-y-1">
              {selectedEdge.via.map((v, i) => (
                <div
                  key={i}
                  className="bg-surface2 rounded px-2 py-1.5 font-mono text-xs break-all"
                >
                  <span style={{ color: EDGE_COLORS[selectedEdge.type] || '#74b9ff' }}>
                    {selectedEdge.type === 'http' || selectedEdge.type === 'soap'
                      ? '🔗'
                      : selectedEdge.type === 'activemq'
                        ? '📨'
                        : '📡'}
                  </span>{' '}
                  {v}
                </div>
              ))}
              {!selectedEdge.via.length && (
                <div className="text-text2 text-xs italic">No transport details available</div>
              )}
            </div>
          </div>
          <div className="border-border border-t p-3">
            <button
              onClick={() => {
                navigate(`/map?service=${selectedEdge.from}`);
                explore(selectedEdge.from, 'ENTRYPOINT');
                setSelectedEdge(null);
              }}
              className="text-accent2 text-xs hover:underline"
            >
              Explore {selectedEdge.from} →
            </button>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {detail?.node && mode === 'explore' && (
        <div className="border-border w-72 shrink-0 overflow-y-auto border-l bg-surface">
          <div className="border-border border-b p-4">
            <div className="mb-1 flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: COLORS[detail.node.labels?.[0]] || '#666' }}
              />
              <span className="text-text2 text-[10px]">{detail.node.labels?.join(', ')}</span>
              <button
                onClick={() => setDetail(null)}
                className="text-text2 hover:text-text ml-auto text-xs"
              >
                ✕
              </button>
            </div>
            <h3 className="text-sm font-semibold break-all">
              {getEntryPointDisplayName({
                routePath: detail.node.props?.routePath,
                httpMethod: detail.node.props?.httpMethod,
                topic: detail.node.props?.topic,
                name:
                  detail.node.props?.name?.trim() ||
                  detail.node.props?.controllerName ||
                  detail.node.id,
              })}
            </h3>
            {(() => {
              const kind = getEntryPointKind({
                label: detail.node.labels?.[0],
                listenerType: detail.node.props?.listenerType,
                routePath: detail.node.props?.routePath,
                topic: detail.node.props?.topic,
              });
              if (kind === 'OTHER') return null;
              const meta = getEntryPointKindMeta(kind);
              return (
                <div className="text-text2 mt-1 text-xs">
                  {meta.icon} {meta.label}
                </div>
              );
            })()}
            {!detail.node.props?.routePath && detail.node.props?.controllerName && (
              <div className="text-text2 mt-0.5 text-xs">
                {detail.node.props.httpMethod} — {detail.node.props.controllerName}
              </div>
            )}
            {detail.node.props?.routePath && (
              <div className="text-info mt-1 font-mono text-xs">
                {detail.node.props.httpMethod} {detail.node.props.routePath}
              </div>
            )}
            {detail.node.props?.topic && (
              <div className="text-kafka mt-1 font-mono text-xs">📡 {detail.node.props.topic}</div>
            )}
            {detail.node.props?.filePath && (
              <div className="text-text2 mt-1 font-mono text-[10px] break-all">
                {detail.node.props.filePath}
                {detail.node.props.startLine ? `:${detail.node.props.startLine}` : ''}
              </div>
            )}
          </div>
          <div className="p-3">
            <h4 className="text-text2 mb-2 text-[10px] tracking-wide uppercase">
              Connections ({detail.neighbors?.length || 0})
            </h4>
            <div className="space-y-0.5">
              {(detail.neighbors || []).map((n: any, i: number) => (
                <button
                  key={i}
                  onClick={() => focusNode(n.id)}
                  className="hover:bg-surface2 flex w-full items-center gap-1 rounded px-2 py-1 text-left text-[11px]"
                >
                  <span className={n.direction === 'outgoing' ? 'text-info' : 'text-warn'}>
                    {n.direction === 'outgoing' ? '→' : '←'}
                  </span>
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: COLORS[n.label] || '#666' }}
                  />
                  <span className="truncate">{n.name}</span>
                  <span className="text-text2 ml-auto shrink-0 text-[9px]">{n.relType}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
