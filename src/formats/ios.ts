import { ReleaseLintError, type AppModel, type DeepLink } from '../types.js';
import { MAX_BUNDLE_BYTES, MAX_CONFIG_BYTES, readBundle, readExpoConfig, readOptional, sourceMaps } from './common.js';
import { readEntitlements } from './macho.js';
import { isPlistDict, parsePlist, type PlistDict } from './plist.js';
import type { ZipArchive } from './zip.js';

const INFO_PLIST = /^Payload\/[^/]+\.app\/Info\.plist$/;
const ASSOCIATED_DOMAINS = 'com.apple.developer.associated-domains';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Reads an .ipa into the app model. Throws `ReleaseLintError` if Info.plist is missing or broken. */
export async function readIpa(zip: ZipArchive, file: string): Promise<AppModel> {
  const infoName = [...zip.entries.keys()].find((name) => INFO_PLIST.test(name));
  if (!infoName) {
    throw new ReleaseLintError('Not an iOS app: no Payload/<App>.app/Info.plist');
  }
  const appDir = infoName.slice(0, -'Info.plist'.length);
  const info = parsePlist(await zip.read(infoName, MAX_CONFIG_BYTES));
  if (!isPlistDict(info)) {
    throw new ReleaseLintError('Info.plist is not a dictionary');
  }

  const problems: string[] = [];
  const executable = `${appDir}${str(info['CFBundleExecutable'])}`;
  const entitlements = await readOptional(zip, executable, problems, readEntitlements);
  const bundleName = `${appDir}main.jsbundle`;
  const bundle = await readOptional(zip, bundleName, problems, (buf) => readBundle(bundleName, buf), MAX_BUNDLE_BYTES);
  const expoName = `${appDir}EXConstants.bundle/app.config`;
  const expoConfig = await readOptional(zip, expoName, problems, (buf) => readExpoConfig(expoName, buf), MAX_CONFIG_BYTES);

  const ats = info['NSAppTransportSecurity'];
  const arbitraryLoads = isPlistDict(ats) ? ats['NSAllowsArbitraryLoads'] : undefined;
  const getTaskAllow = entitlements?.['get-task-allow'];

  return {
    platform: 'ios',
    file,
    appId: str(info['CFBundleIdentifier']),
    version: str(info['CFBundleShortVersionString']),
    build: str(info['CFBundleVersion']),
    flags: {
      ...(typeof arbitraryLoads === 'boolean' ? { allowsArbitraryLoads: arbitraryLoads } : {}),
      ...(typeof getTaskAllow === 'boolean' ? { debuggable: getTaskAllow } : {}),
    },
    deepLinks: entitlements ? associatedDomains(entitlements, executable) : [],
    ...(bundle ? { bundle } : {}),
    ...(expoConfig ? { expoConfig } : {}),
    sourceMaps: sourceMaps(zip),
    problems,
  };
}

/** `applinks:example.com?mode=developer` → `{ kind: 'applinks', host: 'example.com' }`. */
function associatedDomains(entitlements: PlistDict, file: string): DeepLink[] {
  const domains = entitlements[ASSOCIATED_DOMAINS];
  if (!Array.isArray(domains)) {
    return [];
  }
  return domains.filter((d): d is string => typeof d === 'string' && d.includes(':')).map((entry) => {
    const [kind = '', rest = ''] = entry.split(/:(.*)/s);
    return { host: rest.split('?')[0] ?? '', kind, file };
  });
}
