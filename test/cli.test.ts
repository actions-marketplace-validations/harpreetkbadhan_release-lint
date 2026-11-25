import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { aab, androidManifest, hbc, ipa, writeTemp } from './helpers/fixtures.js';

const STRIPE_LIVE = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const text = (value: string) => Buffer.from(value);
const DOMAINS = 'com.apple.developer.associated-domains';

async function run(argv: string[], { cwd, color = false }: { cwd?: string; color?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    cwd: cwd ?? (await mkdtemp(join(tmpdir(), 'release-lint-cwd-'))),
    color,
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const badIpa = () =>
  writeTemp(
    'demo.ipa',
    ipa({
      entitlements: { [DOMAINS]: ['applinks:example.com', 'applinks:staging.example.com'] },
      bundle: hbc({ strings: [STRIPE_LIVE, 'http://192.168.1.20:3000/api'], identifiers: ['key'] }),
    }),
  );

describe('release-lint CLI', () => {
  it('exits 0 and says so for a clean app', async () => {
    const path = await writeTemp('clean.ipa', ipa({ bundle: hbc({ strings: ['https://api.example.com'], identifiers: ['x'] }) }));
    const { code, stdout } = await run([path]);
    expect(code).toBe(0);
    expect(stdout).toContain('release-lint 0.1.0 · clean.ipa · iOS · com.example.demo 1.4.0 (42) · Hermes v98');
    expect(stdout).toContain('No release problems found');
  });

  it('prints each finding with its fix and exits 1 when there are errors', async () => {
    const { code, stdout } = await run([await badIpa()]);
    expect(code).toBe(1);
    expect(stdout).toContain('ERROR  deeplink/non-production-host');
    expect(stdout).toContain('applinks:staging.example.com  (Payload/Demo.app/Demo)');
    expect(stdout).toContain('ERROR  secret/stripe-secret-key');
    expect(stdout).toContain('WARN   host/private-network');
    expect(stdout).toMatch(/fix: /);
    expect(stdout).toContain('2 errors · 1 warning · 0 info');
    expect(stdout).not.toContain(STRIPE_LIVE);
  });

  it('prints JSON with --json, secrets still masked', async () => {
    const { code, stdout } = await run([await badIpa(), '--json']);
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as { tool: string; app: { platform: string; bundle: unknown }; findings: Array<{ ruleId: string }>; summary: unknown };
    expect(report.tool).toBe('release-lint');
    expect(report.app).toMatchObject({ platform: 'ios', appId: 'com.example.demo', bundle: { kind: 'hermes', hermesVersion: 98, approximate: false } });
    expect(report.findings.map((f) => f.ruleId)).toEqual(['secret/stripe-secret-key', 'deeplink/non-production-host', 'host/private-network']);
    expect(report.summary).toEqual({ errors: 2, warnings: 1, info: 0 });
    expect(stdout).not.toContain(STRIPE_LIVE);
  });

  it('only fails on warnings with --fail-on warning, and never with --fail-on none', async () => {
    const manifest = androidManifest([{ name: 'usesCleartextTraffic', android: true, value: 'true' }]);
    const path = await writeTemp('demo.aab', aab({ manifest }));
    expect((await run([path])).code).toBe(0);
    expect((await run([path, '--fail-on', 'warning'])).code).toBe(1);
    expect((await run([await badIpa(), '--fail-on', 'none'])).code).toBe(0);
  });

  it('reads release-lint.config.json from the working directory', async () => {
    const path = await badIpa();
    const cwd = dirname(path);
    await writeFile(
      join(cwd, 'release-lint.config.json'),
      JSON.stringify({ failOn: 'warning', allowHosts: ['staging.example.com'], ignore: [{ rule: 'secret/*' }, { rule: 'host/private-network', match: '192.168.1.20' }] }),
    );
    const { code, stdout } = await run([path], { cwd });
    expect(code).toBe(0);
    expect(stdout).toContain('No release problems found');
  });

  it('ignores rules given with --ignore', async () => {
    const { stdout } = await run([await badIpa(), '--ignore', 'deeplink/non-production-host', '--ignore', 'host/private-network', '--json']);
    expect((JSON.parse(stdout) as { findings: Array<{ ruleId: string }> }).findings.map((f) => f.ruleId)).toEqual(['secret/stripe-secret-key']);
  });

  it('colors the output only when asked', async () => {
    expect((await run([await badIpa()], { color: true })).stdout).toContain('\u001b[');
    expect((await run([await badIpa()])).stdout).not.toContain('\u001b[');
  });

  it('exits 2 with a clear message for unusable input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'release-lint-cwd-'));
    expect(await run(['missing.ipa'], { cwd })).toMatchObject({ code: 2, stderr: expect.stringContaining('File missing.ipa not found') });
    expect(await run([cwd], { cwd })).toMatchObject({ code: 2, stderr: expect.stringContaining('is a directory') });
    expect(await run(['a.ipa', '--config='], { cwd })).toMatchObject({ code: 2, stderr: expect.stringContaining('--config needs a file path') });
    expect(await run(['a.ipa', '--ignore', 'oops'], { cwd })).toMatchObject({ code: 2, stderr: expect.stringContaining('not a rule ID') });
    expect(await run([await writeTemp('x.ipa', Buffer.from('nope'))])).toMatchObject({ code: 2, stderr: expect.stringContaining('Not a zip file') });
    expect(await run([])).toMatchObject({ code: 2, stderr: expect.stringContaining('Usage: release-lint') });
    expect(await run(['a.ipa', 'b.ipa'])).toMatchObject({ code: 2, stderr: expect.stringContaining('one app file') });
    expect(await run(['--bogus'])).toMatchObject({ code: 2, stderr: expect.stringContaining('--bogus') });
    expect(await run(['a.ipa', '--fail-on', 'loud'])).toMatchObject({ code: 2, stderr: expect.stringContaining('--fail-on') });
  });

  it('exits 2 for an invalid config file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'release-lint-cwd-'));
    await writeFile(join(cwd, 'bad.json'), JSON.stringify({ allowHost: ['x'] }));
    const { code, stderr } = await run([await badIpa(), '--config', 'bad.json'], { cwd });
    expect(code).toBe(2);
    expect(stderr).toContain('unknown key "allowHost"');
    expect((await run([await badIpa(), '--config', 'nope.json'], { cwd })).stderr).toContain('Config file not found');
  });

  it('escapes control characters from the app so they cannot forge output', async () => {
    const path = await writeTemp(
      'demo.ipa',
      ipa({ bundle: hbc({ strings: ['http://localhost/\u001b[2J'], identifiers: ['x'] }), extra: { 'Payload/Demo.app/x\n::error::forged.map': text('{}') } }),
    );
    const { stdout } = await run([path]);
    expect(stdout).not.toContain('\u001b');
    expect(stdout).not.toMatch(/^::error::/m);
    expect(stdout).toContain('x\\u000a::error::forged.map');
  });

  it('prints help and version', async () => {
    expect(await run(['--help'])).toMatchObject({ code: 0, stdout: expect.stringContaining('Usage: release-lint <app.ipa|app.aab>') });
    expect(await run(['--version'])).toMatchObject({ code: 0, stdout: '0.1.0\n' });
  });
});
