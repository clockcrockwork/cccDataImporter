module.exports = {
  roots: ['<rootDir>/packages'],
  transform: {
    '^.+\\.jsx?$': 'babel-jest',
  },
  testMatch: [
    '**/tests/**/*.test.js',
  ],
  moduleFileExtensions: ['js', 'jsx'],
  testEnvironment: 'node',
};
