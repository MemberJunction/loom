#!/usr/bin/env node
// ==============================================================================
// Standalone release line status record (release-lines.json): read, validate, resolve
//
// Lists every release line of this standalone repository: the branch (`lts/<major>.<minor>`),
// the version the line was cut at, whether it is `open` or `lts`, and whether it releases through
// `main` (dist-tag `latest`) or from its own branch (dist-tag `lts-<line>`).
//
// CI reads the copy on the repository's development branch. A line branch carries its own snapshot
// from the cut, but that copy is never consulted to override line status or publishing routes.
//
// Usage:
//   node release-lines.mjs validate [--file F | --ref R] [--base R]   structure + transitions vs --base
//   node release-lines.mjs resolve <branch> [--file F | --ref R]      JSON for the line on <branch>, or {}
//   node release-lines.mjs main-line [--file F | --ref R]             JSON for the line released through main
//   node release-lines.mjs open-lines [--file F | --ref R]            JSON array of open lines
//   node release-lines.mjs dev-branch [--file F | --ref R]            prints developmentBranch
//   node release-lines.mjs --self-test
// ==============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RECORD_PATH = 'release-lines.json';
const DEFAULT_REF = 'origin/next';
const LINE_KEY = /^(\d+)\.(\d+)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const DEV_BRANCHES = new Set(['next', 'main']);
const STATUSES = new Set(['open', 'lts']);
const ROUTES = new Set(['main', 'branch']);

