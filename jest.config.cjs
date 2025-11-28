module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.(ts|js)', '**/test/**/*.spec.(ts|js)'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest'
  },
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json'
    }
  },
  transformIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^#cds-models/(.*)$': '<rootDir>/@cds-models/$1/index.js'
  },
  testTimeout: 20000
};
