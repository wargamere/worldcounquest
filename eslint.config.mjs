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
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
