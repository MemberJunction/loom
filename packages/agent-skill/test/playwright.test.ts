import { describe, it, expect, vi } from 'vitest';
import { runVisualInspection } from '../src/playwright/explorer.js';

// Mock playwright so unit tests run deterministically on any machine without browser binaries
vi.mock('playwright', () => {
  return {
    chromium: {
      launch: vi.fn().mockImplementation(async () => {
        return {
          newPage: vi.fn().mockImplementation(async () => {
            const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

            return {
              on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
                listeners[event] = listeners[event] ?? [];
                listeners[event]!.push(handler);
              }),
              goto: vi.fn().mockImplementation(async (url: string) => {
                if (url.includes('59999')) {
                  throw new Error(`net::ERR_CONNECTION_REFUSED at ${url}`);
                }
              }),
              waitForLoadState: vi.fn().mockResolvedValue(undefined),
              $: vi.fn().mockResolvedValue(null),
            };
          }),
          close: vi.fn().mockResolvedValue(undefined),
        };
      }),
    },
  };
});

describe('runVisualInspection', () => {
  it('correctly catches infrastructure network failures', async () => {
    const result = await runVisualInspection({
      explorerUrl: 'http://127.0.0.1:59999',
      routesToInspect: ['/dashboards/test'],
      timeoutMs: 1000,
    });

    expect(result.passed).toBe(false);
    expect(result.infrastructureErrors.length).toBeGreaterThan(0);
    expect(result.infrastructureErrors[0]).toContain('ERR_CONNECTION_REFUSED');
  });
});
