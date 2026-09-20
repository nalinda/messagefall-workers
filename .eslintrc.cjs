module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  env: {
    node: true,
    es2025: true,
    worker: true,
  },
  plugins: ['tsdoc', 'simple-import-sort'],
  rules: {
    'no-console': 'off',
    'no-debugger': 'off',
    'no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^(?:a|c|d|e|i|n|r|s|t|v)\\$|args|it|describe|context|t|child|expect',
    }],
    'tsdoc/syntax': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^(?:a|c|d|e|i|n|r|s|t|v)\\$|args|it|describe|context|t|child|expect|it',
    }],
    'no-restricted-imports': ['error', {
      patterns: ['node:path', 'node:url', 'node:fs'],
    }],
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
    'import/no-duplicates': 'error',
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'path-groups': {
          'node:/*': ['always'],
          '@cloudflare': ['always'],
          '@serendibyte-co': ['always'],
          'better-auth': ['always'],
          'hono': ['always'],
        },
      },
    ],
  },
  overrides: [
    {
      files: ['*.test.ts', '*.spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/**', 'bun.lock', 'bun.lock.bak', '.husky/**', 'node_modules/**', 'example-*/**'],
};