/** Parses the record from a working-tree file. */
export function LoadRecordFromFile(file = RECORD_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Parses the record as it stands at a git ref, or returns null when the ref has none. */
export function LoadRecordFromRef(ref = DEFAULT_REF) {
  try {
    const text = execFileSync('git', ['show', `${ref}:${RECORD_PATH}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Every line as `{ key, ...fields }`, in record order. */
export function Lines(record) {
  return Object.entries(record?.lines ?? {}).map(([key, line]) => ({ key, ...line }));
}

/** npm dist-tag a line publishes under: `latest` through main, `lts-<line>` from its own branch. */
export function DistTag(line) {
  return line.releasesThrough === 'main' ? 'latest' : `lts-${line.key}`;
}

/** The line whose branch is `branch`, with derived fields, or null. */
export function ResolveBranch(record, branch) {
  const line = Lines(record).find((l) => l.branch === branch);
  return line ? Describe(line) : null;
}

/** The line released through main, or null. */
export function MainLine(record) {
  const line = Lines(record).find((l) => l.releasesThrough === 'main');
  return line ? Describe(line) : null;
}

/** Open lines, with derived fields. */
export function OpenLines(record) {
  return Lines(record).filter((l) => l.status === 'open').map(Describe);
}

/** The configured development branch name (`next` or `main`). */
export function DevelopmentBranch(record) {
  return record?.developmentBranch ?? 'next';
}

function Describe(line) {
  return { ...line, distTag: DistTag(line) };
}

/** Structural problems with a record, as readable lines. Empty when valid. */
export function ValidateRecord(record) {
  const problems = [];
  if (!record || typeof record !== 'object') {
    return ['the record is not a JSON object'];
  }
  if (!DEV_BRANCHES.has(record.developmentBranch)) {
    problems.push(`developmentBranch must be "next" or "main" (got "${record.developmentBranch}")`);
  }
  const lines = Lines(record);
  if (lines.length === 0) {
    problems.push('lines is empty: at least one line must exist');
  }
  for (const line of lines) {
    const where = `lines["${line.key}"]`;
    const key = LINE_KEY.exec(line.key);
    if (!key) {
      problems.push(`${where}: the key must be major.minor, e.g. "0.1" or "1.0"`);
      continue;
    }
    if (line.branch !== `lts/${line.key}`) {
      problems.push(`${where}: branch must be "lts/${line.key}" (got "${line.branch}")`);
    }
    if (!STATUSES.has(line.status)) {
      problems.push(`${where}: status must be "open" or "lts" (got "${line.status}")`);
    }
    if (!ROUTES.has(line.releasesThrough)) {
      problems.push(`${where}: releasesThrough must be "main" or "branch" (got "${line.releasesThrough}")`);
    }
    const ver = SEMVER.exec(line.version ?? '');
    if (!ver || ver[1] !== key[1] || ver[2] !== key[2]) {
      problems.push(`${where}: version must be a ${line.key}.x semver (got "${line.version}")`);
    }
  }
  const throughMain = lines.filter((l) => l.releasesThrough === 'main');
  if (throughMain.length > 1) {
    problems.push(`at most one line may release through main (found ${throughMain.length}): main can follow only one line's history`);
  }
  if (throughMain.length === 1) {
    const newest = [...lines].sort(CompareKeys).at(-1);
    if (newest.key !== throughMain[0].key) {
      problems.push(`the line released through main must be the newest line (${newest.key}), not ${throughMain[0].key}`);
    }
  }
  return problems;
}

/** Problems with going from `base` to `head`. A line's identity never changes; LTS is final. */
export function ValidateTransition(base, head) {
  const problems = [];
  const before = new Map(Lines(base).map((l) => [l.key, l]));
  for (const line of Lines(head)) {
    const was = before.get(line.key);
    if (!was) {
      continue; // a new line: a cut
    }
    for (const field of ['branch', 'version']) {
      if (was[field] !== line[field]) {
        problems.push(`lines["${line.key}"].${field} changed from "${was[field]}" to "${line[field]}": a line's ${field} is fixed when it is cut`);
      }
    }
    if (was.status === 'lts' && line.status !== 'lts') {
      problems.push(`lines["${line.key}"] goes from lts back to ${line.status}: an LTS line never reopens`);
    }
  }
  return problems;
}

function CompareKeys(a, b) {
  const [, am, an] = LINE_KEY.exec(a.key);
  const [, bm, bn] = LINE_KEY.exec(b.key);
  return Number(am) - Number(bm) || Number(an) - Number(bn);
}

// ---------------------------------------------------------------------------
// CLI & Self-test
// ---------------------------------------------------------------------------
function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function load(args) {
  const file = option(args, '--file');
  if (file) {
    return LoadRecordFromFile(file);
  }
  const ref = option(args, '--ref') ?? DEFAULT_REF;
  const record = LoadRecordFromRef(ref);
  if (!record) {
    console.error(`✗ no ${RECORD_PATH} at ${ref}. Fetch it first: git fetch --no-tags origin ${ref.replace(/^origin\//, '')}`);
    process.exit(2);
  }
  return record;
}

function selfTest() {
  const mk = (key, extra = {}) => ({
    branch: `lts/${key}`,
    status: 'open',
    version: `${key}.0`,
    releasesThrough: 'branch',
    ...extra,
  });
  const cases = [
    ['valid single branch-releasing line', ValidateRecord({ developmentBranch: 'next', lines: { '0.1': mk('0.1') } }), 0],
    ['valid two-line record with newest on main', ValidateRecord({ developmentBranch: 'main', lines: { '0.1': mk('0.1', { status: 'lts' }), '0.2': mk('0.2', { releasesThrough: 'main' }) } }), 0],
    ['two main lines fail', ValidateRecord({ developmentBranch: 'main', lines: { '0.1': mk('0.1', { releasesThrough: 'main' }), '0.2': mk('0.2', { releasesThrough: 'main' }) } }), 1],
    ['older line on main fails', ValidateRecord({ developmentBranch: 'main', lines: { '0.1': mk('0.1', { releasesThrough: 'main' }), '0.2': mk('0.2') } }), 1],
    ['mismatched version fails', ValidateRecord({ developmentBranch: 'next', lines: { '0.1': mk('0.1', { version: '0.2.0' }) } }), 1],
    ['reopening LTS fails', ValidateTransition({ developmentBranch: 'next', lines: { '0.1': mk('0.1', { status: 'lts' }) } }, { developmentBranch: 'next', lines: { '0.1': mk('0.1', { status: 'open' }) } }), 1],
    ['freezing open to LTS passes', ValidateTransition({ developmentBranch: 'next', lines: { '0.1': mk('0.1', { status: 'open' }) } }, { developmentBranch: 'next', lines: { '0.1': mk('0.1', { status: 'lts' }) } }), 0],
  ];
  let failed = 0;
  for (const [name, problems, want] of cases) {
    const ok = (problems.length > 0 ? 1 : 0) === want;
    failed += ok ? 0 : 1;
    console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — got: ${problems.join(' | ')}`}`);
  }
  console.log(failed === 0 ? '\nSelf-test passed.' : `\nSelf-test FAILED: ${failed}.`);
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === '--self-test') {
    return selfTest();
  }
  switch (command) {
    case 'validate': {
      const record = load(args);
      const problems = ValidateRecord(record);
      const baseRef = option(args, '--base');
      if (baseRef) {
        const base = LoadRecordFromRef(baseRef);
        if (base) {
          problems.push(...ValidateTransition(base, record));
        }
      }
      if (problems.length > 0) {
        for (const p of problems) {
          console.log(`::error file=${RECORD_PATH}::${p}`);
        }
        return 1;
      }
      console.log(`✓ ${RECORD_PATH}: ${Lines(record).map((l) => `${l.key} ${l.status}`).join(', ')}`);
      return 0;
    }
    case 'resolve': {
      const branch = args[0];
      if (!branch || branch.startsWith('--')) {
        console.error('usage: release-lines.mjs resolve <branch>');
        return 2;
      }
      console.log(JSON.stringify(ResolveBranch(load(args.slice(1)), branch) ?? {}));
      return 0;
    }
    case 'main-line':
      console.log(JSON.stringify(MainLine(load(args)) ?? {}));
      return 0;
    case 'open-lines':
      console.log(JSON.stringify(OpenLines(load(args))));
      return 0;
    case 'dev-branch':
      console.log(DevelopmentBranch(load(args)));
      return 0;
    default:
      console.error('usage: release-lines.mjs validate|resolve|main-line|open-lines|dev-branch|--self-test [--file F | --ref R]');
      return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
