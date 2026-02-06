// Set NODE_ENV for test detection in application code
process.env.NODE_ENV = 'test';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // better than setupFiles in many setups
  setupFilesAfterEnv: [
    'ts-node/register/transpile-only',
    '<rootDir>/test/jest.setup.ts'
  ],

  testMatch: ['**/test/**/*.test.ts', '**/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],

  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },

  transformIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^#cds-models/(.*)$': '<rootDir>/@cds-models/$1/index.js',
  },

  collectCoverageFrom: [
    'srv/**/*.ts',
    '!srv/**/*.d.ts',
    '!**/node_modules/**',
    //'!srv/blockchain/backends/ogmios-backend.ts'
  ],
  coverageThreshold: {
    global: { branches: 75, functions: 75, lines: 75 },
  },

  openHandlesTimeout: 0,

  // Increase test timeout (default is 5000ms)
  testTimeout: 120000,

  // Increase slow test threshold to avoid warnings (default is 5000ms)
  slowTestThreshold: 120000,
};

