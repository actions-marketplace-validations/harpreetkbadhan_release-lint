import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ReleaseLintError } from '../types.js';

/** Largest single entry we inflate. A big app executable is ~200 MB; this also stops zip bombs. */
export const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x1;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

/** What readers need to know about a file in an app: a zip entry, or a file in an iOS .app folder. */
export interface ArchiveEntry {
  name: string;
  size: number;
}

export interface ZipArchive {
  /** File entries by name. Directory entries are left out. */
  entries: ReadonlyMap<string, ArchiveEntry>;
  /** Reads and inflates one entry, up to `maxBytes` (never above the archive cap). Throws `ReleaseLintError` if it is missing, encrypted or too large. */
  read(name: string, maxBytes?: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface OpenZipOptions {
  maxEntryBytes?: number;
}

/**
 * Opens a zip (.ipa, .aab, .apk) for random access: only the central directory is read
 * up front, and each entry is read and inflated on demand. Nothing is written to disk.
 */
export async function openZip(path: string, { maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES }: OpenZipOptions = {}): Promise<ZipArchive> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const entries = await readCentralDirectory(file, size);
    return {
      entries,
      read: (name, maxBytes = maxEntryBytes) =>
        readEntry(file, size, entries, name, Math.min(maxBytes, maxEntryBytes)).catch((error: unknown) => {
          throw asZipError(error);
        }),
      close: () => file.close(),
    };
  } catch (error) {
    await file.close();
    throw asZipError(error);
  }
}

/** Out-of-range reads on a malformed archive become a clean error instead of a crash. */
const asZipError = (error: unknown) => (error instanceof RangeError ? new ReleaseLintError('Malformed zip file') : error);

async function readExact(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset);
  if (bytesRead !== length) {
    throw new ReleaseLintError('The zip file is truncated');
  }
  return buffer;
}

async function readCentralDirectory(file: FileHandle, size: number): Promise<Map<string, ZipEntry>> {
  if (size < EOCD_SIZE) {
    throw new ReleaseLintError('Not a zip file (too small)');
  }
  const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT);
  const tailStart = size - tailLength;
  const tail = await readExact(file, tailStart, tailLength);
  const eocd = findEocd(tail);
  if (eocd < 0) {
    throw new ReleaseLintError('Not a zip file, or it is truncated (no end of central directory)');
  }

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const wide = await readZip64End(file, tailStart + eocd);
    if (wide) {
      ({ count, cdSize, cdOffset } = wide);
    } else if (cdSize === U32_MAX || cdOffset === U32_MAX) {
      throw new ReleaseLintError('Broken zip64 archive (no locator)');
    }
    // else: a plain zip with exactly 65535 entries; the 32-bit values are real.
  }
  if (cdOffset + cdSize > size) {
    throw new ReleaseLintError('The zip file is truncated (central directory out of range)');
  }
  return parseCentralDirectory(await readExact(file, cdOffset, cdSize), count);
}

function findEocd(tail: Buffer): number {
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE && i + EOCD_SIZE + tail.readUInt16LE(i + 20) <= tail.length) {
      return i;
    }
  }
  return -1;
}

/** Returns `undefined` when there is no zip64 locator. */
async function readZip64End(file: FileHandle, eocdOffset: number) {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0) {
    return undefined;
  }
  const locator = await readExact(file, locatorOffset, 20);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
    return undefined;
  }
  const record = await readExact(file, toSafeNumber(locator.readBigUInt64LE(8)), 56);
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    throw new ReleaseLintError('Broken zip64 archive (bad end record)');
  }
  return {
    count: toSafeNumber(record.readBigUInt64LE(32)),
    cdSize: toSafeNumber(record.readBigUInt64LE(40)),
    cdOffset: toSafeNumber(record.readBigUInt64LE(48)),
  };
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReleaseLintError('Zip offset is too large');
  }
  return Number(value);
}

