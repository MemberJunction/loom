import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeBuild } from '../src/commands/build.js';
import { executeValidate } from '../src/commands/validate.js';

describe('Loom Downstream Integration Test Suite: More Cheese', () => {
  // Hermetic on purpose: always read the committed fixture, not a sibling more-cheese
  // checkout, so dirty local edits in a sibling workspace cannot make CI flaky.
  const fixtureDataPath = path.resolve(__dirname, 'fixtures/more-cheese-data');
  const tempDir = path.join(os.tmpdir(), `loom-morecheese-${Date.now()}`);
  const metaDir = path.join(tempDir, 'metadata');

  let activeDataPath: string | undefined;

  beforeAll(async () => {
    try {
      await fs.access(fixtureDataPath);
      activeDataPath = fixtureDataPath;
    } catch {
      activeDataPath = undefined;
    }

    if (activeDataPath) {
      await fs.mkdir(metaDir, { recursive: true });
    }
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('generates the complete More Cheese world and passes 100% of validation gates', async (ctx) => {
    if (!activeDataPath) {
      ctx.skip('More Cheese data directory not present');
      return;
    }

    // 1. Build world
    await executeBuild({
      project: activeDataPath,
      seed: '42',
      output: metaDir,
    });

    // 2. Validate
    const report = await executeValidate({
      project: activeDataPath,
      data: metaDir,
    });

    expect(report.passed).toBe(true);
    expect(report.failedCount).toBe(0);
  });
});
