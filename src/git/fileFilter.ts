/**
 * Extensions that are not meaningful to review as text diffs.
 * Files matching any of these will be excluded from the diff tree.
 */
const NON_REVIEWABLE_EXTENSIONS = new Set([
  // Images (raster)
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'tiff',
  'tif',
  'webp',
  'ico',
  'heic',
  'heif',
  'avif',
  'raw',
  'cr2',
  'cr3',
  'nef',
  'orf',
  'sr2',
  'arw',
  'dng',
  'rw2',
  'pef',
  'x3f',

  // Images (vector / design)
  'psd',
  'psb',
  'ai',
  'eps',
  'indd',
  'xd',
  'fig',
  'sketch',

  // Video
  'mp4',
  'mkv',
  'avi',
  'mov',
  'wmv',
  'flv',
  'webm',
  'm4v',
  '3gp',
  '3g2',
  'ogv',
  'mts',
  'm2ts',
  'vob',
  'rm',
  'rmvb',

  // Audio
  'mp3',
  'wav',
  'ogg',
  'flac',
  'aac',
  'wma',
  'm4a',
  'opus',
  'aiff',
  'aif',
  'mid',
  'midi',
  'amr',
  'ape',

  // Documents
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'odg',
  'odf',
  'pages',
  'numbers',
  'key',

  // Archives & compressed
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'zst',
  'lz4',
  'lzma',
  '7z',
  'rar',
  'cab',
  'iso',
  'img',
  'dmg',
  'pkg',
  'deb',
  'rpm',

  // Fonts
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',

  // Compiled / native binaries
  'exe',
  'dll',
  'so',
  'dylib',
  'lib',
  'a',
  'o',
  'obj',
  'pyc',
  'pyo',
  'pyd',
  'class',
  'jar',
  'war',
  'ear',
  'aar',
  'apk',
  'ipa',
  'appimage',
  'dex',

  // Databases
  'sqlite',
  'sqlite3',
  'db',
  'mdb',
  'accdb',
  'frm',
  'ibd',

  // Certificates & cryptographic keys (binary formats)
  'der',
  'p12',
  'pfx',
  'cer',
  'crt',
  'p7b',
  'p7c',

  // 3D models & game assets
  'fbx',
  'blend',
  'stl',
  'dae',
  'glb',
  'gltf',
  'obj',
  'mtl',
  'max',
  'ma',
  'mb',
  'uasset',
  'unity3d',
  'prefab',
  'mesh',

  // Generic binary / data blobs
  'bin',
  'dat',
  'dump',
  'bak',
  'hex',
  'rom',

  // Miscellaneous
  'parquet',
  'avro',
  'orc',
  'pb',
  'proto_bin',
]);

/**
 * Returns true if the file should be included in the diff review.
 * Filters out binary and non-text file types by extension.
 */
export function isReviewable(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return true;
  return !NON_REVIEWABLE_EXTENSIONS.has(ext);
}
