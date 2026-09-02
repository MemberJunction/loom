import { describe, it, expect } from 'vitest';
import { runVisualInspection } from '../src/playwright/explorer.js';

describe('runVisualInspection', () => {
  it('correctly catches infrastructure/network failure when host is unavailable or browser is not running', async () => {
    const result = await runVisualInspection({
      explorerUrl: 'http://127.0.0.1:59999',
      routesToInspect: ['/dashboards/test'],
      timeoutMs: 1000,
    });

    expect(result.passed).toBe(false);
    expect(result.infrastructureErrors.length).toBeGreaterThan(0);
  });
});
