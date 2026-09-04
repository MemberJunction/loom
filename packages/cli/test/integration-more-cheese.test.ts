import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeBuild } from '../src/commands/build.js';
import { executeValidate } from '../src/commands/validate.js';

describe('Loom Downstream Integration Test Suite: More Cheese', () => {
  const moreCheeseDataPath = path.resolve(__dirname, '../../../../more-cheese/data');
  const tempDir = path.join(os.tmpdir(), `loom-morecheese-${Date.now()}`);
  const metaDir = path.join(tempDir, 'metadata');

  let hasMoreCheese = false;

  beforeAll(async () => {
    try {
      await fs.access(moreCheeseDataPath);
      hasMoreCheese = true;
      await fs.mkdir(metaDir, { recursive: true });
    } catch {
      hasMoreCheese = false;
    }
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('generates the complete More Cheese world and passes 100% of validation gates', async () => {
    if (!hasMoreCheese) {
      console.warn('Skipping More Cheese downstream integration test: directory not present');
      return;
    }

    // 1. Build world
    await executeBuild({
      project: moreCheeseDataPath,
      seed: '42',
      output: metaDir,
    });

    // 2. Validate
    const report = await executeValidate({
      project: moreCheeseDataPath,
      data: metaDir,
    });

    expect(report.passed).toBe(true);
    expect(report.failedCount).toBe(0);
    expect(report.totalGates).toBeGreaterThanOrEqual(66);
  });
});
