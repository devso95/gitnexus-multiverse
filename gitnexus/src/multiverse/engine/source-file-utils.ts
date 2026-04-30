import fs from 'node:fs';
import path from 'node:path';
import type { SupportedSourceLanguage } from '../config/types.js';

const SOURCE_EXTENSIONS = new Set([
  '.java',
  '.kt',
  '.kts',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.cs',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'build',
  'dist',
  'out',
  'vendor',
  'bin',
  'obj',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.next',
  '.nuxt',
  'coverage',
]);

const PATH_EXCLUDE_FRAGMENTS = [
  '/__tests__/',
  '/__fixtures__/',
  '/fixtures/',
  '/fixture/',
  '/examples/',
  '/example/',
  '/samples/',
  '/sample/',
  '/docs/',
  '/storybook-static/',
  '/coverage/',
];

const FILE_NAME_EXCLUDES = [
  /\.d\.ts$/i,
  /\.test\.[a-z0-9]+$/i,
  /\.spec\.[a-z0-9]+$/i,
  /_test\.go$/i,
  /tests?\.swift$/i,
  /tests?\.cs$/i,
  /test\.php$/i,
  /spec\.php$/i,
  /_spec\.rb$/i,
  /_test\.rb$/i,
];

const LANGUAGE_BY_EXTENSION: Record<string, SupportedSourceLanguage> = {
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.cs': 'csharp',
  '.xml': 'xml',
};

export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function detectSourceLanguage(filePath: string): SupportedSourceLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

export function isSupportedSourceFile(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath).toLowerCase();
  const ext = path.extname(normalized);
  if (!SOURCE_EXTENSIONS.has(ext)) return false;
  return !FILE_NAME_EXCLUDES.some((pattern) => pattern.test(normalized));
}

export function shouldSkipSourcePath(filePath: string): boolean {
  const normalized = `/${normalizeRepoPath(filePath).replace(/^\/+/, '').toLowerCase()}`;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  if (PATH_EXCLUDE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true;
  return FILE_NAME_EXCLUDES.some((pattern) => pattern.test(normalized));
}

export function findMultiverseSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (currentDir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name) && !shouldSkipSourcePath(full)) walk(full);
        continue;
      }
      if (entry.isFile() && isSupportedSourceFile(full) && !shouldSkipSourcePath(full)) {
        results.push(full);
      }
    }
  };

  walk(dir);
  return results;
}

export function parseStringArray(value: unknown): string[] | undefined {
  if (value == null || value === '') return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {
    return trimmed
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

export function normalizeFileExtensions(value: unknown): string[] | undefined {
  const list = parseStringArray(value);
  if (!list?.length) return undefined;
  return list.map((ext) => {
    const trimmed = ext.trim().toLowerCase();
    return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  });
}

type ApplicabilityCarrier = {
  languages?: unknown;
  fileExtensions?: unknown;
  excludePathPatterns?: unknown;
};

export function normalizePatternApplicability<T extends object>(value: T): T {
  const normalized = { ...value } as T & ApplicabilityCarrier;

  const languages = parseStringArray(normalized.languages);
  if (languages?.length) normalized.languages = languages.map((lang) => lang.toLowerCase());
  else delete normalized.languages;

  const fileExtensions = normalizeFileExtensions(normalized.fileExtensions);
  if (fileExtensions?.length) normalized.fileExtensions = fileExtensions;
  else delete normalized.fileExtensions;

  const excludePathPatterns = parseStringArray(normalized.excludePathPatterns);
  if (excludePathPatterns?.length) normalized.excludePathPatterns = excludePathPatterns;
  else delete normalized.excludePathPatterns;

  return normalized as T;
}

export function matchesFileApplicability(
  filePath: string,
  applicability?: {
    languages?: readonly string[];
    fileExtensions?: readonly string[];
    excludePathPatterns?: readonly string[];
  },
): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (shouldSkipSourcePath(normalized)) return false;

  const normalizedApplicability = normalizePatternApplicability({ ...(applicability || {}) });
  const language = detectSourceLanguage(normalized);
  const extension = path.extname(normalized).toLowerCase();

  if (normalizedApplicability.languages?.length) {
    if (!language || !normalizedApplicability.languages.includes(language)) return false;
  }

  if (normalizedApplicability.fileExtensions?.length) {
    if (!normalizedApplicability.fileExtensions.includes(extension)) return false;
  }

  if (normalizedApplicability.excludePathPatterns?.length) {
    for (const pattern of normalizedApplicability.excludePathPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(normalized)) return false;
      } catch {
        if (normalized.toLowerCase().includes(pattern.toLowerCase())) return false;
      }
    }
  }

  return true;
}

export function sanitizeSourceLines(lines: string[]): string[] {
  let inBlockComment = false;
  let inTripleSingle = false;
  let inTripleDouble = false;

  return lines.map((line) => {
    let result = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplate = false;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1] || '';
      const nextTwo = line.slice(i, i + 3);

      if (inTripleSingle) {
        if (nextTwo === "'''") {
          result += '   ';
          i += 2;
          inTripleSingle = false;
        } else {
          result += ' ';
        }
        continue;
      }

      if (inTripleDouble) {
        if (nextTwo === '"""') {
          result += '   ';
          i += 2;
          inTripleDouble = false;
        } else {
          result += ' ';
        }
        continue;
      }

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          result += '  ';
          i++;
          inBlockComment = false;
        } else {
          result += ' ';
        }
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inTemplate && nextTwo === "'''") {
        result += '   ';
        i += 2;
        inTripleSingle = true;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inTemplate && nextTwo === '"""') {
        result += '   ';
        i += 2;
        inTripleDouble = true;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inTemplate && ch === '/' && next === '*') {
        result += '  ';
        i++;
        inBlockComment = true;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inTemplate && ch === '/' && next === '/') {
        result += ' '.repeat(line.length - i);
        break;
      }

      if (!inDoubleQuote && !inTemplate && ch === "'" && !escaped) {
        inSingleQuote = !inSingleQuote;
        result += ' ';
        continue;
      }

      if (!inSingleQuote && !inTemplate && ch === '"' && !escaped) {
        inDoubleQuote = !inDoubleQuote;
        result += ' ';
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && ch === '`' && !escaped) {
        inTemplate = !inTemplate;
        result += ' ';
        continue;
      }

      if (inSingleQuote || inDoubleQuote || inTemplate) {
        result += ' ';
        escaped = ch === '\\' && !escaped;
        continue;
      }

      result += ch;
      escaped = ch === '\\' && !escaped;
    }

    return result;
  });
}
