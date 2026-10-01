import nextPlugin from 'eslint-config-next';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

/**
 * Imports that must never appear inside /src/game.
 * Game logic is pure: it takes state in, returns new state out, and knows
 * nothing about React, Next, the store, or the DOM. Breaking this makes the
 * logic untestable in Vitest and couples balance changes to the UI.
 */
const gamePurityRestrictions = {
  paths: [
    { name: 'react', message: 'Game logic must stay pure — no React in /src/game.' },
    { name: 'react-dom', message: 'Game logic must stay pure — no React in /src/game.' },
    { name: 'zustand', message: 'Game logic must stay pure — the store calls into it, not the reverse.' },
  ],
  patterns: [
    {
      group: ['react/*', 'react-dom/*', 'next', 'next/*', 'zustand/*'],
      message: 'Game logic must stay pure — no framework imports in /src/game.',
    },
    {
      group: ['@/app/*', '@/components/*', '@/store/*', '../app/*', '../components/*', '../store/*'],
      message: 'Game logic must not import from the UI or store layer.',
    },
  ],
};

/**
 * Hegemon v5 (src/next/game): the same purity rule, plus the new UI and store
 * layers, rendering libraries and the whole old game, which the rewrite never
 * imports from.
 */
const nextGamePurityRestrictions = {
  paths: [
    ...gamePurityRestrictions.paths,
    // An exact path: a bare "next" pattern would also match the "@/next/..." alias.
    { name: 'next', message: 'Game logic must stay pure — no framework imports in /src/next/game.' },
  ],
  patterns: [
    {
      group: ['react/*', 'react-dom/*', 'next/*', 'zustand/*'],
      message: 'Game logic must stay pure — no framework imports in /src/next/game.',
    },
    {
      group: ['@/app', '@/app/*', '../app/*', '../components/*', '../store/*'],
      message: 'Game logic must not import from the UI or store layer.',
    },
    {
      group: ['@/next/lib', '@/next/lib/*', '@/next/store', '@/next/store/*', '@/next/components', '@/next/components/*'],
      message: 'Game logic must not import from the v5 UI, store or rendering layers.',
    },
    { group: ['../lib', '../lib/*', '../../lib', '../../lib/*'], message: 'Game logic must not import from the rendering layer.' },
    {
      group: ['@/game', '@/game/*', '@/lib', '@/lib/*', '@/store', '@/store/*', '@/components', '@/components/*'],
      message: 'The v5 game never imports the old turn-based game; copy what it reuses.',
    },
    { group: ['d3-*', 'topojson-*'], message: 'Geometry and projection stay in src/next/lib; game logic uses precomputed km and xyz.' },
  ],
};

/**
 * Cross-engine determinism: `+ - * /` and Math.sqrt are correctly rounded under
 * IEEE-754 on every engine; the functions below are not, and wall clocks,
 * timers and the DOM have no place in a replayable simulation.
 */
const nondeterministicGlobals = [
  'window',
  'document',
  'self',
  'localStorage',
  'sessionStorage',
  'performance',
  'requestAnimationFrame',
  'setTimeout',
  'setInterval',
  'postMessage',
  'Date',
].map((name) => ({ name, message: 'src/next/game is pure and replayable: no DOM, timers or wall clock.' }));
const inexactMath = [
  'random',
  'exp',
  'expm1',
  'log',
  'log2',
  'log10',
  'log1p',
  'pow',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'hypot',
  'cbrt',
].map((property) => ({
  object: 'Math',
  property,
  message: 'Not correctly rounded on every engine (or not seeded): use + - * / and Math.sqrt, and rng.ts.',
}));
const bannedSyntax = [
  { selector: "BinaryExpression[operator='**']", message: 'Use multiplication: ** is not correctly rounded on every engine.' },
  { selector: "AssignmentExpression[operator='**=']", message: 'Use multiplication: **= is not correctly rounded on every engine.' },
  { selector: 'ForInStatement', message: 'for…in order is not part of the determinism contract; iterate key tuples or arrays.' },
];

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  ...nextPlugin,
  ...nextCoreWebVitals,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['src/game/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', gamePurityRestrictions],
    },
  },
  {
    files: ['src/next/game/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', nextGamePurityRestrictions],
      'no-restricted-properties': ['error', ...inexactMath],
      'no-restricted-syntax': ['error', ...bannedSyntax],
    },
  },
  {
    // Tests may time themselves (the performance guard); the engine itself may not.
    files: ['src/next/game/**/*.ts'],
    ignores: ['src/next/game/__tests__/**'],
    rules: {
      'no-restricted-globals': ['error', ...nondeterministicGlobals],
    },
  },
  {
    files: ['src/next/**/*.{ts,tsx}', 'scripts/**/*.{ts,mts,js,mjs}'],
    rules: {
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
