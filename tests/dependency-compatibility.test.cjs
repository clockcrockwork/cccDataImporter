const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const from = (name) => createRequire(require.resolve(`${name}/package.json`, { paths: [root] }));

test('Nx can match project names and directories with its requested minimatch API', () => {
  const { findMatchingProjects } = require('nx/src/utils/find-matching-projects');
  const projects = {
    alpha: { name: 'alpha', data: { root: 'packages/alpha', tags: ['type:app'] } },
    beta: { name: 'beta', data: { root: 'packages/beta', tags: ['type:lib'] } },
  };
  assert.deepEqual(findMatchingProjects(['a*'], projects), ['alpha']);
  assert.deepEqual(findMatchingProjects(['directory:packages/*', '!beta'], projects), ['alpha']);
  assert.deepEqual(findMatchingProjects(['tag:type:*'], projects), ['alpha', 'beta']);
});

test('Jest retains the callback glob API it uses to find files', async () => {
  const glob = from('jest-config')('glob');
  assert.equal(typeof glob, 'function');
  const matches = await new Promise((resolve, reject) => {
    glob('packages/*/package.json', { cwd: root }, (error, files) => error ? reject(error) : resolve(files));
  });
  assert.ok(matches.includes('packages/common/package.json'));
});

test('Lerna parses YAML through its own js-yaml dependency', () => {
  const lernaRequire = createRequire(require.resolve('lerna'));
  const { load } = lernaRequire('js-yaml');
  assert.deepEqual(load('packages:\n  - packages/*\n'), { packages: ['packages/*'] });
  assert.throws(() => load('value: !!js/function "function () {}"'), /unknown tag/);
});

test('Nx reads YAML files through its current consumer API', () => {
  const { readYamlFile } = require('nx/src/utils/fileutils');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'importer-yaml-'));
  const filename = path.join(directory, 'fixture.yml');
  try {
    fs.writeFileSync(filename, 'answer: 42\npackages:\n  - packages/*\n');
    assert.deepEqual(readYamlFile(filename), { answer: 42, packages: ['packages/*'] });
    assert.deepEqual(readYamlFile(filename, { failsafe: true }), { answer: '42', packages: ['packages/*'] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Lerna and Nx load the reviewed same-major security patches', () => {
  const lernaRequire = createRequire(require.resolve('lerna'));
  const semver = lernaRequire('semver');
  assert.ok(semver.satisfies(lernaRequire('js-yaml/package.json').version, '^4.3.2'));
  assert.ok(semver.satisfies(from('nx')('brace-expansion/package.json').version, '^5.0.12'));
});

test('Nx uses the patched Axios API with an isolated adapter', async () => {
  const nxRequire = from('nx');
  const axios = nxRequire('axios');
  const semver = createRequire(require.resolve('lerna'))('semver');
  assert.ok(semver.satisfies(axios.VERSION, '^1.20.0'));
  const response = await axios.get('https://fixture.invalid/data', {
    adapter: async (config) => {
      assert.equal(config.method, 'get');
      assert.equal(config.url, 'https://fixture.invalid/data');
      return { data: { result: 'fixture' }, status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  assert.deepEqual(response.data, { result: 'fixture' });
});

test('minimatch uses a brace-expansion implementation from its own API generation', () => {
  const nxRequire = from('nx');
  const { minimatch } = nxRequire('minimatch');
  assert.equal(minimatch('file-b.js', 'file-{a,b}.js'), true);
  assert.equal(minimatch('file-c.js', 'file-{a,b}.js'), false);
});

test('tinyglobby matches workspace manifests through picomatch 4', () => {
  const { globSync } = require('tinyglobby');
  const manifests = globSync('packages/*/package.json', { cwd: root });
  assert.ok(manifests.includes('packages/common/package.json'));
  assert.ok(manifests.includes('packages/aliceBlogChecker/package.json'));
});

test('Sharp can decode and resize an in-memory image with the committed optional packages', async () => {
  const sharp = from('fetchRss')('sharp');
  const semver = createRequire(require.resolve('lerna'))('semver');
  assert.ok(semver.satisfies(sharp.versions.sharp, '^0.35.5'));
  assert.ok(semver.gte(sharp.versions.rsvg, '2.63.2'));
  assert.ok(semver.gte(sharp.versions.vips, '8.18.7'));
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#112233' } }).png().toBuffer();
  const result = await sharp(png).resize(1, 1).png().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 1);
  assert.equal(result.info.height, 1);
  assert.equal(result.info.format, 'png');
});
