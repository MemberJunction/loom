import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DevelopmentBranch,
  DistTag,
  MainLine,
  OpenLines,
  ResolveBranch,
  ValidateRecord,
  ValidateTransition,
} from '../release-lines.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const line = (key, extra = {}) => ({
  branch: `lts/${key}`,
  status: 'open',
  version: `${key}.0`,
  releasesThrough: 'branch',
  ...extra,
});
const record = (lines, developmentBranch = 'next') => ({ developmentBranch, lines });

test('the committed release-lines.json is valid', () => {
  const committed = JSON.parse(readFileSync(join(ROOT, 'release-lines.json'), 'utf8'));
  assert.deepEqual(ValidateRecord(committed), []);
});

test('a single branch-releasing line and a two-line record are both valid', () => {
  assert.deepEqual(ValidateRecord(record({ '0.1': line('0.1') })), []);
  const two = record({
    '0.1': line('0.1', { status: 'lts' }),
    '0.2': line('0.2', { releasesThrough: 'main' }),
  });
  assert.deepEqual(ValidateRecord(two), []);
});

test('at most one line releases through main, and if present it is the newest', () => {
  const twoMains = record({
    '0.1': line('0.1', { releasesThrough: 'main' }),
    '0.2': line('0.2', { releasesThrough: 'main' }),
  });
  assert.ok(ValidateRecord(twoMains).some((p) => p.includes('at most one')));
  const olderMain = record({
    '0.1': line('0.1', { releasesThrough: 'main' }),
    '0.2': line('0.2'),
  });
  assert.ok(ValidateRecord(olderMain).some((p) => p.includes('newest line (0.2)')));
});

test('branch, version, status, and developmentBranch are checked', () => {
  const bad = record(
    {
      '0.1': line('0.1', {
        branch: 'release/0.1',
        version: '0.2.0',
        status: 'frozen',
        releasesThrough: 'invalid',
      }),
    },
    'develop',
  );
  const problems = ValidateRecord(bad);
  assert.ok(problems.some((p) => p.includes('developmentBranch must be')));
  assert.ok(problems.some((p) => p.includes('branch must be "lts/0.1"')));
  assert.ok(problems.some((p) => p.includes('version must be a 0.1.x')));
  assert.ok(problems.some((p) => p.includes('status must be')));
  assert.ok(problems.some((p) => p.includes('releasesThrough must be')));
});

test('an LTS line never reopens, and a line keeps its branch and version', () => {
  const before = record({ '0.1': line('0.1', { status: 'lts' }) });
  const reopened = record({ '0.1': line('0.1', { status: 'open' }) });
  assert.equal(ValidateTransition(before, reopened).length, 1);
  const moved = record({ '0.1': line('0.1', { status: 'lts', version: '0.1.3', branch: 'lts/1.0' }) });
  assert.equal(ValidateTransition(before, moved).length, 2);
  const frozen = record({ '0.1': line('0.1', { status: 'lts' }) });
  assert.deepEqual(ValidateTransition(record({ '0.1': line('0.1') }), frozen), []);
});

test('resolving branches, dist-tags, open lines, and developmentBranch', () => {
  const r = record(
    {
      '0.1': line('0.1', { status: 'lts', version: '0.1.0' }),
      '0.2': line('0.2', { version: '0.2.0', releasesThrough: 'main' }),
    },
    'main',
  );
  assert.equal(DevelopmentBranch(r), 'main');
  assert.equal(ResolveBranch(r, 'lts/0.1').distTag, 'lts-0.1');
  assert.equal(MainLine(r).distTag, 'latest');
  assert.equal(OpenLines(r).length, 1);
  assert.equal(ResolveBranch(r, 'next'), null);
  assert.equal(DistTag({ key: '0.2', releasesThrough: 'main' }), 'latest');
});

for (const script of ['release-lines.mjs', 'check-backport.mjs']) {
  test(`${script} --self-test`, () => {
    const run = spawnSync(process.execPath, [join(HERE, '..', script), '--self-test'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
}
