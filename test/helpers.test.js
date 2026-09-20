// tests/helpers.ts is TypeScript. Node >= 22.18 strips the types natively.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let helpers;
before(async () => {
  helpers = await import('../tests/helpers.ts');
});

test('findSkipDomain matches the domain and subdomains, not substrings', () => {
  const skip = { 't.co': 'shortener', 'linkedin.com': 'blocks bots' };
  assert.strictEqual(helpers.findSkipDomain('t.co', skip), 't.co');
  assert.strictEqual(helpers.findSkipDomain('www.linkedin.com', skip), 'linkedin.com');
  assert.strictEqual(helpers.findSkipDomain('WWW.LinkedIn.com', skip), 'linkedin.com');
  assert.strictEqual(helpers.findSkipDomain('microsoft.com', skip), undefined); // contains "t.co"
  assert.strictEqual(helpers.findSkipDomain('notlinkedin.com', skip), undefined);
});

test('normalizeStatus counts timedOut and interrupted as failed', () => {
  assert.strictEqual(helpers.normalizeStatus('passed'), 'passed');
  assert.strictEqual(helpers.normalizeStatus('skipped'), 'skipped');
  assert.strictEqual(helpers.normalizeStatus('failed'), 'failed');
  assert.strictEqual(helpers.normalizeStatus('timedOut'), 'failed');
  assert.strictEqual(helpers.normalizeStatus('interrupted'), 'failed');
});

test('classifyLink: siteUrl links are internal, relative links resolve', () => {
  const current = 'http://localhost:3000/posts/a/';
  const site = 'https://blog.test/';
  const c = (href) => helpers.classifyLink(href, current, site);

  assert.deepStrictEqual(c('/about/#team'), { kind: 'internal', path: '/about/' });
  assert.deepStrictEqual(c('../b/'), { kind: 'internal', path: '/posts/b/' });
  assert.deepStrictEqual(c('files/doc.pdf'), { kind: 'internal', path: '/posts/a/files/doc.pdf' });
  assert.deepStrictEqual(c('https://blog.test/new-post/'), { kind: 'internal', path: '/new-post/' });
  assert.deepStrictEqual(c('https://example.org/x#frag'), { kind: 'external', url: 'https://example.org/x' });
  assert.deepStrictEqual(c('//cdn.example.org/lib.js'), { kind: 'external', url: 'https://cdn.example.org/lib.js' });
  for (const href of ['#top', 'mailto:a@b.c', 'tel:+1', 'javascript:void(0)', '']) {
    assert.strictEqual(c(href), null, href);
  }
});

test('listSitePages maps files to URL paths and drops alias redirects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-pages-'));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write('index.html', '<html>');
  write('posts/orphan/index.html', '<html>');
  write('404.html', '<html>');
  write('old/index.html', '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=/new/">');
  write('min/index.html', '<!doctype html><html><head><meta http-equiv=refresh content="0; url=/new/">');
  write('index.xml', '<rss>');

  assert.deepStrictEqual(helpers.listSitePages(root), ['/', '/404.html', '/posts/orphan/']);
  const config = { ...helpers.getDefaults(), skipPaths: ['/404.html'] };
  assert.deepStrictEqual(helpers.getAllPages(config, root), ['/', '/posts/orphan/']);
});

test('loadConfig adds user skip domains to the defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-tscfg-'));
  fs.mkdirSync(path.join(root, 'hugo-validator'));
  fs.writeFileSync(
    path.join(root, 'hugo-validator', 'hugo-validator.config.js'),
    "module.exports = { skipExternalDomains: { 'web.archive.org': 'rate limits' }, links: { failOnExternal: false } };"
  );
  const config = helpers.loadConfig(root);
  assert.strictEqual(config.skipExternalDomains['web.archive.org'], 'rate limits');
  assert.ok(config.skipExternalDomains['linkedin.com']);
  assert.strictEqual(config.links.failOnExternal, false);
  assert.strictEqual(config.links.ignoreHTTPSErrors, false);
});

test('isDirectoryListing recognises the python http.server listing', () => {
  assert.ok(helpers.isDirectoryListing('<html><head><title>Directory listing for /images/</title>'));
  assert.ok(!helpers.isDirectoryListing('<html><head><title>My post</title>'));
});

test('shard splits round-robin into balanced, non-empty groups', () => {
  assert.deepStrictEqual(helpers.shard([1, 2, 3, 4, 5], 2), [[1, 3, 5], [2, 4]]);
  assert.deepStrictEqual(helpers.shard([1, 2], 4), [[1], [2]]);
  assert.deepStrictEqual(helpers.shard([], 4), [[]]);
  assert.deepStrictEqual(helpers.shard([1, 2, 3], 0), [[1, 2, 3]]);
  assert.strictEqual(helpers.getDefaults().accessibility.shards, 0);
  assert.strictEqual(helpers.resolveShardCount(0, 10), 4);
  assert.strictEqual(helpers.resolveShardCount(0, 2), 2);
  assert.strictEqual(helpers.resolveShardCount(3, 10), 3);
});
