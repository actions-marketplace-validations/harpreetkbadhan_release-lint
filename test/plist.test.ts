import bplist from 'bplist-creator';
import { describe, expect, it } from 'vitest';
import { parsePlist } from '../src/formats/plist.js';
import { ReleaseLintError } from '../src/types.js';

const xml = (body: string) =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${body}</plist>`,
  );

describe('parsePlist (binary)', () => {
  it('reads the value types an Info.plist uses', () => {
    const value = parsePlist(
      bplist({
        CFBundleIdentifier: 'com.example.demo',
        small: 7,
        negative: -5,
        large: 2 ** 40,
        real: new bplist.Real(1.5),
        yes: true,
        no: false,
        unicode: 'Kamera für Fotos ✓',
        when: new Date('2026-01-02T03:04:05Z'),
        blob: Buffer.from([1, 2, 3]),
        list: [1, 'two', { three: 3 }],
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      }),
    );
    expect(value).toEqual({
      CFBundleIdentifier: 'com.example.demo',
      small: 7,
      negative: -5,
      large: 2 ** 40,
      real: 1.5,
      yes: true,
      no: false,
      unicode: 'Kamera für Fotos ✓',
      when: new Date('2026-01-02T03:04:05Z'),
      blob: Buffer.from([1, 2, 3]),
      list: [1, 'two', { three: 3 }],
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    });
  });

  it('reads a string longer than 15 characters (length stored as a following int)', () => {
    const long = 'applinks:staging.example.com';
    expect(parsePlist(bplist({ long }))).toEqual({ long });
  });

  it('does not let a "__proto__" key change the prototype', () => {
    const value = parsePlist(bplist(JSON.parse('{"__proto__": {"polluted": true}}'))) as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(null);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects a truncated binary plist', () => {
    const buf = bplist({ a: 'b' });
    expect(() => parsePlist(buf.subarray(0, buf.length - 10))).toThrow(ReleaseLintError);
  });

  it('decodes shared references once instead of expanding them exponentially', () => {
    // Object i is an array of two refs to object i+1; the last is an empty array. 40 levels = 2^40 paths.
    const levels = 40;
    const body = Buffer.concat([...Array.from({ length: levels }, (_, i) => Buffer.from([0xa2, i + 1, i + 1])), Buffer.from([0xa0])]);
    const offsets = Buffer.from(Array.from({ length: levels + 1 }, (_, i) => 8 + i * 3));
    const trailer = Buffer.alloc(32);
    trailer[6] = 1;
    trailer[7] = 1;
    trailer.writeBigUInt64BE(BigInt(levels + 1), 8);
    trailer.writeBigUInt64BE(BigInt(8 + body.length), 24);
    const start = performance.now();
    parsePlist(Buffer.concat([Buffer.from('bplist00'), body, offsets, trailer]));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('rejects an object that refers to itself', () => {
    // bplist00, one array object (0xA1) whose single ref points at object 0 (itself).
    const body = Buffer.from([0xa1, 0x00]);
    const offsets = Buffer.from([8]);
    const trailer = Buffer.alloc(32);
    trailer[6] = 1;
    trailer[7] = 1;
    trailer.writeBigUInt64BE(1n, 8);
    trailer.writeBigUInt64BE(0n, 16);
    trailer.writeBigUInt64BE(BigInt(8 + body.length), 24);
    const buf = Buffer.concat([Buffer.from('bplist00'), body, offsets, trailer]);
    expect(() => parsePlist(buf)).toThrow(/cycle/);
  });
});

describe('parsePlist (XML)', () => {
  it('reads dicts, arrays, scalars and entities', () => {
    const value = parsePlist(
      xml(`<dict>
  <key>CFBundleIdentifier</key><string>com.example.demo</string>
  <!-- a comment -->
  <key>count</key><integer>-3</integer>
  <key>ratio</key><real>2.5</real>
  <key>on</key><true/>
  <key>off</key><false/>
  <key>empty</key><string/>
  <key>escaped</key><string>a &lt;b&gt; &amp; &quot;c&quot; &#x2713; &#65;</string>
  <key>com.apple.developer.associated-domains</key>
  <array><string>applinks:example.com</string><string>applinks:staging.example.com</string></array>
  <key>none</key><array/>
  <key>nested</key><dict><key>k</key><date>2026-01-02T03:04:05Z</date></dict>
  <key>blob</key><data>
    AQID
  </data>
</dict>`),
    );
    expect(value).toEqual({
      CFBundleIdentifier: 'com.example.demo',
      count: -3,
      ratio: 2.5,
      on: true,
      off: false,
      empty: '',
      escaped: 'a <b> & "c" ✓ A',
      'com.apple.developer.associated-domains': ['applinks:example.com', 'applinks:staging.example.com'],
      none: [],
      nested: { k: new Date('2026-01-02T03:04:05Z') },
      blob: Buffer.from([1, 2, 3]),
    });
  });

  it('reads an empty dict', () => {
    expect(parsePlist(xml('<dict/>'))).toEqual({});
  });

  it('stays linear on unterminated tags and comments', () => {
    for (const unit of ['<a', '<!--', '<?x']) {
      const start = performance.now();
      expect(() => parsePlist(xml(`<dict>${unit.repeat(200_000)}</dict>`))).toThrow(ReleaseLintError);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it('rejects broken XML', () => {
    expect(() => parsePlist(xml('<dict><key>a</key><string>b</dict>'))).toThrow(ReleaseLintError);
    expect(() => parsePlist(Buffer.from('hello'))).toThrow(ReleaseLintError);
  });
});
