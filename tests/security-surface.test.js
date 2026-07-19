import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('published runtime has no environment-secret or browser-cookie access', () => {
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /fb-cookies|facebook crawler|save-cookies/i);
  assert.doesNotMatch(source, /node:child_process/);
});

test('dashboard is localhost-first and remote binding requires a strong token', () => {
  assert.match(source, /isManagedContainerBind/);
  assert.match(source, /existsSync\('\/\.dockerenv'\)/);
  assert.match(source, /configuredDashboardHost === '127\.0\.0\.1'/);
  assert.match(source, /bindHost = isManagedContainerBind \? '0\.0\.0\.0' : host/);
  assert.match(source, /configuredToken\.length < 24/);
  assert.equal(manifest.configSchema.properties.dashboardHost.default, '127.0.0.1');
  assert.equal(manifest.configSchema.properties.dashboardToken.minLength, 24);
});

test('ClawPack excludes legacy local payment and crawler helpers', () => {
  assert.equal(pkg.openclaw.install.defaultChoice, 'clawhub');
  assert.equal(pkg.openclaw.release.publishToNpm, false);
  assert.ok(!pkg.files.includes('upgrade/flow.js'));
  assert.ok(!pkg.files.includes('upgrade/SKILL.md'));
});

test('first-load bootstrap never mutates openclaw.json during CLI install validation', () => {
  const start = source.indexOf('async function bootstrapWorkspaceFiles()');
  const end = source.indexOf('// Fire-and-forget bootstrap', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /_patchOpenclawConfig/);
});
