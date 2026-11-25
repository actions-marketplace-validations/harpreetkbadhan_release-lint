import { ReleaseLintError } from '../types.js';

export type PlistValue = string | number | boolean | Date | Buffer | null | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

const BPLIST_MAGIC = 'bplist00';
const TRAILER_SIZE = 32;
/** Seconds between the Unix epoch and Apple's reference date, 2001-01-01. */
const APPLE_EPOCH_OFFSET = 978_307_200;

/** Parses an Apple property list, binary (`bplist00`) or XML. Dicts have a null prototype. */
export function parsePlist(buf: Buffer): PlistValue {
  try {
    return buf.subarray(0, 8).toString('latin1') === BPLIST_MAGIC ? parseBinary(buf) : parseXml(buf.toString('utf8'));
  } catch (error) {
    if (error instanceof ReleaseLintError) {
      throw error;
    }
    throw new ReleaseLintError(`Unreadable property list (${(error as Error).message})`);
  }
}

export const isPlistDict = (value: PlistValue | undefined): value is PlistDict =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Date);

const dict = (): PlistDict => Object.create(null) as PlistDict;

function parseBinary(buf: Buffer): PlistValue {
  if (buf.length < 8 + TRAILER_SIZE) {
    throw new ReleaseLintError('Binary plist is too short');
  }
  const t = buf.length - TRAILER_SIZE;
  const offsetSize = buf[t + 6] ?? 0;
  const refSize = buf[t + 7] ?? 0;
  const count = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableOffset = Number(buf.readBigUInt64BE(t + 24));
  if (!offsetSize || !refSize || tableOffset + count * offsetSize > t || top >= count) {
    throw new ReleaseLintError('Binary plist trailer is invalid');
  }

  const uint = (pos: number, size: number): number => {
    if (size === 8) return Number(buf.readBigUInt64BE(pos));
    if (size === 1 || size === 2 || size === 4) return buf.readUIntBE(pos, size);
    throw new ReleaseLintError(`Binary plist uses an invalid integer size ${size}`);
  };
  const offsetOf = (ref: number): number => {
    if (ref >= count) {
      throw new ReleaseLintError('Binary plist reference out of range');
    }
    return uint(tableOffset + ref * offsetSize, offsetSize);
  };
  const active = new Set<number>();
  /** Each object is decoded once: without this, arrays that share refs expand exponentially ("billion laughs"). */
  const memo = new Map<number, PlistValue>();

  /** Returns [length, position after the length]. Lengths >= 15 follow as an int object. */
  const lengthAt = (pos: number, info: number): [number, number] => {
    if (info !== 0xf) {
      return [info, pos + 1];
    }
    const size = 1 << ((buf[pos + 1] ?? 0) & 0xf);
    return [uint(pos + 2, size), pos + 2 + size];
  };

  const read = (ref: number): PlistValue => {
    const known = memo.get(ref);
    if (known !== undefined) {
      return known;
    }
    if (active.has(ref)) {
      throw new ReleaseLintError('Binary plist contains a reference cycle');
    }
    active.add(ref);
    try {
      const value = readObject(offsetOf(ref));
      memo.set(ref, value);
      return value;
    } finally {
      active.delete(ref);
    }
  };

  const refs = (start: number, n: number): number[] => Array.from({ length: n }, (_, i) => uint(start + i * refSize, refSize));

  const readObject = (pos: number): PlistValue => {
    const marker = buf[pos];
    if (marker === undefined) {
      throw new ReleaseLintError('Binary plist object out of range');
    }
    const type = marker >> 4;
    const info = marker & 0xf;
    switch (type) {
      case 0x0:
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        return null;
      case 0x1: {
        const size = 1 << info;
        if (size === 8) return Number(buf.readBigInt64BE(pos + 1));
        if (size === 16) return Number(buf.readBigInt64BE(pos + 9));
        return buf.readUIntBE(pos + 1, size);
      }
      case 0x2:
        return info === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1);
      case 0x3:
        return new Date((buf.readDoubleBE(pos + 1) + APPLE_EPOCH_OFFSET) * 1000);
      case 0x4: {
        const [length, start] = lengthAt(pos, info);
        return Buffer.from(slice(buf, start, length));
      }
      case 0x5: {
        const [length, start] = lengthAt(pos, info);
        return slice(buf, start, length).toString('latin1');
      }
      case 0x6: {
        const [length, start] = lengthAt(pos, info);
        return Buffer.from(slice(buf, start, length * 2)).swap16().toString('utf16le');
      }
      case 0x8:
        return buf.readUIntBE(pos + 1, info + 1);
      case 0xa:
      case 0xc: {
        const [length, start] = lengthAt(pos, info);
        return refs(start, length).map(read);
      }
      case 0xd: {
        const [length, start] = lengthAt(pos, info);
        const keys = refs(start, length);
        const values = refs(start + length * refSize, length);
        const out = dict();
        keys.forEach((keyRef, i) => {
          out[String(read(keyRef))] = read(values[i] ?? 0);
        });
        return out;
      }
      default:
        throw new ReleaseLintError(`Unknown binary plist object type 0x${marker.toString(16)}`);
    }
  };

  return read(top);
}

