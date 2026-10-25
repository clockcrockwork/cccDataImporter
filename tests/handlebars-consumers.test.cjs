const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const from = (name) => createRequire(require.resolve(name));

function packageManifest(filename) {
  let directory = path.dirname(filename);
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, 'package.json');
    if (fs.existsSync(candidate)) {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (manifest.name === 'handlebars') return manifest;
    }
    directory = path.dirname(directory);
  }
  throw new Error('Could not find resolved Handlebars package manifest');
}

for (const consumer of ['lerna', 'ts-jest']) {
  test(`${consumer} resolves the patched Handlebars consumer API`, () => {
    const consumerRequire = from(consumer);
    const handlebars = consumerRequire('handlebars');
    const packageJson = packageManifest(consumerRequire.resolve('handlebars'));
    assert.equal(packageJson.version, '4.7.10');
    assert.equal(handlebars.compile('Hello {{name}}!')({ name: 'workspace' }), 'Hello workspace!');
    assert.equal(handlebars.compile('{{#each values}}{{this}}{{/each}}')({ values: ['a', 'b'] }), 'ab');
  });
}
