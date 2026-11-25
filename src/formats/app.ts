import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ReleaseLintError, type AppModel } from '../types.js';
import { AAB_MANIFEST, APK_MANIFEST, readAab, readApk } from './android.js';
import { isAppFolderName, openAppFolder } from './folder.js';
import { readIpa } from './ios.js';
import { openZip } from './zip.js';

/** Opens a built app (.ipa, .aab, .apk, or an iOS .app / .xcarchive folder), detects the platform and reads the app model. */
export async function readApp(path: string): Promise<AppModel> {
  const file = basename(path);
  if ((await stat(path)).isDirectory()) {
    if (!isAppFolderName(file)) {
      throw new ReleaseLintError(`${file} is a directory: give an .ipa, .aab or .apk file, or an iOS .app or .xcarchive folder`);
    }
    // Xcode signs the app again on export, so its signing here is not what ships.
    return readIpa(await openAppFolder(path), file, { exported: false });
  }
  const zip = await openZip(path);
  try {
    if ([...zip.entries.keys()].some((name) => name.startsWith('Payload/'))) {
      return await readIpa(zip, file);
    }
    if (zip.entries.has(AAB_MANIFEST)) {
      return await readAab(zip, file);
    }
    if (zip.entries.has(APK_MANIFEST)) {
      return await readApk(zip, file);
    }
    throw new ReleaseLintError('Not an .ipa, .aab or .apk file');
  } finally {
    await zip.close();
  }
}
