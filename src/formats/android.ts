import type { AppModel, DeepLink } from '../types.js';
import { MAX_BUNDLE_BYTES, MAX_CONFIG_BYTES, readBundle, readExpoConfig, readOptional, sourceMaps } from './common.js';
import { parseProtoXml, type XmlElement } from './proto.js';
import type { ZipArchive } from './zip.js';

export const AAB_MANIFEST = 'base/manifest/AndroidManifest.xml';
const BUNDLE = 'base/assets/index.android.bundle';
const EXPO_CONFIG = 'base/assets/app.config';

const descendants = (el: XmlElement, name: string): XmlElement[] =>
  el.children.flatMap((child) => [...(child.name === name ? [child] : []), ...descendants(child, name)]);

/** Reads an .aab (Android App Bundle) into the app model. */
export async function readAab(zip: ZipArchive, file: string): Promise<AppModel> {
  const manifest = parseProtoXml(await zip.read(AAB_MANIFEST, MAX_CONFIG_BYTES));
  const application = manifest.children.find((child) => child.name === 'application');
  const flag = (name: string): boolean | undefined => {
    const value = application?.attributes[`android:${name}`];
    return value === 'true' ? true : value === 'false' ? false : undefined;
  };
  const debuggable = flag('debuggable');
  const usesCleartextTraffic = flag('usesCleartextTraffic');

  const problems: string[] = [];
  const bundle = await readOptional(zip, BUNDLE, problems, (buf) => readBundle(BUNDLE, buf), MAX_BUNDLE_BYTES);
  const expoConfig = await readOptional(zip, EXPO_CONFIG, problems, (buf) => readExpoConfig(EXPO_CONFIG, buf), MAX_CONFIG_BYTES);

  return {
    platform: 'android',
    file,
    appId: manifest.attributes['package'] ?? '',
    version: manifest.attributes['android:versionName'] ?? '',
    build: manifest.attributes['android:versionCode'] ?? '',
    flags: {
      ...(debuggable !== undefined ? { debuggable } : {}),
      ...(usesCleartextTraffic !== undefined ? { usesCleartextTraffic } : {}),
    },
    deepLinks: application ? intentFilterHosts(application) : [],
    ...(bundle ? { bundle } : {}),
    ...(expoConfig ? { expoConfig } : {}),
    sourceMaps: sourceMaps(zip),
    problems,
  };
}

/** Hosts of every intent filter; `app-link` when the filter has `android:autoVerify="true"`. */
function intentFilterHosts(application: XmlElement): DeepLink[] {
  return descendants(application, 'intent-filter').flatMap((filter) => {
    const kind = filter.attributes['android:autoVerify'] === 'true' ? 'app-link' : 'intent-filter';
    return descendants(filter, 'data')
      .map((data) => data.attributes['android:host'])
      .filter((host): host is string => Boolean(host))
      .map((host) => ({ host, kind, file: AAB_MANIFEST }));
  });
}
