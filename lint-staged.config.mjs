export default {
  '*.{js,ts,tsx,jsx,cjs,mjs}': ['prettier --write', 'eslint --fix'],
  '*.{md,json,yaml,yml,lock,html,css}': ['prettier --write'],
};
