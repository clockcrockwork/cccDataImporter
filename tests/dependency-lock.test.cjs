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
const apiSensitive = new Set(['minimatch', 'glob', 'js-yaml', 'picomatch', 'brace-expansion', 'axios']);

function findApiViolations(entries) {
  const violations = [];
  for (const [selector, parent] of Object.entries(entries)) {
    for (const [name, range] of Object.entries(parent.dependencies || {})) {
      if (!apiSensitive.has(name)) continue;
      const child = entries[`${name}@${range}`];
      if (!child) {
        violations.push(`${selector}: missing ${name}@${range}`);
        continue;
      }
      // Exact upstream pins receive only these reviewed same-major patches.
      const patchRange = selector.startsWith('lerna@') && name === 'minimatch' && range === '3.1.4'
        ? '^3.1.5'
        : selector.startsWith('lerna@') && name === 'js-yaml' && range === '4.3.0'
          ? '^4.3.2'
          : selector.startsWith('nx@') && name === 'brace-expansion' && range === '5.0.9'
            ? '^5.0.12'
            : selector.startsWith('nx@') && name === 'axios' && range === '1.18.1'
              ? '^1.20.0'
              : range;
      if (!semver.satisfies(child.version, patchRange)) {
        violations.push(`${selector} -> ${name}@${range} resolved ${child.version}`);
      }
    }
  }
  return violations;
}

test('Yarn preserves each globbing and YAML consumer dependency range', () => {
  assert.equal(lock.type, 'success');
  assert.deepEqual(findApiViolations(lock.object), []);
});

for (const [name, range, incompatible] of [
  ['minimatch', '10.2.5', '3.1.5'],
  ['glob', '^7.1.3', '10.5.0'],
  ['js-yaml', '^3.13.1', '4.3.2'],
  ['picomatch', '^4.0.2', '2.3.2'],
  ['brace-expansion', '5.0.9', '1.1.21'],
]) {
  test(`lock guard rejects the former blanket ${name} API replacement`, () => {
    const fixture = {
      'consumer@1.0.0': { dependencies: { [name]: range } },
      [`${name}@${range}`]: { version: incompatible },
    };
    assert.equal(findApiViolations(fixture).length, 1);
  });
}

for (const [consumer, name, range, patched, wrongMajor] of [
  ['lerna@^10.0.1', 'minimatch', '3.1.4', '3.1.5', '10.2.5'],
  ['lerna@^10.0.1', 'js-yaml', '4.3.0', '4.3.2', '3.15.2'],
  ['nx@>=23.1.0 < 24.0.0', 'brace-expansion', '5.0.9', '5.0.12', '1.1.21'],
  ['nx@>=23.1.0 < 24.0.0', 'axios', '1.18.1', '1.20.0', '0.30.3'],
]) {
  test(`the ${consumer}/${name} patch exception cannot mask another consumer or major`, () => {
    const fixture = (parent, version) => ({
      [parent]: { dependencies: { [name]: range } },
      [`${name}@${range}`]: { version },
    });
    assert.deepEqual(findApiViolations(fixture(consumer, patched)), []);
    assert.equal(findApiViolations(fixture(consumer, range)).length, 1);
    assert.equal(findApiViolations(fixture(consumer, wrongMajor)).length, 1);
    assert.equal(findApiViolations(fixture('other-consumer@1.0.0', patched)).length, 1);
  });
}

test('multiple API generations are not collapsed by a blanket resolution', () => {
  for (const name of apiSensitive) {
    assert.equal(manifest.resolutions[name], undefined, `${name} must follow its consumer's range`);
  }
});
