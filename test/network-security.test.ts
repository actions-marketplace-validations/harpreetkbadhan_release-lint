import { describe, expect, it } from 'vitest';
import { parseAxml } from '../src/formats/axml.js';
import { readApp } from '../src/formats/app.js';
import { parseProtoXml } from '../src/formats/proto.js';
import { runRules } from '../src/rules.js';
import type { AppModel, NetworkException } from '../src/types.js';
import { aab, androidManifest, apk, axml, ipa, networkSecurityConfig, protoXml, writeTemp } from './helpers/fixtures.js';

const AAB_CONFIG = 'base/res/xml/network_security_config.xml';
/** Release APKs often have shortened resource paths, so the file is found by its root element, not its name. */
const APK_CONFIG = 'res/zq.xml';

const expectedExceptions = (file: string): NetworkException[] => [
  { kind: 'user-ca', host: '*', evidence: '<base-config> trusts <certificates src="user">', file },
  { kind: 'cleartext', host: '10.0.2.2', evidence: '<domain-config cleartextTrafficPermitted="true"> 10.0.2.2', file },
  { kind: 'cleartext', host: 'api.staging.example.com', evidence: '<domain-config cleartextTrafficPermitted="true"> api.staging.example.com', file },
  { kind: 'user-ca', host: '*', evidence: '<debug-overrides> trusts <certificates src="user">', file, debugOverrides: true },
];

describe('XML text nodes', () => {
  it('keeps element text in protobuf XML (.aab)', () => {
    const root = parseProtoXml(protoXml(networkSecurityConfig()));
    expect(root.children[1]?.children.map((d) => d.text)).toEqual(['10.0.2.2', 'api.staging.example.com']);
  });

  it('keeps element text in binary XML (.apk) and reads roots other than <manifest> when asked', () => {
    const buf = axml(networkSecurityConfig());
    expect(() => parseAxml(buf)).toThrow('does not start with <manifest>');
    const root = parseAxml(buf, { root: 'network-security-config' });
    expect(root.children[1]?.children.map((d) => d.text)).toEqual(['10.0.2.2', 'api.staging.example.com']);
  });
});

describe('reading network security settings', () => {
  it('reads the network security config of an .aab, marking what only applies to debuggable builds', async () => {
    const path = await writeTemp('demo.aab', aab({ extra: { [AAB_CONFIG]: protoXml(networkSecurityConfig()) } }));
    expect((await readApp(path)).networkExceptions).toEqual(expectedExceptions(AAB_CONFIG));
  });

  it('finds the config of an .apk under a shortened path, next to layouts and raw text XML', async () => {
    const layout = axml({ name: 'LinearLayout', attrs: [{ name: 'orientation', android: true, value: 'vertical' }] });
    const rawXml = Buffer.from('<?xml version="1.0"?><note>network-security-config is not compiled here</note>');
    const path = await writeTemp('demo.apk', apk({ extra: { [APK_CONFIG]: axml(networkSecurityConfig()), 'res/a1.xml': layout, 'res/b2.xml': rawXml } }));
    const model = await readApp(path);
    expect(model.networkExceptions).toEqual(expectedExceptions(APK_CONFIG));
    expect(model.problems).toEqual([]);
  });

  it('follows cleartextTrafficPermitted into nested domain-configs, and reads a whole-app base-config', async () => {
    const config = {
      name: 'network-security-config',
      children: [
        { name: 'base-config', attrs: [{ name: 'cleartextTrafficPermitted', bool: true }] },
        {
          name: 'domain-config',
          attrs: [{ name: 'cleartextTrafficPermitted', bool: true }],
          children: [
            { name: 'domain', text: ' dev.example.com ' },
            { name: 'domain-config', attrs: [{ name: 'cleartextTrafficPermitted', bool: false }], children: [{ name: 'domain', text: 'secure.dev.example.com' }] },
            { name: 'domain-config', children: [{ name: 'domain', text: 'inherits.dev.example.com' }] },
          ],
        },
      ],
    };
    const path = await writeTemp('demo.aab', aab({ extra: { [AAB_CONFIG]: protoXml(config) } }));
    expect((await readApp(path)).networkExceptions?.map((e) => [e.kind, e.host])).toEqual([
      ['cleartext', '*'],
      ['cleartext', 'dev.example.com'],
      ['cleartext', 'inherits.dev.example.com'],
    ]);
  });

  it('reports a broken config instead of skipping it', async () => {
    const broken = Buffer.concat([axml(networkSecurityConfig()).subarray(0, 60), Buffer.from('network-security-config')]);
    const model = await readApp(await writeTemp('demo.apk', apk({ extra: { [APK_CONFIG]: broken } })));
    expect(model.problems).toEqual([expect.stringContaining(`${APK_CONFIG}: `)]);
  });

  it('reads NSExceptionDomains that allow plain HTTP from the iOS Info.plist', async () => {
    const info = {
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          '192.168.1.20': { NSExceptionAllowsInsecureHTTPLoads: true },
          'cdn.example.com': { NSIncludesSubdomains: true },
          'legacy.example.com': { NSTemporaryExceptionAllowsInsecureHTTPLoads: true },
        },
      },
    };
    const model = await readApp(await writeTemp('demo.ipa', ipa({ info })));
    const file = 'Payload/Demo.app/Info.plist';
    expect(model.networkExceptions).toEqual([
      { kind: 'cleartext', host: '192.168.1.20', evidence: 'NSExceptionDomains → 192.168.1.20: NSExceptionAllowsInsecureHTTPLoads = true', file },
      { kind: 'cleartext', host: 'legacy.example.com', evidence: 'NSExceptionDomains → legacy.example.com: NSTemporaryExceptionAllowsInsecureHTTPLoads = true', file },
    ]);
  });

  it('leaves the model unchanged for apps without exceptions', async () => {
    expect(await readApp(await writeTemp('demo.aab', aab({ manifest: androidManifest() })))).not.toHaveProperty('networkExceptions');
    expect(await readApp(await writeTemp('demo.ipa', ipa()))).not.toHaveProperty('networkExceptions');
  });
});

