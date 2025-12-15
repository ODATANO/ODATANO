module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // better than setupFiles in many setups
  setupFilesAfterEnv: ['ts-node/register/transpile-only'],

  testMatch: ['**/test/**/*.test.ts', '**/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],

  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },

  transformIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^#cds-models/(.*)$': '<rootDir>/@cds-models/$1/index.js',
  },

  collectCoverageFrom: ['srv/**/*.ts', '!srv/**/*.d.ts', '!**/node_modules/**'],
  coverageThreshold: {
    global: { statements: 80, branches: 70, functions: 80, lines: 80 },
  },

  openHandlesTimeout: 0,
};

