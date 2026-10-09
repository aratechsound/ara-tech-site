const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = '/workspace/outputs';
const results = [];
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`Git check failed: ${args[0]}: ${result.error?.code || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function commit(cwd, sha) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha)) throw Error('Invalid full commit SHA');
  if (git(cwd, ['cat-file', '-t', sha]) !== 'commit') throw Error('SHA is not a commit object');
  return sha;
}
function resolveWhitespaceRange(cwd, env) {
  if (git(cwd, ['status', '--porcelain'])) throw Error('Whitespace range requires clean committed checkout');
  const target = commit(cwd, git(cwd, ['rev-parse', 'HEAD']));
  let base, source;
  if (env.GITHUB_ACTIONS === 'true') {
    if (commit(cwd, env.GITHUB_SHA) !== target) throw Error('GitHub checkout SHA mismatch');
    if (!env.GITHUB_EVENT_PATH) throw Error('GitHub event payload is required');
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    if (env.GITHUB_EVENT_NAME === 'pull_request') {
      base = commit(cwd, event.pull_request?.base?.sha);
      const head = commit(cwd, event.pull_request?.head?.sha);
      git(cwd, ['merge-base', '--is-ancestor', head, target]);
      source = 'pull_request.base.sha -> checked-out GITHUB_SHA';
    } else if (env.GITHUB_EVENT_NAME === 'push') {
      if (event.deleted === true || commit(cwd, event.after) !== target) throw Error('Push checkout/after mismatch or deleted ref');
      base = commit(cwd, event.before);
      source = 'push.before -> push.after';
    } else throw Error('Unsupported GitHub event for whitespace range');
  } else {
    base = commit(cwd, env.ARA_CI_BASE_SHA);
    source = 'explicit local ARA_CI_BASE_SHA -> HEAD';
  }
  if (base === target) throw Error('Identical range endpoints would disable committed-change inspection');
  return { base, target, source, args: ['diff', '--check', base, target, '--'] };
}
function checkWhitespace(cwd, env, execute) {
  const range = resolveWhitespaceRange(cwd, env);
  if (execute) execute(range);
  else git(cwd, range.args);
  return range;
}
function command(name, expected) {
  const value = process.env[name] || expected;
  if (value !== expected) throw Error(`Security check command changed: ${name}`);
  return value.split(' ');
}
function run(name, command, args, timeout = 240000) {
  const started = Date.now();
  console.log(`RUN ${name}`);
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, name.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.log'), (result.stdout || '') + (result.stderr || '') + (result.error ? String(result.error) : ''));
  // Full diagnostics remain in the artifact; bound terminal output for large failures.
  if (result.stdout) process.stdout.write(result.stdout.slice(-4000));
  if (result.stderr) process.stderr.write(result.stderr.slice(-4000));
  results.push({ name, exit_code: result.status, signal: result.signal, error: result.error?.code || null, elapsed_ms: Date.now() - started, passed: !result.error && result.status === 0 });
  fs.writeFileSync(path.join(out, 'VALIDATOR_RESULTS.json'), JSON.stringify({ results, execution_context: process.env.GITHUB_ACTIONS === 'true' ? 'GITHUB_ACTIONS_CONTAINER' : 'LOCAL_DOCKER', github_job_conclusion: 'NOT_DETERMINED_BY_RUNNER' }, null, 2));
  if (result.error || result.status !== 0) throw Error(`${name} failed: ${result.error?.code || result.signal || result.status}`);
}
function main() { try {
  const range = resolveWhitespaceRange(root, process.env);
  fs.writeFileSync(path.join(out, 'WHITESPACE_RANGE.json'), JSON.stringify(range, null, 2));
  run('whitespace-range-tests', process.execPath, ['tests/ci/test-whitespace-range.cjs']);
  // Preserve the dedicated check and the entire original alphabetical ARA selection.
  const dedicated = command('ARA_CI_DEDICATED', 'node tests/validate-ara-20260724-010.cjs');
  run('dedicated-security', dedicated[0], dedicated.slice(1));
  const glob = command('ARA_CI_VALIDATORS', 'tests/validate-ara-*.cjs')[0];
  const [prefix, suffix] = path.basename(glob).split('*');
  const validators = fs.readdirSync(path.join(root, path.dirname(glob))).filter(name => name.startsWith(prefix) && name.endsWith(suffix)).sort();
  if (!validators.length) throw Error('Empty validator selection');
  for (const file of validators) run(file, process.execPath, ['tests/' + file]);
  const tracked = spawnSync('git', ['ls-files', '-z', '*.js', '*.cjs'], { cwd: root, encoding: 'utf8' });
  if (tracked.status !== 0 || tracked.error) throw Error('Git source enumeration failed');
  const syntax = command('ARA_CI_SYNTAX', 'node --check');
  for (const file of tracked.stdout.split('\0').filter(Boolean)) run('syntax-' + file, syntax[0], [...syntax.slice(1), file]);
  const whitespace = command('ARA_CI_WHITESPACE', 'git diff --check');
  checkWhitespace(root, process.env, resolved => run('patch-whitespace', whitespace[0], [...whitespace.slice(1), ...resolved.args.slice(2)]));
  console.log(`SECURITY_CHECKS=PASS; validators=${validators.length}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} }
module.exports = { resolveWhitespaceRange, checkWhitespace };
if (require.main === module) main();
