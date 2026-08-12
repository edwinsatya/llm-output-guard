import { defineConfig, type Options } from 'tsup';

/*
 * `satisfies Options` rather than `as const`: the latter made `format` a
 * readonly tuple, which tsup's own `Format[]` will not accept. This checks the
 * shape against tsup's types while still contextually typing `outExtension`.
 */
const shared = {
  format: ['esm', 'cjs'],
  sourcemap: true,
  treeshake: true,
  target: 'es2022',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
} satisfies Options;

export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts', 'src/ai-sdk.ts', 'src/openai.ts'],
    dts: true,
    clean: true,
  },
  {
    // Separate build purely for the shebang, which tsup applies per config.
    // `clean` is off so this does not delete the library built above.
    ...shared,
    entry: ['src/bin.ts'],
    dts: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
