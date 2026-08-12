import { defineConfig } from 'tsup';

const shared = {
  format: ['esm', 'cjs'] as const,
  sourcemap: true,
  treeshake: true,
  target: 'es2022' as const,
  outExtension: ({ format }: { format: string }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
};

export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts', 'src/ai-sdk.ts'],
    dts: true,
    clean: true,
  },
  {
    // Separate build purely for the shebang, which tsup applies per config.
    // `clean` is off so this does not delete the library built above.
    ...shared,
    entry: ['src/cli.ts'],
    dts: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
