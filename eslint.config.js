import config from '@serendibyte-co/eslint-config';

export default config({
  ignores: ['dist/**', 'bun.lock', 'bun.lock.bak', '.husky/**', 'node_modules/**', 'example-*/**'],
  rules: {
    // Provider-specific rules are added here as plugins are developed
    'no-console': 'off', // Allow logging provider config for debugging
    'no-debugger': 'off',
  },
});
