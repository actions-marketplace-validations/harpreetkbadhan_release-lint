import { describe, expect, it } from 'vitest';
import { readApp } from '../src/formats/app.js';
import { runRules } from '../src/rules.js';
import type { AppModel } from '../src/types.js';
import { aab, androidManifest, apk, axml, ipa, plistXml, writeTemp, type ProtoEl } from './helpers/fixtures.js';

type PlistValue = Parameters<typeof plistXml>[0];

const UPDATES = 'expo.modules.updates.';
/** The meta-data `expo prebuild` writes for expo-updates (checked on a real SDK 58 prebuild). */
const metaData = (name: string, value: string): ProtoEl => ({
  name: 'meta-data',
  attrs: [
    { name: 'name', android: true, value: `${UPDATES}${name}` },
    { name: 'value', android: true, value },
  ],
});
const androidUpdates = (channel: string, enabled = 'true') =>
  androidManifest(
    [],
    [
      metaData('ENABLED', enabled),
      metaData('EXPO_UPDATE_URL', 'https://u.expo.dev/00000000-0000-4000-8000-000000000000'),
      metaData('UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY', JSON.stringify({ 'expo-channel-name': channel })),
    ],
  );
const EXPO_PLIST = 'Payload/Demo.app/Expo.plist';
const expoPlist = (fields: Record<string, PlistValue>) => ({ [EXPO_PLIST]: Buffer.from(plistXml({ EXUpdatesCheckOnLaunch: 'ALWAYS', ...fields })) });

describe('reading the EAS Update channel', () => {
  it('reads it from the manifest of an .aab and an .apk', async () => {
    const fromAab = await readApp(await writeTemp('demo.aab', aab({ manifest: androidUpdates('preview') })));
    const fromApk = await readApp(await writeTemp('demo.apk', apk({ manifest: androidUpdates('preview') })));
    expect(fromAab.updates).toEqual({ channel: 'preview', file: 'base/manifest/AndroidManifest.xml' });
    expect(fromApk.updates).toEqual({ channel: 'preview', file: 'AndroidManifest.xml' });
  });

  it('reads it from an .apk whose attribute names an obfuscator stripped (by resource ID, as Android does)', async () => {
    const path = await writeTemp('demo.apk', apk({ extra: { 'AndroidManifest.xml': axml(androidUpdates('preview'), { stripNames: true }) } }));
    expect((await readApp(path)).updates).toEqual({ channel: 'preview', file: 'AndroidManifest.xml' });
  });

  it('reads it from Expo.plist in an .ipa', async () => {
    const extra = expoPlist({ EXUpdatesEnabled: true, EXUpdatesRequestHeaders: { 'expo-channel-name': 'staging' } });
    expect((await readApp(await writeTemp('demo.ipa', ipa({ extra })))).updates).toEqual({ channel: 'staging', file: EXPO_PLIST });
  });

  it('ignores the channel when updates are turned off, and apps without expo-updates', async () => {
    const off = await readApp(await writeTemp('demo.aab', aab({ manifest: androidUpdates('preview', 'false') })));
    const offIos = await readApp(await writeTemp('demo.ipa', ipa({ extra: expoPlist({ EXUpdatesEnabled: false, EXUpdatesRequestHeaders: { 'expo-channel-name': 'preview' } }) })));
    const templateIos = await readApp(await writeTemp('demo.ipa', ipa({ extra: expoPlist({ EXUpdatesEnabled: false }) })));
    const plain = await readApp(await writeTemp('demo.aab', aab()));
    for (const model of [off, offIos, templateIos, plain]) expect(model).not.toHaveProperty('updates');
  });

  it('ignores request headers that are not JSON or have no channel', async () => {
    const manifest = androidManifest([], [metaData('UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY', '{oops'), metaData('ENABLED', 'true')]);
    expect(await readApp(await writeTemp('demo.aab', aab({ manifest })))).not.toHaveProperty('updates');
    const other = androidManifest([], [metaData('UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY', JSON.stringify({ 'x-tenant': 'a' }))]);
    expect(await readApp(await writeTemp('demo.aab', aab({ manifest: other })))).not.toHaveProperty('updates');
  });
});

describe('updates/non-production-channel', () => {
  const app = (channel: string): AppModel => ({
    platform: 'android',
    file: 'demo.aab',
    appId: 'com.example.demo',
    version: '1.0.0',
    build: '1',
    flags: {},
    deepLinks: [],
    sourceMaps: [],
    problems: [],
    updates: { channel, file: 'base/manifest/AndroidManifest.xml' },
  });

  it.each(['preview', 'staging', 'development', 'dev-internal', 'beta', 'QA'])('reports the %s channel', (channel) => {
    const [finding] = runRules(app(channel), { allowHosts: [] });
    expect(finding).toMatchObject({
      ruleId: 'updates/non-production-channel',
      severity: 'error',
      evidence: `expo-channel-name: ${channel}`,
      location: 'base/manifest/AndroidManifest.xml',
    });
    expect(finding?.message).toContain(`"${channel}"`);
  });

  it.each(['production', 'main', 'release-2026', 'prod'])('accepts the %s channel', (channel) => {
    expect(runRules(app(channel), { allowHosts: [] })).toEqual([]);
  });
});
