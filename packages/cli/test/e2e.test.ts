import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeBuild } from '../src/commands/build.js';
import { executeAccumulate } from '../src/commands/accumulate.js';
import { executeValidate } from '../src/commands/validate.js';
import { readEntityMetadata } from '@memberjunction/loom-engine';

describe('Loom E2E Fixture Pipeline', () => {
  const fixturePath = path.resolve(__dirname, '../../../projects/fixture');
  const tempOutputDir = path.join(os.tmpdir(), `loom-e2e-${Date.now()}`);
  const tempMetadataDir = path.join(tempOutputDir, 'metadata');

  beforeAll(async () => {
    await fs.mkdir(tempOutputDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempOutputDir, { recursive: true, force: true });
  });

  it('builds full baseline, validates gates, accumulates delta, and re-validates', async () => {
    // 1. Build baseline into isolated temp directory
    await executeBuild({
      project: fixturePath,
      seed: '101',
      output: tempMetadataDir,
    });

    const { records: orgs } = await readEntityMetadata(
      path.join(tempMetadataDir, 'Organization'),
      'Fixture: Organizations'
    );
    const { records: people } = await readEntityMetadata(
      path.join(tempMetadataDir, 'Person'),
      'Fixture: People'
    );

    expect(orgs.length).toBe(10);
    expect(people.length).toBe(10);

    // 2. Validate baseline dataset
    const report1 = await executeValidate({
      project: fixturePath,
      data: tempMetadataDir,
    });
    expect(report1.passed).toBe(true);
    expect(report1.failedCount).toBe(0);

    // 3. Accumulate 1 week
    await executeAccumulate({
      project: fixturePath,
      priorState: tempMetadataDir,
      output: tempMetadataDir,
      weeks: '1',
      seed: '101',
    });

    const { records: updatedPeople } = await readEntityMetadata(
      path.join(tempMetadataDir, 'Person'),
      'Fixture: People'
    );
    expect(updatedPeople.length).toBe(12); // 10 baseline + 2 accumulated

    // 4. Validate accumulated dataset
    const report2 = await executeValidate({
      project: fixturePath,
      data: tempMetadataDir,
    });
    expect(report2.passed).toBe(true);
    expect(report2.failedCount).toBe(0);
  });
});
