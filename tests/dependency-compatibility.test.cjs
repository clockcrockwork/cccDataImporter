const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
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

test('Yarn parsers can parse YAML lock data via js-yaml safeLoad', () => {
  const { parseSyml } = require('@yarnpkg/parsers');
  assert.deepEqual(parseSyml('answer: hello\n'), { answer: 'hello' });
});

test('front-matter keeps its default safe YAML parser', () => {
  const fm = require('front-matter');
  assert.equal(fm('---\ntitle: hello\n---\nbody').attributes.title, 'hello');
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
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#112233' } }).png().toBuffer();
  const result = await sharp(png).resize(1, 1).png().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 1);
  assert.equal(result.info.height, 1);
  assert.equal(result.info.format, 'png');
});
