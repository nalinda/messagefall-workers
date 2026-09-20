/**
 * ESLint configuration for messagefall-workers.
 *
 * Extends @serendibyte-co/eslint-config for Node-specific rules,
 * but overrides runtime to 'worker' for Workers compatibility.
 */

import { node } from '@serendibyte-co/eslint-config/node';

// The shared config downgrades many rules to 'warn' because the monorepo it
// was extracted from had pre-existing violations, not because the rules
// don't matter (see its own base.js comment). This project starts clean, so
// every warning is promoted to an error — nothing here should be quietly
// ignorable.
function errorsOnly(configs) {
  return configs.map((config) => {
    if (!config.rules) return config;
    const rules = Object.fromEntries(
      Object.entries(config.rules).map(([name, value]) => {
        if (value === 'warn') return [name, 'error'];
        if (Array.isArray(value) && value[0] === 'warn')
          return [name, ['error', ...value.slice(1)]];
        return [name, value];
      })
    );
    return { ...config, rules };
  });
}

export default [
  {
    ignores: ['node_modules', 'dist', '.wrangler', '.worktrees', 'coverage'],
  },
  ...errorsOnly(
    node({
      tsconfigRootDir: import.meta.dirname,
      files: ['src/**/*.ts', 'test/**/*.ts'],
      runtime: 'worker',
    })
  ),
  {
    // unknown is the correct type for genuinely open-shaped data (env
    // bindings, KV values, JSON payloads) — banning it just pushes
    // toward fabricated interfaces or the separately-banned `any`.
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-types': 'off',
    },
  },
  {
    // Test files legitimately run long — a suite covering many scenarios for
    // one function reads better kept together than split just to satisfy a
    // line-count ceiling.
    files: ['test/**/*.ts'],
    rules: {
      'sonarjs/max-lines': 'off',
      'sonarjs/max-lines-per-function': 'off',
    },
  },
  {
    // Stub and test providers are intentionally simplified for development.
    files: ['src/providers/stub/**/*.ts', 'src/providers/test/**/*.ts'],
    rules: {
      'no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-async-promise-executor': 'off',
      'no-floating-promise': 'off',
    },
  },
];
