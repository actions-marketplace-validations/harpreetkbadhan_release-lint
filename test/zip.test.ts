import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { openZip } from '../src/formats/zip.js';
import { ReleaseLintError } from '../src/types.js';
import { toZip64, writeTemp } from './helpers/fixtures.js';

const text = (value: string) => new TextEncoder().encode(value);

const sample = () =>
  zipSync({
    'Payload/Demo.app/Info.plist': [text('stored bytes'), { level: 0 }],
    'Payload/Demo.app/main.jsbundle': [text('var a = 1;'.repeat(500)), { level: 9 }],
    'assets/été.json': text('{"ok":true}'),
    'empty/': new Uint8Array(0),
  });

describe('openZip', () => {
  it('lists file entries and skips directories', async () => {
    const zip = await openZip(await writeTemp('a.zip', sample()));
    expect([...zip.entries.keys()].sort()).toEqual([
      'Payload/Demo.app/Info.plist',
      'Payload/Demo.app/main.jsbundle',
      'assets/été.json',
    ]);
    await zip.close();
  });

  it('reads stored and deflated entries', async () => {
    const zip = await openZip(await writeTemp('a.zip', sample()));
    expect((await zip.read('Payload/Demo.app/Info.plist')).toString()).toBe('stored bytes');
    expect((await zip.read('Payload/Demo.app/main.jsbundle')).toString()).toBe('var a = 1;'.repeat(500));
    expect((await zip.read('assets/été.json')).toString()).toBe('{"ok":true}');
    await zip.close();
  });

  it('reads an archive whose end record goes through zip64', async () => {
    const zip = await openZip(await writeTemp('a.zip', toZip64(sample())));
    expect(zip.entries.size).toBe(3);
    expect((await zip.read('assets/été.json')).toString()).toBe('{"ok":true}');
    await zip.close();
  });

  it('throws for an entry that is not in the archive', async () => {
    const zip = await openZip(await writeTemp('a.zip', sample()));
    await expect(zip.read('nope')).rejects.toThrow(ReleaseLintError);
    await zip.close();
  });

  it('refuses to inflate an entry above the size cap', async () => {
    const zip = await openZip(await writeTemp('a.zip', sample()), { maxEntryBytes: 100 });
    await expect(zip.read('Payload/Demo.app/main.jsbundle')).rejects.toThrow(/larger than/);
    await zip.close();
  });

  it('rejects a file that is not a zip', async () => {
    await expect(openZip(await writeTemp('a.ipa', text('not a zip at all')))).rejects.toThrow(ReleaseLintError);
  });

  it('rejects a truncated zip', async () => {
    const zip = sample();
    await expect(openZip(await writeTemp('a.ipa', zip.subarray(0, zip.length - 30)))).rejects.toThrow(ReleaseLintError);
  });

  describe('damaged entries', () => {
    const NAME = 'Payload/Demo.app/main.jsbundle';
    const single = () => Buffer.from(zipSync({ [NAME]: [text('var a = 1;'.repeat(50)), { level: 9 }] }));
    const central = (buf: Buffer) => buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const readDamaged = async (damage: (buf: Buffer) => void) => {
      const buf = single();
      damage(buf);
      const zip = await openZip(await writeTemp('a.zip', buf));
      try {
        return await zip.read(NAME);
      } finally {
        await zip.close();
      }
    };

    it('refuses an encrypted entry', async () => {
      await expect(readDamaged((b) => b.writeUInt16LE(b.readUInt16LE(central(b) + 8) | 1, central(b) + 8))).rejects.toThrow(/encrypted/);
    });

    it('refuses an unsupported compression method', async () => {
      await expect(readDamaged((b) => b.writeUInt16LE(12, central(b) + 10))).rejects.toThrow(/compression method 12/);
    });

    it('reports corrupt deflate data', async () => {
      await expect(readDamaged((b) => b.fill(0xff, 30 + NAME.length, 30 + NAME.length + 8))).rejects.toThrow(/could not be inflated/);
    });

    it('refuses a declared size beyond the file before allocating', async () => {
      await expect(readDamaged((b) => b.writeUInt32LE(0x7fffffff, central(b) + 20))).rejects.toThrow(/larger than|truncated/);
    });

    it('reports a broken local header', async () => {
      await expect(readDamaged((b) => b.writeUInt32LE(0, 0))).rejects.toThrow(/local header/);
    });
  });

  it('refuses an archive with the same entry name twice', async () => {
    const buf = Buffer.from(zipSync({ 'a.txt': text('one'), 'b.txt': text('two') }));
    const second = buf.lastIndexOf(Buffer.from('b.txt'));
    buf.write('a.txt', second);
    await expect(openZip(await writeTemp('a.zip', buf))).rejects.toThrow(/twice/);
  });

  it('rejects an empty file', async () => {
    await expect(openZip(await writeTemp('a.ipa', new Uint8Array(0)))).rejects.toThrow(ReleaseLintError);
  });
});
