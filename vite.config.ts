import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
