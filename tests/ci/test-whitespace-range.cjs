const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveWhitespaceRange, checkWhitespace } = require('./validate-security-checks.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pam047-whitespace-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const checks = [];
function git(...args) {
  const result = spawnSync('git', ['-c', 'user.name=PAM047 fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function record(name, body) { body(); checks.push(name); }
function save(name, text) { fs.writeFileSync(path.join(repo, name), text); }
function commit(name) { git('add', '.'); git('commit', '-m', name); return git('rev-parse', 'HEAD'); }
function event(name, payload, sha) {
  const file = path.join(tmp, name + '.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file, GITHUB_SHA: sha };
}
try {
  git('init', '-b', 'candidate');
  save('content.txt', 'initial\n');
  const initial = commit('initial');
  save('content.txt', 'valid change\n');
  const before = commit('valid change');
  record('local normal committed difference PASS', () => assert.equal(checkWhitespace(repo, { ARA_CI_BASE_SHA: initial }).base, initial));
  save('bad.txt', 'committed trailing whitespace \n');
  const bad = commit('bad whitespace');
  save('later.txt', 'later clean change\n');
  const after = commit('second commit in same push');
  record('negative fixture is a clean checkout', () => assert.equal(git('status', '--porcelain'), ''));
  record('old HEAD check falsely passes on committed bad whitespace', () => git('diff', '--check', 'HEAD'));
  record('actual checker exits nonzero on committed trailing whitespace', () => {
    const child = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).checkWhitespace(process.argv[2], JSON.parse(process.argv[3]));', path.join(__dirname, 'validate-security-checks.cjs'), repo, JSON.stringify({ ARA_CI_BASE_SHA: before })], { encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /trailing whitespace/);
  });
  record('local committed bad difference FAIL', () => assert.throws(() => checkWhitespace(repo, { ARA_CI_BASE_SHA: before }), /trailing whitespace/));
  record('local unchanged historical bad content outside range is excluded', () => checkWhitespace(repo, { ARA_CI_BASE_SHA: bad }));
  const push = event('push', { before, after, deleted: false }, after);
  record('push uses full before-after range, not only last parent', () => {
    git('diff', '--check', bad, after);
    assert.deepEqual(resolveWhitespaceRange(repo, push).args, ['diff', '--check', before, after, '--']);
    assert.throws(() => checkWhitespace(repo, push), /trailing whitespace/);
  });
  record('push normal before-after difference PASS', () => checkWhitespace(repo, event('push', { before: bad, after }, after)));
  record('invalid local SHA FAIL', () => assert.throws(() => checkWhitespace(repo, { ARA_CI_BASE_SHA: 'HEAD~1' }), /Invalid full commit SHA/));
  record('missing local base FAIL', () => assert.throws(() => checkWhitespace(repo, {}), /Invalid full commit SHA/));
  record('zero before SHA FAIL without fallback', () => assert.throws(() => checkWhitespace(repo, event('push', { before: '0'.repeat(40), after }, after)), /Invalid full commit SHA/));
  record('missing Git object FAIL', () => assert.throws(() => checkWhitespace(repo, { ARA_CI_BASE_SHA: 'f'.repeat(40) }), /Git check failed/));
  const blob = git('rev-parse', 'HEAD:later.txt');
  record('blob SHA cannot be a base commit', () => assert.throws(() => checkWhitespace(repo, { ARA_CI_BASE_SHA: blob }), /not a commit/));
  record('identical endpoints FAIL', () => assert.throws(() => checkWhitespace(repo, { ARA_CI_BASE_SHA: after }), /Identical range/));
  record('GitHub checkout SHA mismatch FAIL', () => assert.throws(() => checkWhitespace(repo, event('push', { before, after }, bad)), /checkout SHA mismatch/));
  record('push payload after mismatch FAIL', () => assert.throws(() => checkWhitespace(repo, event('push', { before, after: bad }, after)), /after mismatch/));
  record('deleted push FAIL', () => assert.throws(() => checkWhitespace(repo, event('push', { before, after, deleted: true }, after)), /deleted ref/));
  record('unsupported GitHub event FAIL', () => assert.throws(() => checkWhitespace(repo, event('workflow_dispatch', {}, after)), /Unsupported GitHub event/));
  record('GitHub local override does not replace event base', () => assert.equal(resolveWhitespaceRange(repo, { ...event('push', { before, after }, after), ARA_CI_BASE_SHA: bad }).base, before));
  record('PR checked-out head normal range PASS', () => checkWhitespace(repo, event('pull_request', { pull_request: { base: { sha: bad }, head: { sha: after } } }, after)));
  git('checkout', '-b', 'base-side', before);
  save('base-only.txt', 'independent base update\n');
  const prBase = commit('base update');
  git('merge', '--no-ff', after, '-m', 'synthetic PR merge checkout');
  const merge = git('rev-parse', 'HEAD');
  const pr = event('pull_request', { pull_request: { base: { sha: prBase }, head: { sha: after } } }, merge);
  record('PR merge checkout targets actual merge SHA and event base', () => {
    assert.equal(git('status', '--porcelain'), '');
    assert.deepEqual(resolveWhitespaceRange(repo, pr).args, ['diff', '--check', prBase, merge, '--']);
    assert.throws(() => checkWhitespace(repo, pr), /trailing whitespace/);
  });
  record('PR malformed base SHA FAIL', () => assert.throws(() => checkWhitespace(repo, event('pull_request', { pull_request: { base: { sha: '--help' }, head: { sha: after } } }, merge)), /Invalid full commit SHA/));
  record('missing GitHub event payload FAIL', () => assert.throws(() => checkWhitespace(repo, { GITHUB_ACTIONS: 'true', GITHUB_SHA: merge }), /payload is required/));
  save('uncommitted.txt', 'not yet committed\n');
  record('dirty checkout FAIL rather than omitting changes', () => assert.throws(() => checkWhitespace(repo, { ARA_CI_BASE_SHA: before }), /clean committed checkout/));
  console.log(JSON.stringify({ task: 'PAM-047', passed: checks.length, failed: 0, checks, real_github_actions: 'NOT_RUN' }, null, 2));
} finally {
  assert.equal(path.dirname(tmp), os.tmpdir());
  assert(path.basename(tmp).startsWith('pam047-whitespace-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
