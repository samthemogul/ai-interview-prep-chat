/** Directories that are never indexed or read, regardless of .gitignore. */
export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  'coverage',
  '.nyc_output',
  'vendor',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.gradle',
  '.idea',
  '.vscode-test',
  'Pods',
  'DerivedData',
  'bin',
  'obj',
]);

/** Glob for vscode.workspace.findFiles exclude, mirroring DEFAULT_IGNORED_DIRS. */
export const DEFAULT_EXCLUDE_GLOB = `**/{${[...DEFAULT_IGNORED_DIRS].join(',')}}/**`;

const BINARY_EXTENSIONS = new Set([
  // images & media
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'tiff',
  'psd',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'flac',
  'mov',
  'avi',
  'mkv',
  'webm',
  // archives & packages
  'zip',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'tar',
  'jar',
  'war',
  'ear',
  'whl',
  'nupkg',
  'vsix',
  'deb',
  'rpm',
  'dmg',
  'iso',
  'apk',
  'ipa',
  // compiled / object code
  'exe',
  'dll',
  'so',
  'dylib',
  'o',
  'a',
  'lib',
  'obj',
  'class',
  'pyc',
  'pyo',
  'wasm',
  'node',
  'pdb',
  'bin',
  'dat',
  // documents & fonts
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  // databases & models
  'db',
  'sqlite',
  'sqlite3',
  'gguf',
  'safetensors',
  'onnx',
  'pt',
  'pth',
  'h5',
  'pkl',
  'npy',
  'npz',
]);

const GENERATED_FILE_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)go\.sum$/,
  /\.pb\.(go|cc|h)$/,
  /_pb2\.py$/,
  /\.g\.dart$/,
  /\.generated\.[a-z]+$/i,
  /(^|[/_.-])generated([/_.-]|$)/i,
  /\.d\.ts\.map$/,
];

/** Files larger than this are never read into the model context. */
export const MAX_READ_BYTES = 256 * 1024;
/** Stop indexing after this many files; retrieval stays path-first beyond it. */
export const MAX_INDEX_FILES = 20_000;
/** Above this many files, content search only scans path-matched candidates. */
export const FULL_CONTENT_SEARCH_LIMIT = 1_500;

export function extensionOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isBinaryPath(relPath: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(relPath));
}

export function isGeneratedPath(relPath: string): boolean {
  return GENERATED_FILE_PATTERNS.some((re) => re.test(relPath));
}

export function isInIgnoredDir(relPath: string): boolean {
  const parts = relPath.split('/');
  parts.pop();
  return parts.some((p) => DEFAULT_IGNORED_DIRS.has(p));
}

/** True for paths that should be indexed (before .gitignore rules are applied). */
export function isIndexablePath(relPath: string): boolean {
  return !isInIgnoredDir(relPath) && !isBinaryPath(relPath) && !isGeneratedPath(relPath);
}

/** Content sniffing: a NUL byte in the first 8 KB means binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  md: 'markdown',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  proto: 'protobuf',
  graphql: 'graphql',
  tf: 'hcl',
};

export function languageForPath(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return LANGUAGE_BY_EXT[extensionOf(relPath)] ?? '';
}
