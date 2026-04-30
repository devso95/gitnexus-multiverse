import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectEntryPoints } from '../../src/multiverse/engine/entrypoint-detector.js';
import {
  resolveEntryPointAnnotations,
  resolveListenerAnnotations,
} from '../../src/multiverse/engine/sink-patterns.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('collectEntryPoints', () => {
  it('detects real language-specific entrypoints and skips cross-language false positives', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mv-entrypoints-'));
    tempDirs.push(tempDir);

    fs.mkdirSync(path.join(tempDir, 'src', 'main', 'java'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src', 'server'), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, 'src', 'server', 'routes.ts'),
      [
        'import { Router } from "express";',
        'const router = Router();',
        "router.post('/:id/analyze', async (_req, _res) => {});",
        'export default router;',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(tempDir, 'src', 'server', 'fake.ts'),
      [
        '/**',
        ' * @KafkaListener(topics = "ghost-topic")',
        ' * @Scheduled(cron = "* * * * *")',
        ' * @GetMapping("/ghost")',
        ' */',
        'export const docs = "@KafkaListener(topics = \"ghost-topic\")";',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(tempDir, 'src', 'main', 'java', 'DemoController.java'),
      [
        'import org.springframework.scheduling.annotation.Scheduled;',
        'import org.springframework.kafka.annotation.KafkaListener;',
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.RequestMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '',
        '@RestController',
        '@RequestMapping("/api")',
        'public class DemoController {',
        '  @GetMapping("/health")',
        '  public String health() { return "ok"; }',
        '',
        '  @KafkaListener(topics = "orders")',
        '  public void consume(String payload) {}',
        '',
        '  @Scheduled(cron = "0 * * * * *")',
        '  public void tick() {}',
        '}',
      ].join('\n'),
    );

    const result = collectEntryPoints(
      'demo-service',
      tempDir,
      resolveListenerAnnotations(),
      resolveEntryPointAnnotations(),
    );

    expect(result.routes.map((route) => route.name)).toEqual(
      expect.arrayContaining(['/:id/analyze', '/api/health']),
    );
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({
      filePath: 'src/main/java/DemoController.java',
      topic: 'orders',
      listenerType: 'kafka',
    });
    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0].filePath).toBe('src/main/java/DemoController.java');
    expect(result.routes.some((route) => route.filePath.endsWith('fake.ts'))).toBe(false);
    expect(result.listeners.some((listener) => listener.filePath.endsWith('fake.ts'))).toBe(false);
    expect(result.scheduled.some((listener) => listener.filePath.endsWith('fake.ts'))).toBe(false);
  });
});
