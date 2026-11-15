import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { brotliCompressSync } from 'node:zlib';
import express from 'express';
import { assertSupportedNodeVersion, SUPPORTED_NODE_VERSIONS } from '../server/check-runtime.js';

test('unpatched, unsupported and prerelease Node versions are refused', () => {
  for (const version of [
    '20.19.5', '22.23.3', '23.11.0', '24.18.0', '24.22.0', '25.9.0',
    '26.12.0', '24.22.1-rc.1', 'invalid',
  ]) {
    assert.throws(() => assertSupportedNodeVersion(version), /CVE-2026-111497/, version);
  }
});

test('patched release boundaries and later releases are accepted', () => {
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', '27.0.0']) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version), version);
  }
});

test('install metadata and the development runtime agree with the startup policy', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, SUPPORTED_NODE_VERSIONS);
  assert.equal(lock.packages[''].engines.node, SUPPORTED_NODE_VERSIONS);
  assertSupportedNodeVersion(readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim());
});

for (const entry of ['server/index.js', 'setup.js']) {
  test(`${entry} refuses an unpatched runtime before opening the database`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yuvomi-node-runtime-'));
    const dbPath = path.join(dir, 'must-not-open.db');
    try {
      const script = `Object.defineProperty(process.versions, 'node', { value: '24.22.0' });
        await import(${JSON.stringify(new URL(`../${entry}`, import.meta.url).href)});`;
      const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        env: { ...process.env, DB_PATH: dbPath, SESSION_SECRET: '', DB_ENCRYPTION_KEY: '' },
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      assert.ifError(run.error);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /Unsupported Node\.js 24\.22\.0/);
      assert.match(run.stderr, /CVE-2026-111497/);
      assert.equal(existsSync(dbPath), false, 'the runtime check must precede database initialization');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('valid Brotli JSON request bodies still decode on a patched runtime', async () => {
  const payload = brotliCompressSync(Buffer.from(JSON.stringify({ message: 'Gruesse aus Yuvomi' })));
  const req = new PassThrough();
  req.headers = {
    'content-type': 'application/json',
    'content-encoding': 'br',
    'content-length': String(payload.length),
  };
  req.method = 'POST';
  const parsed = new Promise((resolve, reject) => {
    express.json()(req, new PassThrough(), (err) => err ? reject(err) : resolve(req.body));
  });
  req.end(payload);
  assert.deepEqual(await parsed, { message: 'Gruesse aus Yuvomi' });
});
