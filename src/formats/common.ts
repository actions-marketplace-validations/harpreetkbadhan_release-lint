import { ReleaseLintError, type JsBundle } from '../types.js';
import { isHermesBytecode, readHermesStrings } from './hermes.js';
import type { ZipArchive } from './zip.js';

/** Info.plist, the manifest and the Expo config are kilobytes; the cap stops a small zip from inflating to gigabytes. */
export const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
/** Large production bundles are tens of MB. */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
/** A real Expo config is a few levels deep; this keeps the rules' recursion bounded. */
const MAX_CONFIG_DEPTH = 64;

/** Reads a React Native bundle: the Hermes string table, or the source of a plain JS bundle. */
export function readBundle(file: string, buf: Buffer): JsBundle {
  if (!isHermesBytecode(buf)) {
    return { file, kind: 'javascript', approximate: false, strings: [buf.toString('utf8')] };
  }
  const { version, strings, approximate } = readHermesStrings(buf);
  return { file, kind: 'hermes', hermesVersion: version, approximate, strings };
}

/** Parses the embedded Expo config. The JSON error text is not passed on: it quotes the file, which may hold a secret. */
export function readExpoConfig(file: string, buf: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new ReleaseLintError('invalid JSON');
  }
  if (depthExceeds(value, MAX_CONFIG_DEPTH)) {
    throw new ReleaseLintError(`nested deeper than ${MAX_CONFIG_DEPTH} levels`);
  }
  return { file, value };
}

/** Iterative, so a hostile 100 000-level config cannot overflow the stack here either. */
function depthExceeds(root: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [value, level] = stack.pop() as [unknown, number];
    if (value && typeof value === 'object') {
      if (level >= limit) return true;
      for (const child of Object.values(value)) stack.push([child, level + 1]);
    }
  }
  return false;
}

/**
 * Reads an optional entry. A missing entry gives `undefined`; an unreadable one is added to
 * `problems` (so the report shows it) and also gives `undefined`, so one bad file never stops the scan.
 */
export async function readOptional<T>(
  zip: ZipArchive,
  name: string,
  problems: string[],
  parse: (buf: Buffer) => T,
  maxBytes?: number,
): Promise<T | undefined> {
  if (!zip.entries.has(name)) {
    return undefined;
  }
  try {
    return parse(await zip.read(name, maxBytes));
  } catch (error) {
    problems.push(`${name}: ${(error as Error).message}`);
    return undefined;
  }
}

/** `.map` entries that ship to devices. An .aab's BUNDLE-METADATA (R8 mapping for Play's deobfuscation) never does. */
export const sourceMaps = (zip: ZipArchive): string[] =>
  [...zip.entries.keys()].filter((name) => name.endsWith('.map') && !name.startsWith('BUNDLE-METADATA/'));
