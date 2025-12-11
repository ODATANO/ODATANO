module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.(ts)', '**/test/**/*.spec.(ts)'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: 'tsconfig.json'
    }]
  },
  transformIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^#cds-models/(.*)$': '<rootDir>/@cds-models/$1/index.js'
  },
  collectCoverageFrom: [
    'srv/**/*.ts',
    '!srv/**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 75,
      functions: 80,
      lines: 80
    }
  },
};
