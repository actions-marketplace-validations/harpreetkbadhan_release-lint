import { unzipSync } from 'fflate';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readApp } from '../src/formats/app.js';
import { runRules } from '../src/rules.js';
import { ReleaseLintError } from '../src/types.js';
import { hbc, ipa, writeTemp, type IpaOptions } from './helpers/fixtures.js';

const STRIPE_LIVE = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const DOMAINS = 'com.apple.developer.associated-domains';

/** Writes the Payload/Demo.app of a synthetic .ipa as a folder under `parent`: what Xcode leaves in Build/Products. */
async function appFolder(parent: string, options: IpaOptions = {}): Promise<string> {
  for (const [name, bytes] of Object.entries(unzipSync(ipa(options)))) {
    const path = join(parent, name.replace(/^Payload\//, ''));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return join(parent, 'Demo.app');
}

const tempDir = () => mkdtemp(join(tmpdir(), 'release-lint-folder-'));

const leaky: IpaOptions = {
  entitlements: { 'get-task-allow': true, [DOMAINS]: ['applinks:staging.example.com'] },
  bundle: hbc({ strings: ['https://api.staging.example.com'], identifiers: ['x'] }),
  expoConfig: { extra: { apiUrl: 'http://localhost:3000' } },
};

describe('iOS .app and .xcarchive folders', () => {
  it('reads a .app folder like the .ipa it becomes, without judging its not-yet-final signing', async () => {
    const fromIpa = await readApp(await writeTemp('Demo.ipa', ipa(leaky)));
    const fromFolder = await readApp(await appFolder(await tempDir(), leaky));
    expect(fromIpa.flags.debuggable).toBe(true);
    expect(fromFolder).toEqual({ ...fromIpa, file: 'Demo.app', flags: {}, unexported: true });
  });

  it('reports the findings of the .ipa, minus development signing, plus a note that signing is checked on export', async () => {
    const findings = runRules(await readApp(await appFolder(await tempDir(), leaky)), { allowHosts: [] });
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ['host/localhost', 'error'],
      ['deeplink/non-production-host', 'error'],
      ['host/non-production', 'warning'],
      ['scan/signing-not-checked', 'info'],
    ]);
  });

  it('reads the app inside an .xcarchive', async () => {
    const archive = join(await tempDir(), 'Demo 2026-11-25.xcarchive');
    await appFolder(join(archive, 'Products/Applications'), leaky);
    await writeFile(join(archive, 'Info.plist'), 'archive info');
    const model = await readApp(archive);
    expect(model).toMatchObject({ file: 'Demo 2026-11-25.xcarchive', appId: 'com.example.demo', unexported: true });
    expect(model.deepLinks).toEqual([{ host: 'staging.example.com', kind: 'applinks', file: 'Payload/Demo.app/Demo' }]);
  });

  it('explains an .xcarchive without an app, and any other folder', async () => {
    const archive = join(await tempDir(), 'Empty.xcarchive');
    await mkdir(join(archive, 'Products/Applications'), { recursive: true });
    await expect(readApp(archive)).rejects.toThrow(new ReleaseLintError('No app in Empty.xcarchive/Products/Applications'));
    await expect(readApp(await tempDir())).rejects.toThrow(/is a directory: give an \.ipa, \.aab or \.apk file, or an iOS \.app or \.xcarchive folder/);
  });

  it('never follows a symlink out of the app folder', async () => {
    const parent = await tempDir();
    const app = await appFolder(parent, { bundle: 'var ok = 1;' });
    const outside = join(parent, 'outside.js');
    await writeFile(outside, `var key = "${STRIPE_LIVE}";`);
    await rm(join(app, 'main.jsbundle'));
    await symlink(outside, join(app, 'main.jsbundle'));
    const model = await readApp(app);
    expect(model.bundle).toBeUndefined();
    expect(runRules(model, { allowHosts: [] }).map((f) => f.ruleId)).not.toContain('secret/stripe-secret-key');
  });
});

describe('simulator builds', () => {
  it('flags a simulator build, which the App Store never accepts and which proves nothing about the release', async () => {
    const model = await readApp(await appFolder(await tempDir(), { info: { DTPlatformName: 'iphonesimulator' } }));
    expect(model.flags.simulator).toBe(true);
    const finding = runRules(model, { allowHosts: [] }).find((f) => f.ruleId === 'debug/simulator-build');
    expect(finding).toMatchObject({ severity: 'error', evidence: 'DTPlatformName = iphonesimulator', location: 'Info.plist' });
  });

  it('does not flag a device build', async () => {
    const model = await readApp(await writeTemp('Demo.ipa', ipa({ info: { DTPlatformName: 'iphoneos' } })));
    expect(model.flags.simulator).toBeUndefined();
  });
});
