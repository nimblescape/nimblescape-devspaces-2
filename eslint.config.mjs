// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lint (npm run lint), the same in every nimblescape extension: the recommended rules of ESLint and of
// typescript-eslint, and three rules that read the types of tsconfig.json and find promises that nobody waits for.
// Only the lists `ignored` and `webviewScripts` differ between the extensions. typescript-eslint reads the types with
// the TypeScript of the development tools, 6.0: typescript-eslint does not support TypeScript 7.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The files that ESLint does not check: the files that the build and the tests write.
const ignored = [
  '**/dist/',
  '**/out/',
  '**/coverage/',
  '**/test-results/',
  '**/.vscode-test/',
];
// The scripts that run in a webview, with the globals of a browser.
const webviewScripts = ['resources/groupsEditor/**/*.js'];

export default defineConfig(
  globalIgnores(ignored),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // A promise that nobody awaits loses its error. An async function as a listener of VS Code is allowed: the
      // listeners catch their errors themselves. Promise.all may get values next to promises.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': ['error', { allowMixedPromiseArrays: true }],
      // A name that starts with _ is unused on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // A variable that a function reads before its only assignment (a forward reference) stays `let`.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // The extensions remove control characters from text on purpose, with regular expressions.
      'no-control-regex': 'off',
    },
  },
  // The JavaScript files and the configuration files of the tools are not part of tsconfig.json: rules without types.
  // A JavaScript file may be a CommonJS module that loads modules with require().
  { files: ['**/*.{js,mjs,cjs,mts,cts}'], extends: [tseslint.configs.disableTypeChecked] },
  { files: ['**/*.{js,cjs}'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  webviewScripts.length > 0
    ? { files: webviewScripts, languageOptions: { globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } } }
    : [],
);
