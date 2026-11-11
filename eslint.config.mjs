import js from '@eslint/js';
import globals from 'globals';

// TypeScript 7 is checked by tsc; typescript-eslint currently requires TS <6.1.
// Do not force an unsupported parser. This gate covers shipped JS/CJS and tooling.
export default [
  { ignores: ['node_modules/**', 'dist/**', 'dist-build/**', '.opencode/**', '.local/**', '**/fixtures/**'] },
  { files: ['apps/**/*.{js,cjs}', 'packages/**/*.{js,cjs}', 'ops/**/*.{js,cjs}', 'scripts/**/*.{js,cjs}', '*.mjs'],
    languageOptions: { ecmaVersion: 'latest', globals: { ...globals.node, ...globals.browser } },
    // Correctness rules, not mass formatting/style changes to existing modules.
    rules: Object.fromEntries([
      'constructor-super', 'for-direction', 'getter-return', 'no-async-promise-executor',
      'no-class-assign', 'no-compare-neg-zero', 'no-cond-assign', 'no-const-assign',
      'no-constant-binary-expression', 'no-dupe-args', 'no-dupe-class-members', 'no-dupe-else-if',
      'no-dupe-keys', 'no-duplicate-case', 'no-fallthrough', 'no-import-assign', 'no-invalid-regexp',
      'no-new-native-nonconstructor', 'no-obj-calls', 'no-self-assign', 'no-setter-return',
      'no-sparse-arrays', 'no-this-before-super', 'no-undef', 'no-unexpected-multiline',
      'no-unreachable', 'no-unsafe-finally', 'no-unsafe-negation', 'no-unsafe-optional-chaining',
      'use-isnan', 'valid-typeof'
    ].map(rule => [rule, js.configs.recommended.rules[rule] || 'error']))
  }
];
