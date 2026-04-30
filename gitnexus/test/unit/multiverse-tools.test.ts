import { describe, expect, it } from 'vitest';
import { MULTIVERSE_TOOLS } from '../../src/multiverse/mcp/tools.js';

function assertNestedSchemas(schema: any, schemaPath: string) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type === 'array') {
    expect(schema.items, `${schemaPath}.items`).toBeDefined();
    assertNestedSchemas(schema.items, `${schemaPath}.items`);
  }

  if (schema.type === 'object' && schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      assertNestedSchemas(value, `${schemaPath}.properties.${key}`);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((variant: any, index: number) => {
      assertNestedSchemas(variant, `${schemaPath}.anyOf[${index}]`);
    });
  }
}

describe('MULTIVERSE_TOOLS', () => {
  it('defines valid nested array schemas for Copilot-compatible MCP import', () => {
    for (const tool of MULTIVERSE_TOOLS) {
      assertNestedSchemas(tool.inputSchema, `tool:${tool.name}.inputSchema`);
    }
  });

  it('patterns tool describes scope as string or string[] selectors', () => {
    const patternsTool = MULTIVERSE_TOOLS.find((tool) => tool.name === 'patterns');
    expect(patternsTool).toBeDefined();

    const scope = patternsTool!.inputSchema.properties.scope;
    expect(scope.anyOf).toHaveLength(2);
    expect(scope.anyOf[0]).toEqual({ type: 'string' });
    expect(scope.anyOf[1]).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('sinks tool advertises llm-resolve in the MCP schema', () => {
    const sinksTool = MULTIVERSE_TOOLS.find((tool) => tool.name === 'sinks');
    expect(sinksTool).toBeDefined();
    expect(sinksTool!.description).toContain('llm-resolve');
    expect(sinksTool!.inputSchema.properties.relink.type).toBe('boolean');
  });
});

