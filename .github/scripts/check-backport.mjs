#!/usr/bin/env node
// ==============================================================================
// Standalone backport checks: every change lands on the development branch first,
// then reaches each release line by cherry-pick.
//
// labels      (a PR into the development branch) Verifies that every `backport lts/X.Y`
//             label on the PR names a real release line in release-lines.json.
//
// provenance  (a PR into `lts/X.Y`) Proves the change is already on the development branch.
//             Every commit carries the `(cherry picked from commit <sha>)` line that
//             `git cherry-pick -x` / the backport workflow writes, and `<sha>` is an ancestor
//             of a configured development ref (`--next`). A hand-written conflict-resolution
//             commit is allowed only when the `backport-adjusted` label is present and at least
//             one commit is proven. Exempt: Bot-opened release PRs (`changeset-release/*`,
//             `release-back-merge/*`), and a line cut carrying the `line-cut` label applied by
//             a repository maintainer or admin.
//
// Usage:
//   node check-backport.mjs labels     --labels '<json array>' [--record release-lines.json]
//   node check-backport.mjs provenance --base <merge-base sha> --labels '<json array>'
//                                      [--next origin/next ...] [--head-ref <branch>]
//                                      [--author-type Bot|User]
//   node check-backport.mjs --self-test
// Env for `line-cut`: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER (looks up who added the label).
// ==============================================================================
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LoadRecordFromFile, Lines } from './release-lines.mjs';

const BACKPORT_LABEL = /^backport (lts\/\d+\.\d+)$/;
const CHERRY = /\(cherry picked from commit ([0-9a-f]{7,40})\)/g;
const APP_HEADS = ['changeset-release/', 'release-back-merge/'];

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Problems for a PR into the development branch: every backport label must name a known line. */
export function CheckLabels(record, labels) {
  const problems = [];
  const byBranch = new Map(Lines(record).map((l) => [l.branch, l]));
  const targets = labels.map((l) => BACKPORT_LABEL.exec(l)?.[1]).filter(Boolean);
  for (const t of targets) {
    if (!byBranch.has(t)) {
      problems.push(`label "backport ${t}": ${t} is not a line in release-lines.json.`);
    }
  }
  return problems;
}

/** Problems for a PR into a line. `commits` = [{ sha, message }]; `onDev(sha)` = is it on the dev branch. */
export function CheckProvenance(commits, onDev, adjusted) {
  const problems = [];
  const unproven = [];
  let proven = 0;
  for (const { sha, message } of commits) {
    const sources = [...message.matchAll(CHERRY)].map((m) => m[1]);
    if (sources.length > 0 && sources.every(onDev)) {
      proven++;
    } else {
      unproven.push(
        `${sha.slice(0, 10)} ${message.split('\n')[0]}${
          sources.length > 0 ? ` (cherry-picked from ${sources.join(', ')}, which is not on the development branch)` : ''
        }`,
      );
    }
  }
  if (commits.length === 0) {
    problems.push('This PR has no commits of its own to check.');
  } else if (proven === 0) {
    problems.push(
      `No commit in this PR was cherry-picked from the development branch. Land the change there first, then add the "backport <line>" label to the merged PR; the bot opens this PR for you. Commits:\n  ${unproven.join('\n  ')}`,
    );
  } else if (unproven.length > 0 && !adjusted) {
    problems.push(
      `These commits are not cherry-picks from the development branch:\n  ${unproven.join('\n  ')}\nIf they only resolve a cherry-pick conflict, add the "backport-adjusted" label so a reviewer checks them. Anything else lands on the development branch first.`,
    );
  }
  return problems;
}

