import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

interface LegendItem {
  color: string;
  label: string;
  description?: string;
}

const NODE_LEGEND: Record<string, LegendItem> = {
  service: {
    color: '#6c5ce7',
    label: 'Service',
    description: 'Microservice or main application',
  },
  gateway: {
    color: '#fdcb6e',
    label: 'Gateway',
    description: 'API Gateway, Load Balancer',
  },
  api: {
    color: '#3b82f6',
    label: 'HTTP/API',
    description: 'REST API or HTTP endpoint',
  },
  kafka: {
    color: '#ff7675',
    label: 'Kafka',
    description: 'Message queue or topic',
  },
  rabbit: {
    color: '#a29bfe',
    label: 'RabbitMQ',
    description: 'Message broker queue',
  },
  redis: {
    color: '#e17055',
    label: 'Redis',
    description: 'Cache or data store',
  },
  activemq: {
    color: '#f59e0b',
    label: 'ActiveMQ',
    description: 'Message queue',
  },
};

const EDGE_LEGEND: Record<string, LegendItem> = {
  http: {
    color: '#74b9ff',
    label: 'HTTP Call',
    description: 'REST API call',
  },
  kafka: {
    color: '#ff7675',
    label: 'Kafka Event',
    description: 'Async event via Kafka',
  },
  rabbit: {
    color: '#a29bfe',
    label: 'RabbitMQ',
    description: 'Message via RabbitMQ',
  },
  redis: {
    color: '#e17055',
    label: 'Redis Access',
    description: 'Cache/data access',
  },
  activemq: {
    color: '#f59e0b',
    label: 'ActiveMQ',
    description: 'Message via ActiveMQ',
  },
  lib: {
    color: '#a29bfe',
    label: 'Library Dependency',
    description: 'Shared library import',
  },
};

export function GraphLegend() {
  const [expandedNodes, setExpandedNodes] = useState(true);
  const [expandedEdges, setExpandedEdges] = useState(false);

  const toggleNodes = () => setExpandedNodes(!expandedNodes);
  const toggleEdges = () => setExpandedEdges(!expandedEdges);

  return (
    <div className="absolute top-4 left-4 max-h-96 w-72 overflow-y-auto rounded-lg border border-gray-700 bg-gray-800/95 p-0 shadow-lg backdrop-blur-sm">
      {/* Header */}
      <div className="sticky top-0 border-b border-gray-700 bg-gray-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">📊 Legend</h3>
      </div>

      {/* Nodes Section */}
      <div className="border-b border-gray-700">
        <button
          onClick={toggleNodes}
          className="flex w-full items-center justify-between px-4 py-2 transition-colors hover:bg-gray-700/50"
        >
          <span className="text-xs font-medium text-gray-300">NODES</span>
          {expandedNodes ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {expandedNodes && (
          <div className="bg-gray-850 space-y-2 px-4 py-2">
            {Object.entries(NODE_LEGEND).map(([key, item]) => (
              <div key={key} className="flex items-start gap-2">
                <div
                  className="mt-1 h-3 w-3 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                  title={item.label}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-gray-200">{item.label}</div>
                  {item.description && (
                    <div className="truncate text-xs text-gray-400">{item.description}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edges Section */}
      <div>
        <button
          onClick={toggleEdges}
          className="flex w-full items-center justify-between px-4 py-2 transition-colors hover:bg-gray-700/50"
        >
          <span className="text-xs font-medium text-gray-300">RELATIONSHIPS</span>
          {expandedEdges ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {expandedEdges && (
          <div className="bg-gray-850 space-y-2 px-4 py-2">
            {Object.entries(EDGE_LEGEND).map(([key, item]) => (
              <div key={key} className="flex items-start gap-2">
                <div
                  className="mt-0.5 h-4 w-0.5 flex-shrink-0"
                  style={{ backgroundColor: item.color }}
                  title={item.label}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-gray-200">{item.label}</div>
                  {item.description && (
                    <div className="truncate text-xs text-gray-400">{item.description}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="bg-gray-850 border-t border-gray-700 px-4 py-2">
        <p className="text-xs text-gray-400">
          💡 Tip: Click services to explore. Hover edges for details.
        </p>
      </div>
    </div>
  );
}
