const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      console.log(`Build ${build.initialOptions.outfile} finished`);
      if (result.errors.length) {
        result.errors.forEach(error => {
          console.error(error);
        });
      }
    });
  }
};

const commonConfig = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
  metafile: !!process.env.VV_METAFILE_DIR, // vscode-port: bundle inputs for tools/gen-notices.mjs
};

const extensionConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/extension.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'], // Only external we actually need
  alias: {
    // vscode-shiki-bridge ships ESM as its default export, which can't be
    // bundled into a CJS output. Point esbuild at the CJS build instead.
    'vscode-shiki-bridge': './node_modules/vscode-shiki-bridge/dist/index.cjs',
    // jsonc-parser's UMD entry passes the real Node require() into its factory,
    // so internal require('./impl/format') calls escape esbuild's module system
    // and fail at runtime. Use the ESM entry so esbuild can bundle it statically.
    'jsonc-parser': './node_modules/jsonc-parser/lib/esm/main.js',
  },
  plugins: [esbuildProblemMatcherPlugin],
};

const workerConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/worker.ts'],
  format: 'iife', // Self-executing function for worker scope
  platform: 'node',
  outfile: 'dist/worker.js',
  plugins: [esbuildProblemMatcherPlugin],
  target: 'es2020', // Modern browsers support WASM
};

const fsdbWorkerConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/fsdb_worker.ts'],
  format: 'iife', // Self-executing function for worker scope
  platform: 'node',
  outfile: 'dist/fsdb_worker.js',
  external: ['../build/Release/fsdb_reader.node'],
  plugins: [esbuildProblemMatcherPlugin],
  target: 'es2020', // Modern browsers support WASM
};

const webviewConfig = {
  ...commonConfig,
  entryPoints: ['src/webview/vaporview.ts'],
  format: 'iife',
  platform: 'browser',
  outfile: 'dist/webview.js',
  plugins: [esbuildProblemMatcherPlugin],
  target: ['es2020'],
  treeShaking: production,
  metafile: true, // To analyze bundle
};


// vscode-port P4: the viewer's value formatters for the debugger's text breakpoints (src/cmux/dap/formats-entry.ts),
// loaded at run time by the extension host. value_format.ts imports the page for paths the formatters never reach;
// those imports are stubbed (as cmux's build-formats.mjs does).
// Also used by wisp searchText in the extension host (P2: src/webview/host_formats.ts -> dist/host_formats.js).
const formatsStubs = {
  './vaporview': 'export const dataManager = {enumTable: {}}; export const vscodeWrapper = {showMessage() {}, outputLog() {}};',
  './signal_item': 'export {};',
  './extra_formats': 'export function getExtraValueFormat() { return undefined; }',
  '@js-temporal/polyfill': 'export const Temporal = undefined;',
};
const hostFormatsConfig = {
  ...commonConfig,
  entryPoints: ['src/webview/host_formats.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/host_formats.js',
  target: 'es2020',
  plugins: [esbuildProblemMatcherPlugin, {name: 'host-format-stubs', setup(b) {
    b.onResolve({filter: /.*/}, (a) => (formatsStubs[a.path] !== undefined && a.importer.endsWith('value_format.ts') ? {path: a.path, namespace: 'host-stub'} : undefined));
    b.onLoad({filter: /.*/, namespace: 'host-stub'}, (a) => ({contents: formatsStubs[a.path], loader: 'ts'}));
  }}],
};
const formatsConfig = {
  ...commonConfig,
  entryPoints: ['src/cmux/dap/formats-entry.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/cmux-formats.js',
  plugins: [esbuildProblemMatcherPlugin, { name: 'formats-stubs', setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => (formatsStubs[a.path] !== undefined && a.importer.endsWith('value_format.ts') ? { path: a.path, namespace: 'formats-stub' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'formats-stub' }, (a) => ({ contents: formatsStubs[a.path], loader: 'ts' }));
  } }],
};

async function main() {
  try {
    if (watch) {
      const extensionCtx = await esbuild.context(extensionConfig);
      const webviewCtx = await esbuild.context(webviewConfig);
      const workerCtx = await esbuild.context(workerConfig);
      const fsdbWorkerCtx = await esbuild.context(fsdbWorkerConfig);

      const hostFormatsCtx = await esbuild.context(hostFormatsConfig); // vscode-port
      await Promise.all([
        hostFormatsCtx.watch(),
        extensionCtx.watch(),
        webviewCtx.watch(),
        workerCtx.watch(),
        fsdbWorkerCtx.watch()
      ]);
    } else {
      const results = await Promise.all([
        esbuild.build(hostFormatsConfig), // vscode-port
        esbuild.build(extensionConfig),
        esbuild.build(webviewConfig),
        esbuild.build(workerConfig),
        esbuild.build(fsdbWorkerConfig),
        esbuild.build(formatsConfig), // vscode-port P4
      ]);
      // vscode-port: write each bundle's metafile for the third-party notices (tools/package.sh)
      if (process.env.VV_METAFILE_DIR) {
        const fs = require('fs'), path = require('path');
        fs.mkdirSync(process.env.VV_METAFILE_DIR, { recursive: true });
        results.forEach((r, i) => fs.writeFileSync(path.join(process.env.VV_METAFILE_DIR, `bundle-${i}.json`), JSON.stringify(r.metafile)));
      }
    }
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}


main().catch(e => {
  console.error(e);
  process.exit(1);
});