function slice(buf: Buffer, start: number, length: number): Buffer {
  if (start + length > buf.length) {
    throw new ReleaseLintError('Binary plist value out of range');
  }
  return buf.subarray(start, start + length);
}

interface Tag {
  name: string;
  close: boolean;
  self: boolean;
  start: number;
  end: number;
}

const TAG_NAME = /^<(\/?)([A-Za-z]+)\b[^>]*?(\/?)>$/;

/**
 * Linear tag scan: each `<…>`, `<!--…-->` or `<?…?>` is closed with one indexOf, and an unterminated one ends the
 * parse. (A single regex over the whole document was quadratic on hostile input such as `<a<a<a…`.)
 */
function scanTags(xml: string): Tag[] {
  const tags: Tag[] = [];
  let pos = xml.indexOf('<');
  while (pos !== -1) {
    const closer = xml.startsWith('<!--', pos) ? '-->' : xml.startsWith('<?', pos) ? '?>' : '>';
    const end = xml.indexOf(closer, pos + 1);
    if (end === -1) {
      throw new ReleaseLintError('XML plist: unterminated tag');
    }
    const stop = end + closer.length;
    const m = xml.startsWith('<!', pos) || xml.startsWith('<?', pos) ? null : TAG_NAME.exec(xml.slice(pos, stop));
    if (m?.[2]) {
      tags.push({ name: m[2], close: m[1] === '/', self: m[3] === '/', start: pos, end: stop });
    }
    pos = xml.indexOf('<', stop);
  }
  return tags;
}
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[entity] ?? match;
  });

function parseXml(xml: string): PlistValue {
  const tags = scanTags(xml);
  let i = 0;
  const next = (): Tag => {
    const tag = tags[i++];
    if (!tag) {
      throw new ReleaseLintError('XML plist ends early');
    }
    return tag;
  };
  const text = (open: Tag): string => {
    if (open.self) {
      return '';
    }
    const close = next();
    if (!close.close || close.name !== open.name) {
      throw new ReleaseLintError(`XML plist: expected </${open.name}>`);
    }
    return decodeEntities(xml.slice(open.end, close.start));
  };
  const closes = (name: string): boolean => {
    const tag = tags[i];
    if (tag?.close && tag.name === name) {
      i++;
      return true;
    }
    return false;
  };

  const value = (): PlistValue => {
    const tag = next();
    if (tag.close) {
      throw new ReleaseLintError(`XML plist: unexpected </${tag.name}>`);
    }
    switch (tag.name) {
      case 'true':
      case 'false':
        if (!tag.self) text(tag);
        return tag.name === 'true';
      case 'string':
        return text(tag);
      case 'integer':
      case 'real':
        return Number(text(tag));
      case 'date':
        return new Date(text(tag));
      case 'data':
        return Buffer.from(text(tag).replace(/\s+/g, ''), 'base64');
      case 'array': {
        const out: PlistValue[] = [];
        while (!tag.self && !closes('array')) out.push(value());
        return out;
      }
      case 'dict': {
        const out = dict();
        while (!tag.self && !closes('dict')) {
          const key = next();
          if (key.name !== 'key' || key.close) {
            throw new ReleaseLintError('XML plist: expected <key>');
          }
          out[text(key)] = value();
        }
        return out;
      }
      default:
        throw new ReleaseLintError(`XML plist: unknown element <${tag.name}>`);
    }
  };

  const root = next();
  if (root.name !== 'plist' || root.close) {
    throw new ReleaseLintError('Not a property list');
  }
  const result = value();
  if (!closes('plist')) {
    throw new ReleaseLintError('XML plist: expected </plist>');
  }
  return result;
}
