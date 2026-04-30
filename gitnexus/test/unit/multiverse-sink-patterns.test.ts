import { describe, expect, it } from 'vitest';
import {
  getPatternsForService,
  matchesAnnotationApplicability,
  matchesEntryPointApplicability,
  matchesPatternApplicability,
  matchesPatternScope,
  normalizeSinkPattern,
  resolveEntryPointAnnotations,
  resolveListenerAnnotations,
  resolveSinkPatterns,
  type SinkPattern,
} from '../../src/multiverse/engine/sink-patterns.js';

const basePattern = {
  name: 'pattern',
  category: 'http',
  methodPattern: 'client\\.get',
  targetArgIndex: 0,
  enabled: true,
} satisfies Omit<SinkPattern, 'id'>;

describe('multiverse sink pattern scoping', () => {
  it('normalizes JSON-serialized scope and wrapperMethods from storage', () => {
    const pattern = normalizeSinkPattern({
      id: 'custom',
      ...basePattern,
      scope: '["orders","project:PAY"]',
      wrapperMethods: '["send","publish"]',
      languages: '["java","kotlin"]',
      fileExtensions: '["java","kt"]',
      excludePathPatterns: '["/fixtures/","/examples/"]',
    });

    expect(pattern.scope).toEqual(['orders', 'project:PAY']);
    expect(pattern.wrapperMethods).toEqual(['send', 'publish']);
    expect(pattern.languages).toEqual(['java', 'kotlin']);
    expect(pattern.fileExtensions).toEqual(['.java', '.kt']);
    expect(pattern.excludePathPatterns).toEqual(['/fixtures/', '/examples/']);
  });

  it('matches service and project selectors', () => {
    expect(
      matchesPatternScope({ id: 'svc', ...basePattern, scope: 'orders' }, 'orders', 'PAY'),
    ).toBe(true);
    expect(
      matchesPatternScope(
        { id: 'project', ...basePattern, scope: 'project:PAY' },
        'billing',
        'PAY',
      ),
    ).toBe(true);
    expect(
      matchesPatternScope({ id: 'other', ...basePattern, scope: 'project:OPS' }, 'billing', 'PAY'),
    ).toBe(false);
  });

  it('filters patterns by service/project scope for pipeline use', async () => {
    const patterns: SinkPattern[] = [
      { id: 'common', ...basePattern },
      { id: 'orders-only', ...basePattern, scope: 'orders' },
      { id: 'pay-project', ...basePattern, scope: 'project:PAY' },
      { id: 'ops-project', ...basePattern, scope: 'project:OPS' },
      { id: 'mixed', ...basePattern, scope: ['shipping', 'project:PAY'] },
    ];

    const result = await getPatternsForService(patterns, 'orders', 'PAY');
    expect(result.map((pattern) => pattern.id)).toEqual([
      'common',
      'orders-only',
      'pay-project',
      'mixed',
    ]);
  });

  it('loads bundled default sink, listener, and entrypoint patterns from JSON', () => {
    expect(resolveSinkPatterns().some((pattern) => pattern.id === 'spring-rest-template')).toBe(
      true,
    );
    expect(
      resolveListenerAnnotations().some((annotation) => annotation.annotation === 'KafkaListener'),
    ).toBe(true);
    expect(
      resolveEntryPointAnnotations().some((annotation) => annotation.annotation === 'Scheduled'),
    ).toBe(true);
  });

  it('scopes built-in patterns and annotations to matching file types', () => {
    const sinkPatterns = resolveSinkPatterns();
    const springRest = sinkPatterns.find((pattern) => pattern.id === 'spring-rest-template');
    const nodeFetch = sinkPatterns.find((pattern) => pattern.id === 'node-fetch');
    const listeners = resolveListenerAnnotations();
    const entryPoints = resolveEntryPointAnnotations();

    expect(springRest).toBeDefined();
    expect(nodeFetch).toBeDefined();
    expect(matchesPatternApplicability(springRest!, 'src/main/java/FooController.java')).toBe(true);
    expect(matchesPatternApplicability(springRest!, 'src/api/client.ts')).toBe(false);
    expect(matchesPatternApplicability(nodeFetch!, 'src/api/client.ts')).toBe(true);
    expect(matchesPatternApplicability(nodeFetch!, 'src/main/java/FooController.java')).toBe(false);

    const kafkaListener = listeners.find((annotation) => annotation.annotation === 'KafkaListener');
    const scheduled = entryPoints.find((annotation) => annotation.annotation === 'Scheduled');
    const periodicTask = entryPoints.find(
      (annotation) => annotation.annotation === 'periodic_task',
    );

    expect(matchesAnnotationApplicability(kafkaListener!, 'src/main/java/Consumer.java')).toBe(
      true,
    );
    expect(matchesAnnotationApplicability(kafkaListener!, 'src/server/routes.ts')).toBe(false);
    expect(matchesEntryPointApplicability(scheduled!, 'src/jobs/SyncJob.java')).toBe(true);
    expect(matchesEntryPointApplicability(scheduled!, 'src/jobs/SyncJob.ts')).toBe(false);
    expect(matchesEntryPointApplicability(periodicTask!, 'tasks/daily.py')).toBe(true);
  });
});
