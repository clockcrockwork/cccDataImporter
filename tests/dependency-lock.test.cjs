const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
// Inspect the parser/version tools declared by the actual workspace tooling.
const nxRequire = createRequire(require.resolve('nx/package.json'));
const lernaRequire = createRequire(require.resolve('lerna'));
const { parse } = nxRequire('@yarnpkg/lockfile');
const semver = lernaRequire('semver');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = parse(fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8'));
const apiSensitive = new Set(['minimatch', 'glob', 'js-yaml', 'picomatch', 'brace-expansion']);

test('Yarn preserves each globbing and YAML consumer dependency range', () => {
  assert.equal(lock.type, 'success');
  const violations = [];
  for (const [selector, parent] of Object.entries(lock.object)) {
    for (const [name, range] of Object.entries(parent.dependencies || {})) {
      if (!apiSensitive.has(name)) continue;
      const child = lock.object[`${name}@${range}`];
      assert.ok(child, `${selector}: missing ${name}@${range}`);
      // Lerna pins 3.1.4; preserve the existing same-major security patch floor.
      if (selector.startsWith('lerna@') && name === 'minimatch' && range === '3.1.4') {
        assert.ok(semver.satisfies(child.version, '^3.1.5'));
        continue;
      }
      if (!semver.satisfies(child.version, range)) {
        violations.push(`${selector} -> ${name}@${range} resolved ${child.version}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('multiple API generations are not collapsed by a blanket resolution', () => {
  for (const name of apiSensitive) {
    assert.equal(manifest.resolutions[name], undefined, `${name} must follow its consumer's range`);
  }
});
