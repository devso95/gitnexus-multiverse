import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigLoaderCache, loadConfig } from '../../src/multiverse/config/loader.js';

const tempDirs: string[] = [];

afterEach(() => {
  clearConfigLoaderCache();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('multiverse config loader', () => {
  it('merges sibling multiverse-patterns.custom.json overrides into config arrays', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mv-'));
    tempDirs.push(tempDir);

    const configPath = path.join(tempDir, 'multiverse-config.yml');
    fs.writeFileSync(
      configPath,
      [
        'server:',
        '  port: 3003',
        '  host: 127.0.0.1',
        'neo4j:',
        '  uri: bolt://localhost:7687',
        '  user: neo4j',
        '  password: test-pass',
        '  database: neo4j',
        'workspace:',
        '  dir: /tmp/workspace',
        '  gitBase: https://git.example.com/scm',
        'cloudConfig:',
        '  baseUrl: ',
        '  defaultProfile: default',
        '  enabled: false',
        '  timeoutMs: 10000',
        'analyze:',
        '  maxConcurrency: 1',
        '  gitTimeoutMs: 1000',
        '  cloneTimeoutMs: 1000',
        'auth:',
        '  users: []',
        'services: []',
        'sinkPatterns:',
        '  - id: yaml-pattern',
        '    name: YAML Pattern',
        '    category: http',
        '    methodPattern: yamlClient\\.get',
        '    targetArgIndex: 0',
        '    languages: [typescript]',
        '    fileExtensions: [.ts, .tsx]',
        '    excludePathPatterns: ["/fixtures/"]',
        '    enabled: true',
        'listenerAnnotations: []',
        'entryPointAnnotations: []',
        'graphRules: []',
        'wiki:',
        '  outputDir: ""',
        '  autoGenerate: false',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(tempDir, 'multiverse-patterns.custom.json'),
      JSON.stringify(
        {
          sinkPatterns: [
            {
              id: 'json-pattern',
              name: 'JSON Pattern',
              category: 'kafka',
              methodPattern: 'jsonClient\\.send',
              targetArgIndex: 0,
              languages: ['java'],
              fileExtensions: ['.java'],
              enabled: true,
            },
          ],
          listenerAnnotations: [
            {
              annotation: 'CustomListener',
              type: 'event',
              topicAttribute: 'value',
              languages: ['python'],
              enabled: true,
            },
          ],
          entryPointAnnotations: [
            {
              annotation: 'CustomJob',
              type: 'job',
              scheduleAttribute: 'value',
              fileExtensions: ['.cs'],
              enabled: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    const config = await loadConfig(configPath);

    expect(config.sinkPatterns.map((pattern) => pattern.id)).toEqual(
      expect.arrayContaining(['yaml-pattern', 'json-pattern']),
    );
    expect(config.sinkPatterns.find((pattern) => pattern.id === 'yaml-pattern')).toMatchObject({
      languages: ['typescript'],
      fileExtensions: ['.ts', '.tsx'],
      excludePathPatterns: ['/fixtures/'],
    });
    expect(config.sinkPatterns.find((pattern) => pattern.id === 'json-pattern')).toMatchObject({
      languages: ['java'],
      fileExtensions: ['.java'],
    });
    expect(config.listenerAnnotations.map((annotation) => annotation.annotation)).toContain(
      'CustomListener',
    );
    expect(
      config.listenerAnnotations.find((annotation) => annotation.annotation === 'CustomListener'),
    ).toMatchObject({ languages: ['python'] });
    expect(config.entryPointAnnotations.map((annotation) => annotation.annotation)).toContain(
      'CustomJob',
    );
    expect(
      config.entryPointAnnotations.find((annotation) => annotation.annotation === 'CustomJob'),
    ).toMatchObject({ fileExtensions: ['.cs'] });
  });
});
