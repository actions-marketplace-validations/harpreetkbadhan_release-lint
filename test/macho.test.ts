import { describe, expect, it } from 'vitest';
import { readEntitlements } from '../src/formats/macho.js';
import { ReleaseLintError } from '../src/types.js';
import { CPU_ARM64, CPU_X86_64, fatMachO, machO, plistXml } from './helpers/fixtures.js';

const DOMAINS = 'com.apple.developer.associated-domains';
const signed = (domains: string[], cputype = CPU_ARM64) =>
  machO({ cputype, entitlements: plistXml({ 'application-identifier': 'TEAM123456.com.example.demo', [DOMAINS]: domains }) });

describe('readEntitlements', () => {
  it('reads the entitlements from a thin arm64 binary', () => {
    expect(readEntitlements(signed(['applinks:staging.example.com']))).toEqual({
      'application-identifier': 'TEAM123456.com.example.demo',
      [DOMAINS]: ['applinks:staging.example.com'],
    });
  });

  it('prefers the arm64 slice of a fat binary', () => {
    const fat = fatMachO([
      { cputype: CPU_X86_64, data: signed(['applinks:x86.example.com'], CPU_X86_64) },
      { cputype: CPU_ARM64, data: signed(['applinks:arm.example.com']) },
    ]);
    expect(readEntitlements(fat)?.[DOMAINS]).toEqual(['applinks:arm.example.com']);
  });

  it('reads a fat binary with 64-bit fat headers', () => {
    const fat = fatMachO([{ cputype: CPU_ARM64, data: signed(['applinks:example.com']) }], { wide: true });
    expect(readEntitlements(fat)?.[DOMAINS]).toEqual(['applinks:example.com']);
  });

  it('uses the first slice when there is no arm64 slice', () => {
    const fat = fatMachO([{ cputype: CPU_X86_64, data: signed(['applinks:x86.example.com'], CPU_X86_64) }]);
    expect(readEntitlements(fat)?.[DOMAINS]).toEqual(['applinks:x86.example.com']);
  });

  it('returns undefined for a signature without entitlements', () => {
    expect(readEntitlements(machO())).toBeUndefined();
  });

  it('returns undefined for an unsigned binary', () => {
    const unsigned = machO();
    unsigned.writeUInt32LE(0x19, 32); // turn LC_CODE_SIGNATURE into another load command
    expect(readEntitlements(unsigned)).toBeUndefined();
  });

  it('rejects a file that is not a Mach-O binary', () => {
    expect(() => readEntitlements(Buffer.from('#!/bin/sh\necho hi\n'))).toThrow(ReleaseLintError);
  });

  it('rejects a binary whose signature points past the end', () => {
    const binary = signed(['applinks:example.com']);
    expect(() => readEntitlements(binary.subarray(0, binary.length - 20))).toThrow(ReleaseLintError);
  });
});