describe('network security rules', () => {
  const app = (platform: 'ios' | 'android', networkExceptions: NetworkException[]): AppModel => ({
    platform,
    file: 'demo',
    appId: 'com.example.demo',
    version: '1.0.0',
    build: '1',
    flags: {},
    deepLinks: [],
    sourceMaps: [],
    problems: [],
    networkExceptions,
  });

  it('reports user CAs and plain HTTP per host, naming dev hosts', () => {
    const findings = runRules(app('android', expectedExceptions(AAB_CONFIG)), { allowHosts: [] });
    expect(findings.map((f) => [f.ruleId, f.severity, f.message])).toEqual([
      ['debug/user-ca-trusted', 'warning', "Trusts user-installed CA certificates: anyone who adds one to their phone can read the app's HTTPS traffic"],
      ['debug/cleartext-exception', 'warning', "Plain HTTP is allowed for a development host. Points at 10.0.2.2, the Android emulator's alias for the development machine"],
      ['debug/cleartext-exception', 'warning', 'Plain HTTP is allowed for a development host. Points at what looks like a staging or development host'],
    ]);
    expect(findings.every((f) => f.location === AAB_CONFIG && f.fix.length > 0)).toBe(true);
  });

  it('reports debug-overrides only when the build is debuggable, which turns them on', () => {
    const exceptions = expectedExceptions(AAB_CONFIG).filter((e) => e.debugOverrides);
    expect(runRules(app('android', exceptions), { allowHosts: [] })).toEqual([]);
    const debuggable = { ...app('android', exceptions), flags: { debuggable: true } };
    const findings = runRules(debuggable, { allowHosts: [] });
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ['debug/debuggable', 'error'],
      ['debug/user-ca-trusted', 'warning'],
    ]);
    expect(findings[1]?.message).toContain('this build is debuggable');
    expect(findings[1]?.evidence).toBe('<debug-overrides> trusts <certificates src="user">');
  });

  it('reports a production host neutrally, skips allowHosts, and maps a whole-app exception to debug/cleartext-traffic', () => {
    const file = 'Payload/Demo.app/Info.plist';
    const findings = runRules(
      app('ios', [
        { kind: 'cleartext', host: 'legacy.example.com', evidence: 'e1', file },
        { kind: 'cleartext', host: '10.0.2.2', evidence: 'e2', file },
        { kind: 'cleartext', host: '*', evidence: 'e3', file },
      ]),
      { allowHosts: ['10.0.2.2'] },
    );
    expect(findings.map((f) => [f.ruleId, f.message, f.evidence])).toEqual([
      ['debug/cleartext-exception', 'Plain HTTP is allowed for this host', 'e1'],
      ['debug/cleartext-traffic', 'Plain HTTP is allowed to every host', 'e3'],
    ]);
    expect(findings[0]?.fix).toContain('NSExceptionDomains');
  });
});