function parseCentralDirectory(cd: Buffer, count: number): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new ReleaseLintError('Broken zip central directory');
    }
    const nameLength = cd.readUInt16LE(pos + 28);
    const extraLength = cd.readUInt16LE(pos + 30);
    const commentLength = cd.readUInt16LE(pos + 32);
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > cd.length) {
      throw new ReleaseLintError('Broken zip central directory');
    }
    const name = cd.toString('utf8', pos + 46, pos + 46 + nameLength);
    const extra = cd.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength);
    const entry = applyZip64Extra(
      {
        name,
        method: cd.readUInt16LE(pos + 10),
        flags: cd.readUInt16LE(pos + 8),
        compressedSize: cd.readUInt32LE(pos + 20),
        size: cd.readUInt32LE(pos + 24),
        localHeaderOffset: cd.readUInt32LE(pos + 42),
      },
      extra,
    );
    if (!name.endsWith('/')) {
      if (entries.has(name)) {
        // Unzip tools disagree on which copy wins, so a decoy copy could hide the real file from the scan.
        throw new ReleaseLintError(`The archive contains ${name} twice; refusing to guess which copy ships`);
      }
      entries.set(name, entry);
    }
    pos = next;
  }
  return entries;
}

/** Fields stored as 0xFFFFFFFF live in the zip64 extra field, in this order: size, compressed size, offset. */
function applyZip64Extra(entry: ZipEntry, extra: Buffer): ZipEntry {
  const needs = [entry.size, entry.compressedSize, entry.localHeaderOffset].some((v) => v === U32_MAX);
  if (!needs) {
    return entry;
  }
  for (let pos = 0; pos + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(pos);
    const length = extra.readUInt16LE(pos + 2);
    if (id === ZIP64_EXTRA_ID) {
      let field = pos + 4;
      const end = Math.min(pos + 4 + length, extra.length);
      const take = (value: number) => {
        if (value !== U32_MAX || field + 8 > end) {
          return value;
        }
        const wide = toSafeNumber(extra.readBigUInt64LE(field));
        field += 8;
        return wide;
      };
      const size = take(entry.size);
      const compressedSize = take(entry.compressedSize);
      const localHeaderOffset = take(entry.localHeaderOffset);
      return { ...entry, size, compressedSize, localHeaderOffset };
    }
    pos += 4 + length;
  }
  throw new ReleaseLintError(`Zip entry ${entry.name} is missing its zip64 sizes`);
}

async function readEntry(file: FileHandle, fileSize: number, entries: ReadonlyMap<string, ZipEntry>, name: string, maxEntryBytes: number): Promise<Buffer> {
  const entry = entries.get(name);
  if (!entry) {
    throw new ReleaseLintError(`No ${name} in the archive`);
  }
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new ReleaseLintError(`${name} is encrypted`);
  }
  if (entry.size > maxEntryBytes) {
    throw new ReleaseLintError(`${name} is larger than ${maxEntryBytes} bytes`);
  }
  const local = await readExact(file, entry.localHeaderOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ReleaseLintError(`Broken zip local header for ${name}`);
  }
  const dataOffset = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  // Checked before allocating: a crafted header must not make us allocate gigabytes.
  if (entry.compressedSize > maxEntryBytes) {
    throw new ReleaseLintError(`${name} is larger than ${maxEntryBytes} bytes`);
  }
  if (dataOffset + entry.compressedSize > fileSize) {
    throw new ReleaseLintError(`${name} is truncated`);
  }
  const data = await readExact(file, dataOffset, entry.compressedSize);
  if (entry.method === METHOD_STORED) {
    return data;
  }
  if (entry.method === METHOD_DEFLATE) {
    try {
      return inflateRawSync(data, { maxOutputLength: maxEntryBytes });
    } catch {
      throw new ReleaseLintError(`${name} could not be inflated (corrupt, or larger than ${maxEntryBytes} bytes)`);
    }
  }
  throw new ReleaseLintError(`${name} uses unsupported compression method ${entry.method}`);
}
