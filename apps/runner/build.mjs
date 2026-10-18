// Bundles the runner and the egress proxy into single files, so the image needs no node_modules.
import { build } from 'esbuild';

await Promise.all(
  [
    ['src/main.ts', 'dist/runner.mjs'],
    ['src/egress-main.ts', 'dist/egress.mjs'],
  ].map(([entry, outfile]) =>
    build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      // Some bundled CommonJS packages call require().
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logLevel: 'warning',
    }),
  ),
);
console.log('built dist/runner.mjs and dist/egress.mjs');
