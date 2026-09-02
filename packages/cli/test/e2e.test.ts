import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { executeBuild } from '../src/commands/build.js';
import { executeAccumulate } from '../src/commands/accumulate.js';
import { executeValidate } from '../src/commands/validate.js';

describe('Loom E2E Fixture Pipeline', () => {
  const fixturePath = path.resolve(__dirname, '../../../projects/fixture');
  const tempOutputDir = path.resolve(__dirname, '../../../projects/fixture/test-output');
  const tempMetadataDir = path.join(tempOutputDir, 'metadata');

  beforeAll(async () => {
    await fs.mkdir(tempOutputDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempOutputDir, { recursive: true, force: true });
    await fs.rm(path.resolve(__dirname, '../../../projects/fixture/migrations'), {
      recursive: true,
      force: true,
    });
  });

  it('builds full baseline, validates gates, accumulates delta, and re-validates', async () => {
    // 1. Build baseline into test-output/metadata
    await executeBuild({
      project: fixturePath,
      seed: '101',
      output: tempMetadataDir,
    });

    const orgFile = path.join(tempMetadataDir, 'common', 'Organization.json');
    const personFile = path.join(tempMetadataDir, 'common', 'Person.json');

    const orgs = JSON.parse(await fs.readFile(orgFile, 'utf8'));
    const people = JSON.parse(await fs.readFile(personFile, 'utf8'));

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

    const updatedPeople = JSON.parse(await fs.readFile(personFile, 'utf8'));
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
