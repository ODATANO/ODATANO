import cds from '@sap/cds/eslint.config.mjs';
import cdsPlugin from '@sap/eslint-plugin-cds'
import tsParser from '@typescript-eslint/parser';
import tseslint from '@typescript-eslint/eslint-plugin';

export default [
  
  cdsPlugin.configs.recommended,
  
  // Global ignores (generated / noise)
  {
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      '**/out/**',
      '**/gen/**',
      '**/.cds-gen/**',
      '**/.cds-staging/**',
      '**/scripts/**',
      'srv/**/*.js',
      'src/**/*.js',
      // compiled build artifacts emitted in-place (tsconfig.build.json outDir ".")
      '**/*.d.ts',
      // local debugging repros (gitignored / npmignored)
      'repro-*.js',
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
        // type-aware linting: auto-discover the nearest tsconfig per file so the
        // typed rules below have real type information (previously absent — which
        // also made the no-explicit-any disable-comments reference an inactive rule)
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
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

      // High-value type-aware rules — catch the bug classes surfaced during the
      // review (unawaited promises, mis-used async, untyped any).
      '@typescript-eslint/no-floating-promises': 'warn',
      // arguments:false — async callbacks passed to event registrars like
      // cds.on('served'/'shutdown', async …) are an idiomatic, awaited CAP
      // pattern; keep the conditional/spread checks which catch real misuse.
      '@typescript-eslint/no-misused-promises': ['warn', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  
  // Vitest test globals (vitest.config.ts: test.globals = true)
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
        vi: 'readonly',
      },
    },
    rules: {
      // type-aware rules are noisy and low-value in test fixtures
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Browser globals for UI5 apps (signing-flow + wallet-viewer)
  {
    files: ['app/signing-flow/**/*.{ts,js}', 'app/wallet-viewer/**/*.{ts,js}', 'app/wallet/**/*.{ts,js}'],
    languageOptions: {
      globals: {
        navigator: 'readonly',
        window: 'readonly',
        TextDecoder: 'readonly',
      },
    },
  },
];
