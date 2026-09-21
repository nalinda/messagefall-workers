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
      files: ['src/**/*.ts', 'test/**/*.ts', 'examples/**/*.ts'],
      runtime: 'worker',
    })
  ),
  {
    // unknown is the correct type for genuinely open-shaped data (env
    // bindings, KV values, JSON payloads) — banning it just pushes
    // toward fabricated interfaces or the separately-banned `any`.
    files: ['src/**/*.ts', 'test/**/*.ts', 'examples/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-types': 'off',
    },
  },
  {
    // "No message bodies in logs" (src/providers/README.md) is only a real rule if something
    // enforces it. The shared config's `no-console` still permits `log`/`info`/`warn`/`error`
    // for the worker runtime, so a bare `console.log(renderedText)` in a provider lints clean.
    // Ban raw console access under src/ outright: every line that reaches stdout then goes
    // through `createLogger`, which redacts. The two exceptions are the writers themselves —
    // the logger, and the console provider whose whole purpose is printing to a dev terminal
    // (and which does its own OTP-body redaction).
    files: ['src/**/*.ts'],
    ignores: ['src/core/logger.ts', 'src/providers/console/index.ts'],
    rules: {
      // The empty options object is load-bearing: a severity-only override (`'error'`, or even
      // `['error']`) keeps the inherited options in flat config, and the inherited `allow` list
      // is precisely what has to go.
      'no-console': ['error', {}],
    },
  },
  {
    // Test files legitimately run long and access test files / spawn subcommands.
    files: ['test/**/*.ts'],
    rules: {
      'sonarjs/max-lines': 'off',
      'sonarjs/max-lines-per-function': 'off',
      'sonarjs/no-os-command-from-path': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-regexp': 'off',
    },
  },
];
