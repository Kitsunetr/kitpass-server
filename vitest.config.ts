import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // Argon2 hashing is slow in tests
    hookTimeout: 30000,
    sequence: {
      concurrent: false, // Tests share a DB, run serially
    },
  },
});
