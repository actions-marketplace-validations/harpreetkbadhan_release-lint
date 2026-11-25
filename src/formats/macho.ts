import { ReleaseLintError } from '../types.js';
import { isPlistDict, parsePlist, type PlistDict } from './plist.js';

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_EMBEDDED_ENTITLEMENTS = 0xfade7171;
const CSSLOT_ENTITLEMENTS = 5;

/**
 * Reads the entitlements an iOS executable was signed with, from the code signature
 * (LC_CODE_SIGNATURE → SuperBlob → entitlements blob). These are the real release values;
 * `embedded.mobileprovision` only lists what the profile allows. Returns `undefined` for an
 * unsigned binary or a signature without entitlements.
 */
export function readEntitlements(binary: Buffer): PlistDict | undefined {
  try {
    const signature = codeSignature(selectSlice(binary));
    const xml = signature && entitlementsBlob(signature);
    if (!xml) {
      return undefined;
    }
    const value = parsePlist(xml);
    if (!isPlistDict(value)) {
      throw new ReleaseLintError('Entitlements are not a dictionary');
    }
    return value;
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ReleaseLintError('The app executable is truncated or malformed');
    }
    throw error;
  }
}

function within(buf: Buffer, offset: number, length: number, what: string): Buffer {
  if (offset < 0 || length < 0 || offset + length > buf.length) {
    throw new ReleaseLintError(`The app executable is truncated (${what} out of range)`);
  }
  return buf.subarray(offset, offset + length);
}

/** For a fat binary, picks the arm64 slice (or the first one); a thin binary is returned as is. */
function selectSlice(binary: Buffer): Buffer {
  const magic = binary.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    return binary;
  }
  const wide = magic === FAT_MAGIC_64;
  const entrySize = wide ? 32 : 20;
  const count = binary.readUInt32BE(4);
  const slices = Array.from({ length: count }, (_, i) => {
    const at = 8 + i * entrySize;
    return {
      cputype: binary.readUInt32BE(at),
      offset: wide ? Number(binary.readBigUInt64BE(at + 8)) : binary.readUInt32BE(at + 8),
      size: wide ? Number(binary.readBigUInt64BE(at + 16)) : binary.readUInt32BE(at + 12),
    };
  });
  const slice = slices.find((s) => s.cputype === CPU_TYPE_ARM64) ?? slices[0];
  if (!slice) {
    throw new ReleaseLintError('Fat binary has no slices');
  }
  return within(binary, slice.offset, slice.size, 'fat slice');
}

function codeSignature(macho: Buffer): Buffer | undefined {
  const magic = macho.readUInt32LE(0);
  if (magic !== MH_MAGIC_64 && magic !== MH_MAGIC) {
    throw new ReleaseLintError('The app executable is not a Mach-O binary');
  }
  const commandCount = macho.readUInt32LE(16);
  let pos = magic === MH_MAGIC_64 ? 32 : 28;
  for (let i = 0; i < commandCount; i++) {
    const cmd = macho.readUInt32LE(pos);
    const size = macho.readUInt32LE(pos + 4);
    if (size < 8) {
      throw new ReleaseLintError('Malformed Mach-O load command');
    }
    if (cmd === LC_CODE_SIGNATURE) {
      return within(macho, macho.readUInt32LE(pos + 8), macho.readUInt32LE(pos + 12), 'code signature');
    }
    pos += size;
  }
  return undefined;
}

function entitlementsBlob(signature: Buffer): Buffer | undefined {
  if (signature.readUInt32BE(0) !== CSMAGIC_EMBEDDED_SIGNATURE) {
    throw new ReleaseLintError('Unknown code signature format');
  }
  const count = signature.readUInt32BE(8);
  for (let i = 0; i < count; i++) {
    const type = signature.readUInt32BE(12 + i * 8);
    const offset = signature.readUInt32BE(16 + i * 8);
    if (type === CSSLOT_ENTITLEMENTS && signature.readUInt32BE(offset) === CSMAGIC_EMBEDDED_ENTITLEMENTS) {
      const length = signature.readUInt32BE(offset + 4);
      return within(signature, offset + 8, length - 8, 'entitlements');
    }
  }
  return undefined;
}