/** Login and repository role of whoever last added `label` to the PR, via the GitHub API. */
function labelApplierRole(label) {
  const { GITHUB_REPOSITORY: repo, PR_NUMBER: pr } = process.env;
  try {
    const login = execFileSync(
      'gh',
      [
        'api',
        '--paginate',
        `repos/${repo}/issues/${pr}/events`,
        '--jq',
        `.[] | select(.event == "labeled" and .label.name == "${label}") | .actor.login`,
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .at(-1);
    if (!login) {
      return { login: '', role: '' };
    }
    const role = execFileSync(
      'gh',
      ['api', `repos/${repo}/collaborators/${login}/permission`, '--jq', '.role_name'],
      { encoding: 'utf8' },
    ).trim();
    return { login, role };
  } catch {
    return { login: '', role: '' };
  }
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function options(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      for (const part of args[i + 1].split(',')) {
        const trimmed = part.trim();
        if (trimmed) {
          values.push(trimmed);
        }
      }
      i++;
    }
  }
  return values;
}

function report(problems, ok) {
  for (const p of problems) {
    console.log(`::error::${p.replace(/\n/g, '%0A')}`);
  }
  if (problems.length === 0) {
    console.log(ok);
  }
  return problems.length > 0 ? 1 : 0;
}

function main(args) {
  const [mode] = args;
  const labels = JSON.parse(option(args, '--labels') ?? '[]');
  if (mode === 'labels') {
    const record = LoadRecordFromFile(option(args, '--record') ?? 'release-lines.json');
    const problems = CheckLabels(record, labels);
    return report(problems, '✓ All backport labels reference known release lines');
  }
  if (mode === 'provenance') {
    const base = option(args, '--base');
    if (!base) {
      console.error('✗ --base <merge-base sha> is required');
      return 2;
    }
    const headRef = option(args, '--head-ref') ?? '';
    if (option(args, '--author-type') === 'Bot' && APP_HEADS.some((h) => headRef.startsWith(h))) {
      console.log(`✓ ${headRef} is a release PR opened by the App; nothing to trace to the development branch`);
      return 0;
    }
    if (labels.includes('line-cut')) {
      const { login, role } = labelApplierRole('line-cut');
      if (role === 'admin' || role === 'maintain') {
        console.log(`✓ Line cut (line-cut label added by ${login}, ${role})`);
        return 0;
      }
      return report(
        [
          `The "line-cut" label was added by ${login || 'someone unknown'} (${role || 'no role found'}); only a maintainer or admin may mark a PR as a line cut.`,
        ],
        '',
      );
    }
    const devRefs = options(args, '--next');
    if (devRefs.length === 0) {
      devRefs.push('origin/next');
    }
    const shas = git(['rev-list', '--no-merges', `${base}..HEAD`]).split('\n').filter(Boolean);
    const commits = shas.map((sha) => ({ sha, message: git(['log', '-1', '--format=%B', sha]) }));
    const onDev = (sha) =>
      devRefs.some((ref) => {
        try {
          git(['merge-base', '--is-ancestor', sha, ref]);
          return true;
        } catch {
          return false;
        }
      });
    const problems = CheckProvenance(commits, onDev, labels.includes('backport-adjusted'));
    return report(
      problems,
      `✓ Every commit is a cherry-pick of a commit on ${devRefs.join(' or ')}${
        labels.includes('backport-adjusted') ? ' (conflict fixes allowed by backport-adjusted)' : ''
      }`,
    );
  }
  console.error('usage: check-backport.mjs labels|provenance|--self-test ...');
  return 2;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function selfTest() {
  const record = {
    developmentBranch: 'next',
    lines: {
      '0.1': { branch: 'lts/0.1', status: 'open', version: '0.1.0', releasesThrough: 'branch' },
      '0.2': { branch: 'lts/0.2', status: 'open', version: '0.2.0', releasesThrough: 'main' },
    },
  };
  const onDev = (sha) => sha.startsWith('aaa');
  const pick = (sha, from) => ({ sha, message: `fix: thing\n\n(cherry picked from commit ${from})` });
  const cases = [
    ['no labels passes', CheckLabels(record, []), 0],
    ['unrelated labels pass', CheckLabels(record, ['bug', 'enhancement']), 0],
    ['valid backport label passes', CheckLabels(record, ['backport lts/0.1']), 0],
    ['multiple valid backport labels pass', CheckLabels(record, ['backport lts/0.1', 'backport lts/0.2']), 0],
    ['unknown backport line fails', CheckLabels(record, ['backport lts/9.9']), 1],
    ['cherry-picks of dev commits pass', CheckProvenance([pick('b1', 'aaa1111'), pick('b2', 'aaa2222')], onDev, false), 0],
    ['cherry-pick of commit not on dev fails', CheckProvenance([pick('b1', 'fff1111')], onDev, false), 1],
    ['commit with no trailer fails', CheckProvenance([pick('b1', 'aaa1111'), { sha: 'b2', message: 'fix conflict' }], onDev, false), 1],
    ['conflict fix passes with backport-adjusted', CheckProvenance([pick('b1', 'aaa1111'), { sha: 'b2', message: 'fix conflict' }], onDev, true), 0],
    ['backport-adjusted alone is not enough', CheckProvenance([{ sha: 'b2', message: 'new work' }], onDev, true), 1],
    ['empty commit list fails', CheckProvenance([], onDev, false), 1],
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  process.exit(args[0] === '--self-test' ? selfTest() : main(args));
}
