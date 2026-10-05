import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Brand hygiene (spec Appendix B): Hegemon names its own stocks, buildings and
 * units, and never mentions the genre's games or publishers. Case-sensitive,
 * whole words. The names are written reversed so this file does not match itself.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const reversed = (s: string): string => [...s].reverse().join('');

const FOREIGN_NAMES = [
  'raW fo llaC',
  'orytB',
  '4191 ycamerpuS',
  '1 ycamerpuS',
  'snoitaN fo tcilfnoC',
  'norI fo straeH',
  'evitcaretnI xodaraP',
  'semaG odaroD',
  'tnorfllitS',
].map(reversed);
const FOREIGN_TERMS = [
  'esaB ymrA',
  'yrtsudnI smrA',
  'eciffO gnitiurceR',
  'yrtsudnI lacoL',
  'reknuB',
  'slairetaM eraR',
  'scinortcelE',
  'seilppuS',
].map(reversed);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('brand hygiene', () => {
  it('uses none of the genre’s names in src/next or the README', () => {
    const files = [...sourceFiles(join(ROOT, 'src/next')), join(ROOT, 'README.md')];
    expect(files.length).toBeGreaterThan(10);
    const patterns = [...FOREIGN_NAMES, ...FOREIGN_TERMS].map((name) => ({ name, re: new RegExp(`\\b${escape(name)}\\b`) }));
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { name, re } of patterns) if (re.test(text)) hits.push(`${relative(ROOT, file)}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it('matches whole words only, case-sensitively', () => {
    const word = FOREIGN_TERMS[FOREIGN_TERMS.length - 1]!;
    const re = new RegExp(`\\b${escape(word)}\\b`);
    expect(re.test(`${word} run low`)).toBe(true);
    expect(re.test(`${word.toLowerCase()} run low`)).toBe(false);
    expect(re.test(`${word}mith`)).toBe(false);
  });
});
