import { describe, expect, it } from 'vitest';
import { buildBusinessGroups } from '../../src/multiverse/engine/business-grouper.js';

describe('buildBusinessGroups', () => {
  it('includes MCP tools alongside routes and listeners in grouped entrypoints', () => {
    const groups = buildBusinessGroups('orders', {
      routes: [
        {
          id: 'route:orders:list',
          routePath: '/api/orders',
          controller: 'OrderController',
          name: 'listOrders',
        },
      ],
      listeners: [
        {
          id: 'listener:orders:events',
          topic: 'ordering.workflow.created',
          type: 'kafka',
          name: 'workflowListener',
        },
        {
          id: 'listener:orders:cron',
          type: 'scheduled',
          name: 'syncOrders',
        },
      ],
      tools: [
        {
          id: 'tool:orders:reindex',
          name: 'reindexOrders',
          filePath: 'src/mcp/tools/orders.ts',
        },
      ],
    });

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'orders:order',
          name: 'Order',
          entryPointIds: ['route:orders:list'],
          entryPointCount: 1,
        }),
        expect.objectContaining({
          id: 'orders:kafka:workflow.created',
          name: 'Kafka: workflow.created',
          entryPointIds: ['listener:orders:events'],
          entryPointCount: 1,
        }),
        expect.objectContaining({
          id: 'orders:jobs',
          name: 'Jobs & Scheduled Tasks',
          entryPointIds: ['listener:orders:cron'],
          entryPointCount: 1,
        }),
        expect.objectContaining({
          id: 'orders:mcp-tools',
          name: 'MCP Tools',
          entryPointIds: ['tool:orders:reindex'],
          entryPointCount: 1,
        }),
      ]),
    );
  });
});
