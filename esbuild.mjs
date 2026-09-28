// Build script for the extension host bundle and the chat webview bundle.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Copy the codicon font + stylesheet so the webview can use VS Code's icons offline. */
function copyCodicons() {
  const src = 'node_modules/@vscode/codicons/dist';
  const dest = 'media/codicons';
  if (!existsSync(src)) {
    console.warn('[build] @vscode/codicons not installed; icons will be missing.');
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(`${src}/codicon.css`, `${dest}/codicon.css`);
  cpSync(`${src}/codicon.ttf`, `${dest}/codicon.ttf`);
}

const logPlugin = {
  name: 'log',
  setup(build) {
    build.onEnd((result) => {
      for (const e of result.errors) {
        console.error(`✘ ${e.text}${e.location ? ` (${e.location.file}:${e.location.line})` : ''}`);
      }
      console.log(`[build] ${build.initialOptions.outfile} ${result.errors.length ? 'failed' : 'ok'}`);
    });
  },
};

const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [logPlugin],
};

const webviewOptions = {
  entryPoints: ['src/webview/chat/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/webview.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [logPlugin],
};

copyCodicons();
cpSync('src/webview/chat/styles.css', 'dist/webview.css');

if (watch) {
  const a = await esbuild.context(extensionOptions);
  const b = await esbuild.context(webviewOptions);
  await Promise.all([a.watch(), b.watch()]);
  console.log('[build] watching…');
} else {
  const results = await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
  if (results.some((r) => r.errors.length)) process.exit(1);
}
