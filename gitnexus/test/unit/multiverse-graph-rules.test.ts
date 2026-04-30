import { describe, expect, it } from 'vitest';
import {
  matchesGraphRuleApplicability,
  resolveGraphRules,
} from '../../src/multiverse/engine/graph-rules.js';

describe('multiverse graph rules applicability', () => {
  it('scopes built-in graph rules to the expected languages and file types', () => {
    const rules = resolveGraphRules();

    const springScheduled = rules.find((rule) => rule.id === 'spring-scheduled-method');
    const nodeCron = rules.find((rule) => rule.id === 'node-cron-job');
    const fastApi = rules.find((rule) => rule.id === 'python-fastapi-route');

    expect(springScheduled).toBeDefined();
    expect(nodeCron).toBeDefined();
    expect(fastApi).toBeDefined();

    expect(matchesGraphRuleApplicability(springScheduled!, 'src/main/java/Job.java')).toBe(true);
    expect(matchesGraphRuleApplicability(springScheduled!, 'src/jobs/Job.ts')).toBe(false);
    expect(matchesGraphRuleApplicability(nodeCron!, 'src/jobs/schedule.ts')).toBe(true);
    expect(matchesGraphRuleApplicability(nodeCron!, 'src/main/java/Schedule.java')).toBe(false);
    expect(matchesGraphRuleApplicability(fastApi!, 'app/routes.py')).toBe(true);
    expect(matchesGraphRuleApplicability(fastApi!, 'app/routes.ts')).toBe(false);
  });

  it('normalizes applicability metadata on config-provided graph rules', () => {
    const rules = resolveGraphRules([
      {
        id: 'custom-ts-rule',
        name: 'Custom TS Rule',
        type: 'http',
        enabled: true,
        languages: '["typescript"]',
        fileExtensions: 'ts,tsx',
        excludePathPatterns: '["/fixtures/"]',
        match: [{ node: 'fn', label: 'Function' }],
        emit: { name: 'custom:${fn.name}' },
      },
    ]);
    const rule = rules.find((candidate) => candidate.id === 'custom-ts-rule');

    expect(rule).toMatchObject({
      languages: ['typescript'],
      fileExtensions: ['.ts', '.tsx'],
      excludePathPatterns: ['/fixtures/'],
    });
  });
});
