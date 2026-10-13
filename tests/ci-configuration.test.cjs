const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.existsSync(path.join(root, name))
  ? fs.readFileSync(path.join(root, name), 'utf8')
  : '';
const manifest = JSON.parse(read('package.json'));
const setup = () => read('.github/actions/setup-node-yarn/action.yml');
const ci = () => read('.github/workflows/test.yml');

test('the application runtime has one exact Node 24 pin', () => {
  assert.match(read('.nvmrc').trim(), /^24\.\d+\.\d+$/);
  assert.equal(manifest.engines?.node, '24.x');
  assert.equal(manifest.packageManager, 'yarn@1.22.22');
});

test('every application workflow uses the shared runtime pin', () => {
  const installedWorkflows = [
    'alice-blog-checker.yml',
    'daily-notify-popular-product.yml',
    'daily-notify-popular-repositories.yml',
    'daily-notify-start.yml',
    'fetch-rss.yml',
  ];
  for (const name of installedWorkflows) {
    const workflow = read(`.github/workflows/${name}`);
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-node-yarn/, name);
    assert.doesNotMatch(workflow, /node-version:|\byarn (?:add|install)\b|package-lock\.json|node_modules|ignore-engines/, name);
  }
  assert.match(read('.github/workflows/daily.yml'), /node-version-file: ['"]?\.nvmrc/);
  assert.match(setup(), /node-version-file: ['"]?\.nvmrc/);
});

test('shared setup verifies the manifest-pinned Yarn and installs the frozen root lock', () => {
  assert.match(setup(), /corepack enable/);
  assert.match(setup(), /packageManager/);
  assert.match(setup(), /yarn --version/);
  assert.match(setup(), /test "\$actual" = "\$expected"/);
  assert.match(setup(), /working-directory: \$\{\{ github\.workspace \}\}/);
  assert.match(setup(), /yarn install --frozen-lockfile --non-interactive/);
  assert.doesNotMatch(setup(), /ignore-engines|ignore-optional|yarn add/);
});

test('the download cache key follows the Node pin and Yarn lock instead of npm state', () => {
  assert.match(setup(), /yarn cache dir/);
  assert.match(setup(), /hashFiles\('\.nvmrc', 'package\.json', 'yarn\.lock'\)/);
  assert.doesNotMatch(setup(), /package-lock\.json|node_modules|~\/\.npm/);
});

test('Sharp uses the locked optional binary instead of a mutable system libvips', () => {
  const rss = read('.github/workflows/fetch-rss.yml');
  const helper = read('packages/fetchRss/start-with-deps.sh');
  assert.match(setup(), /SHARP_IGNORE_GLOBAL_LIBVIPS: ['"]1['"]/);
  assert.match(rss, /require\('sharp'\)/);
  assert.doesNotMatch(rss + helper, /apt-get|yarn add|ignore-engines/);
  assert.match(helper, /corepack yarn install --frozen-lockfile --non-interactive/);
});

test('pull requests and origin pushes run the complete application test command without secrets', () => {
  assert.match(ci(), /pull_request:/);
  assert.match(ci(), /push:/);
  assert.match(ci(), /branches: \[origin\]/);
  assert.match(ci(), /uses: \.\/\.github\/actions\/setup-node-yarn/);
  assert.match(ci(), /run: yarn test\s*$/m);
  assert.doesNotMatch(ci(), /secrets\.|pull_request_target|workflow_dispatch|schedule:|node (?:src\/)?index\.js|\byarn start\b/);
});

test('test CI has read-only credentials, bounded runtime and a lockfile mutation guard', () => {
  assert.match(ci(), /permissions:\n  contents: read/);
  assert.doesNotMatch(ci(), /: write/);
  assert.match(ci(), /persist-credentials: false/);
  assert.match(ci(), /runs-on: ubuntu-latest/);
  assert.match(ci(), /timeout-minutes: 20/);
  assert.match(ci(), /cancel-in-progress: true/);
  assert.match(ci(), /git diff --exit-code -- package\.json yarn\.lock package-lock\.json packages\/\*\/package\.json/);
});

test('Gitpod uses the same Node pin and frozen Yarn install', () => {
  const gitpod = read('.gitpod.yml');
  assert.match(gitpod, /before: \|\n\s+nvm install\n\s+nvm use/);
  assert.match(gitpod, /corepack yarn install --frozen-lockfile --non-interactive/);
});
