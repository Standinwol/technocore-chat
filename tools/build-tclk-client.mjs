import { build } from 'esbuild';

await build({
  entryPoints: ['tools/tclk-viewer-entry.mjs'],
  outfile: 'client/tclk-viewer.mjs',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  legalComments: 'inline',
  banner: {
    js: '// Generated from tools/tclk-viewer-entry.mjs with @flop-labs/tclk@0.1.0 (Apache-2.0).\n// Bundled @noble dependencies are MIT licensed. Run `npm run build:client-tclk` to rebuild.',
  },
});
