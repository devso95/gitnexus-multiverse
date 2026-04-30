import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSyncMock, getServiceMock, loadConfigMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(),
  getServiceMock: vi.fn(),
  loadConfigMock: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
  },
}));

vi.mock('../../src/multiverse/admin/service-registry.js', () => ({
  getService: getServiceMock,
}));

vi.mock('../../src/multiverse/config/loader.js', () => ({
  loadConfig: loadConfigMock,
}));

import { resolveServiceRepoPath } from '../../src/multiverse/util/repo-path.js';

describe('resolveServiceRepoPath', () => {
  beforeEach(() => {
    loadConfigMock.mockResolvedValue({
      workspace: { dir: '/workspace' },
    });
    existsSyncMock.mockReset();
    getServiceMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prefers localPath when it exists', async () => {
    getServiceMock.mockResolvedValue({ localPath: '/home/deso/Workspace/orders', repoSlug: 'orders-repo' });
    existsSyncMock.mockImplementation((value: string) => value === '/home/deso/Workspace/orders');

    await expect(resolveServiceRepoPath('orders')).resolves.toEqual({
      repoPath: '/home/deso/Workspace/orders',
      source: 'localPath',
    });
  });

  it('falls back to repoSlug inside workspace when localPath is absent', async () => {
    getServiceMock.mockResolvedValue({ repoSlug: 'billing-service' });
    existsSyncMock.mockImplementation((value: string) => value === '/workspace/billing-service');

    await expect(resolveServiceRepoPath('billing')).resolves.toEqual({
      repoPath: '/workspace/billing-service',
      source: 'repoSlug',
    });
  });

  it('falls back to workspace/serviceId when no candidate exists yet', async () => {
    getServiceMock.mockResolvedValue(null);
    existsSyncMock.mockReturnValue(false);

    await expect(resolveServiceRepoPath('inventory')).resolves.toEqual({
      repoPath: '/workspace/inventory',
      source: 'serviceId',
    });
  });
});

