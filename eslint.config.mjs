import cds from '@sap/cds/eslint.config.mjs';

import tsParser from '@typescript-eslint/parser';
import tseslint from '@typescript-eslint/eslint-plugin';

export default [
  
  // Global ignores (generated / noise)
  {
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      '**/out/**',
      '**/.cds-gen/**',
      '**/.cds-staging/**',
    ],
  },

   // SAP CAP recommended rules
  ...cds.recommended,


  // TypeScript support

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // prevent duplicate reporting (core vs TS)
      'no-unused-vars': 'off',

      // enforce unused vars in TS
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],

      'no-undef': 'error',
    },
  },

  
  // Jest test globals
  {
    files: [
      'test/**/*.{ts,js}',
      '**/__tests__/**/*.{ts,js}',
      '**/*.{test,spec}.{ts,js}',
    ],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
  },
];
