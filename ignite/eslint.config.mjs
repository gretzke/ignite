import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import node from 'eslint-plugin-node';
import security from 'eslint-plugin-security';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      node: node,
      security: security,
    },
    rules: {
      // TypeScript Core
      ...typescript.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',

      // Node.js Specific
      'node/no-missing-import': 'off', // TypeScript handles this
      'node/no-unpublished-import': 'error',

      // Security
      'security/detect-child-process': 'warn', // We use exec() legitimately
      'security/detect-non-literal-fs-filename': 'warn',

      // Code Quality
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: 'error',
      'no-console': 'warn', // Allow console.log for deployment tool

      // Disable formatting rules (Prettier handles these)
      indent: 'off',
      quotes: 'off',
      semi: 'off',
      'comma-dangle': 'off',
    },
  },
];
