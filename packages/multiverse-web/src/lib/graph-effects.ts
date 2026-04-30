/**
 * Utilities for D3 graph hover effects and node labels
 * These functions are used by ServiceMap to enhance interactivity
 */

import * as d3 from 'd3';

/**
 * Apply hover highlight effect to connected nodes
 * When hovering over a node, highlights it and all connected nodes
 */
export function setupHoverHighlights(
  g: any, // d3 selection
  nodes: any[],
  edges: any[],
  nodeSelection: any, // d3 selection of nodes
  edgeSelection: any, // d3 selection of edges
) {
  // Create adjacency map for quick lookup
  const adjacencyMap = new Map<string, Set<string>>();

  nodes.forEach((n) => adjacencyMap.set(n.id, new Set()));
  edges.forEach((e) => {
    const source = typeof e.source === 'string' ? e.source : e.source.id;
    const target = typeof e.target === 'string' ? e.target : e.target.id;

    if (adjacencyMap.has(source)) {
      adjacencyMap.get(source)!.add(target);
    }
    if (adjacencyMap.has(target)) {
      adjacencyMap.get(target)!.add(source);
    }
  });

  // Apply hover to each node
  nodeSelection
    .on('mouseenter', function (this: any, _: any, d: any) {
      // Get connected nodes
      const connected = adjacencyMap.get(d.id) || new Set();
      const allRelated = new Set([d.id, ...connected]);

      // Highlight connected edges
      edgeSelection
        .style('stroke-opacity', (e: any) => {
          const src = typeof e.source === 'string' ? e.source : e.source.id;
          const tgt = typeof e.target === 'string' ? e.target : e.target.id;
          return allRelated.has(src) && allRelated.has(tgt) ? 0.8 : 0.2;
        })
        .style('stroke-width', (e: any) => {
          const src = typeof e.source === 'string' ? e.source : e.source.id;
          const tgt = typeof e.target === 'string' ? e.target : e.target.id;
          return allRelated.has(src) && allRelated.has(tgt) ? 2 : 1;
        });

      // Highlight connected nodes
      nodeSelection
        .select('circle')
        .style('opacity', (n: any) => (allRelated.has(n.id) ? 1 : 0.3))
        .style('filter', (n: any) => {
          if (n.id === d.id) {
            return 'drop-shadow(0 0 12px rgba(168, 85, 247, 0.8))';
          }
          if (allRelated.has(n.id)) {
            return 'drop-shadow(0 0 8px rgba(168, 85, 247, 0.6))';
          }
          return 'none';
        });

      // Fade out labels of non-connected nodes
      nodeSelection.select('text').style('opacity', (n: any) => (allRelated.has(n.id) ? 1 : 0.2));
    })
    .on('mouseleave', function (this: any) {
      // Reset all styles
      edgeSelection.style('stroke-opacity', 0.5).style('stroke-width', 1);

      nodeSelection.select('circle').style('opacity', 1).style('filter', 'none');

      nodeSelection.select('text').style('opacity', 1);
    });
}

/**
 * Abbreviate long node names intelligently
 * Examples:
 *   "UserAuthenticationService" → "UAS"
 *   "validateUserEmail" → "validateUser..."
 *   "foo_bar_baz_qux" → "f_b_b_q"
 */
export function abbreviateNodeName(name: string, maxLength: number = 12): string {
  if (name.length <= maxLength) return name;

  // Try camelCase abbreviation first (e.g., UserAuthenticationService → UAS)
  const camelMatch = name.match(/[A-Z]/g);
  if (camelMatch && camelMatch.length > 1) {
    const abbrev = camelMatch.join('');
    if (abbrev.length <= maxLength) {
      return abbrev;
    }
  }

  // Try snake_case abbreviation (e.g., foo_bar_baz_qux → f_b_b_q)
  if (name.includes('_')) {
    const parts = name.split('_');
    if (parts.length > 1) {
      const abbrev = parts.map((p) => p[0] || '').join('_');
      if (abbrev.length <= maxLength) {
        return abbrev;
      }
    }
  }

  // Fall back to truncation with ellipsis
  return name.substring(0, maxLength - 1) + '…';
}

/**
 * Determine if a node should show its label based on size and zoom level
 */
export function shouldShowLabel(node: any, zoomLevel: number = 1): boolean {
  // Always show labels for service nodes (larger)
  if (node.type === 'service') return true;

  // Show labels for medium-sized nodes at default zoom
  if (node.r > 8) return zoomLevel >= 0.8;

  // Hide labels for small nodes
  return false;
}

/**
 * Get label style for a node
 */
export function getLabelStyle(node: any) {
  return {
    fontSize: Math.max(7, Math.min(14, (node.r || 8) + 2)) + 'px',
    fontWeight: node.type === 'service' ? 600 : 400,
    textAnchor: 'middle' as const,
    dominantBaseline: 'central' as const,
    pointerEvents: 'none' as const,
  };
}

/**
 * Add scale animation on hover for a D3 element
 */
export function addScaleAnimation(selection: any, scaleFactor: number = 1.5) {
  selection
    .on('mouseenter', function (this: any) {
      // Use CSS transform for smooth animation
      const currentR = parseFloat(d3.select(this).select('circle').attr('r') || '0');
      d3.select(this)
        .select('circle')
        .transition()
        .duration(150)
        .attr('r', currentR * scaleFactor);
    })
    .on('mouseleave', function (this: any, d: any) {
      const radius = typeof d.r === 'number' ? d.r : 8;
      d3.select(this).select('circle').transition().duration(150).attr('r', radius);
    });
}

/**
 * Create tooltip content for a node
 */
export function createNodeTooltip(node: any): string {
  const name = node.name || node.label || node.id;
  const kind = node.type || node.kind || 'Unknown';
  const file = node.filePath || '';
  const line = node.startLine ? `:${node.startLine}` : '';

  return `
    <div class="font-medium text-sm">${name}</div>
    <div class="text-text2 text-xs mt-1">${kind}</div>
    ${file ? `<div class="text-text2 text-[10px] font-mono mt-1">${file}${line}</div>` : ''}
  `;
}
