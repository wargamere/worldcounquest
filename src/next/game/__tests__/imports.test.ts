import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The module graph of src/next/game (spec §11.3), read straight from the
 * sources: it must be acyclic, and the engine may import only itself and
 * src/data. Tests are left out; they may use Node and Vitest.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const GAME = join(ROOT, 'src/next/game');
const DATA = join(ROOT, 'src/data');

function engineFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...engineFiles(path));
    } else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const SPECIFIER = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(source: string): string[] {
  const out: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const match of code.matchAll(SPECIFIER)) out.push(match[1] ?? match[2]!);
  return out;
}

/** An absolute file path, or the bare specifier of a package. */
function resolveImport(from: string, specifier: string): string {
  let base: string;
  if (specifier.startsWith('@/')) base = join(ROOT, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return specifier;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base;
}

const files = engineFiles(GAME);
const graph = new Map(files.map((file) => [file, specifiers(readFileSync(file, 'utf8')).map((s) => resolveImport(file, s))]));
const name = (file: string): string => relative(ROOT, file);

describe('the src/next/game import graph', () => {
  it('reads the engine modules', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(graph.get(join(GAME, 'cache.ts'))).toContain(join(GAME, 'types.ts'));
  });

  it('imports nothing outside src/next/game and src/data', () => {
    const outside: string[] = [];
    for (const [file, targets] of graph) {
      for (const target of targets) {
        const inside = target.startsWith(`${GAME}/`) || target.startsWith(`${DATA}/`);
        if (!inside) outside.push(`${name(file)} -> ${target.startsWith('/') ? name(target) : target}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('has no cycles', () => {
    const state = new Map<string, 'open' | 'done'>();
    const cycles: string[] = [];
    const visit = (file: string, trail: string[]): void => {
      if (state.get(file) === 'done') return;
      if (state.get(file) === 'open') {
        cycles.push([...trail.slice(trail.indexOf(file)), file].map(name).join(' -> '));
        return;
      }
      state.set(file, 'open');
      for (const target of graph.get(file) ?? []) if (graph.has(target)) visit(target, [...trail, file]);
      state.set(file, 'done');
    };
    for (const file of files) visit(file, []);
    expect(cycles).toEqual([]);
  });

  it('keeps the two rules §11.3 calls out', () => {
    const imports = (from: string, to: string): boolean => graph.get(join(GAME, from))?.includes(join(GAME, to)) ?? false;
    expect(imports('province.ts', 'capture.ts')).toBe(false);
    expect(imports('economy.ts', 'market.ts')).toBe(false);
  });

  it('parses the import forms the sources use', () => {
    const source = [
      "import { a } from './a';",
      "import type { B } from '../b';",
      "export { c } from '@/next/game/c';",
      "import d from '@/data/d.json';",
      "import './side-effect';",
      "const e = await import('./e');",
      "// import { f } from './commented';",
    ].join('\n');
    expect(specifiers(source)).toEqual(['./a', '../b', '@/next/game/c', '@/data/d.json', './side-effect', './e']);
  });
});
