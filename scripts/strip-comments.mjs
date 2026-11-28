import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_WEBSITE_ROOT = resolve(__dirname, '..');

const ROOT_CONFIG_FILES = [
  'astro.config.mjs',
  'vitest.config.ts',
  'playwright.config.ts',
  'wrangler.toml',
  '.dev.vars.example',
  '.gitignore',
];

const SCAN_DIRS = ['src', 'functions', 'api', 'scripts', 'tests', 'e2e'];

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.astro',
  'coverage',
  'public',
  'test-results',
  'playwright-report',
]);

const TS_JS_EXTENSIONS = new Set(['.ts', '.mts', '.mjs', '.js', '.gs']);
const HASH_CONFIG_FILES = new Set(['wrangler.toml', '.dev.vars.example', '.gitignore']);

function walkSourceDir(dir, results = []) {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkSourceDir(join(dir, entry.name), results);
    } else if (entry.isFile()) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

export function collectProjectFiles(websiteRoot = DEFAULT_WEBSITE_ROOT) {
  const files = [];
  for (const rel of ROOT_CONFIG_FILES) {
    const full = join(websiteRoot, rel);
    if (existsSync(full)) {
      files.push(full);
    }
  }
  for (const sub of SCAN_DIRS) {
    const fullDir = join(websiteRoot, sub);
    for (const filePath of walkSourceDir(fullDir)) {
      const ext = extname(filePath).toLowerCase();
      if (TS_JS_EXTENSIONS.has(ext) || ext === '.css' || ext === '.astro') {
        files.push(filePath);
      }
    }
  }
  return files;
}

function getScriptKind(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.mts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function collectLeafTokens(node, sourceFile, out) {
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    out.push(node);
    return;
  }
  for (const child of children) {
    collectLeafTokens(child, sourceFile, out);
  }
}

export function findTsJsCommentRanges(text, filePath = 'file.ts') {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
  const leaves = [];
  collectLeafTokens(sourceFile, sourceFile, leaves);

  const ranges = [];
  const seen = new Set();

  for (const leaf of leaves) {
    const fullStart = leaf.getFullStart();
    const tokenStart = leaf.getStart(sourceFile);
    if (tokenStart <= fullStart) continue;

    const trivia = text.slice(fullStart, tokenStart);
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      trivia,
    );

    let kind = scanner.scan();
    while (kind !== ts.SyntaxKind.EndOfFileToken) {
      if (
        kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        const start = fullStart + scanner.getTokenPos();
        const end = fullStart + scanner.getTextPos();
        const key = `${start}:${end}`;
        if (!seen.has(key)) {
          seen.add(key);
          ranges.push({
            start,
            end,
            isSingleLine: kind === ts.SyntaxKind.SingleLineCommentTrivia,
          });
        }
      }
      kind = scanner.scan();
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function isIdentChar(ch) {
  return Boolean(ch && /[A-Za-z0-9_$]/.test(ch));
}

function removeRangesCleanly(text, ranges) {
  if (ranges.length === 0) return text;

  const edits = [];
  for (const range of ranges) {
    let start = range.start;
    let end = range.end;

    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const beforeOnLine = text.slice(lineStart, start);
    const onlyIndentBefore = /^[ \t]*$/.test(beforeOnLine);

    let afterEnd = end;
    while (afterEnd < text.length && (text[afterEnd] === ' ' || text[afterEnd] === '\t')) {
      afterEnd += 1;
    }

    const hitsCrLf = text[afterEnd] === '\r' && text[afterEnd + 1] === '\n';
    const hitsLf = text[afterEnd] === '\n';
    const hitsEof = afterEnd === text.length;

    if (onlyIndentBefore && (hitsCrLf || hitsLf || hitsEof)) {
      start = lineStart;
      end = hitsCrLf ? afterEnd + 2 : hitsLf ? afterEnd + 1 : afterEnd;
      edits.push({ start, end, replacement: '' });
      continue;
    }

    if (range.isSingleLine) {
      let trimStart = start;
      while (
        trimStart > lineStart &&
        (text[trimStart - 1] === ' ' || text[trimStart - 1] === '\t')
      ) {
        trimStart -= 1;
      }
      edits.push({ start: trimStart, end, replacement: '' });
      continue;
    }

    const prevCh = text[start - 1];
    const nextCh = text[end];
    const replacement = isIdentChar(prevCh) && isIdentChar(nextCh) ? ' ' : '';
    edits.push({ start, end, replacement });
  }

  edits.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const edit of edits) {
    if (merged.length === 0) {
      merged.push(edit);
    } else {
      const prev = merged[merged.length - 1];
      if (edit.start <= prev.end) {
        prev.end = Math.max(prev.end, edit.end);
      } else {
        merged.push(edit);
      }
    }
  }

  let output = '';
  let cursor = 0;
  for (const edit of merged) {
    output += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  output += text.slice(cursor);
  return collapseBlankLines(output);
}

function collapseBlankLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.replace(/(?:\r?\n){3,}/g, `${eol}${eol}`);
}

export function stripTsJsComments(text, filePath = 'file.ts') {
  const ranges = findTsJsCommentRanges(text, filePath);
  return {
    output: removeRangesCleanly(text, ranges),
    count: ranges.length,
  };
}

export function findCssCommentRanges(text) {
  const ranges = [];
  let i = 0;
  let inQuote = '';

  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inQuote) {
        inQuote = '';
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i += 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const start = i;
      const closeIdx = text.indexOf('*/', i + 2);
      const end = closeIdx === -1 ? text.length : closeIdx + 2;
      ranges.push({ start, end, isSingleLine: false });
      i = end;
      continue;
    }

    i += 1;
  }

  return ranges;
}

export function stripCssComments(text) {
  const ranges = findCssCommentRanges(text);
  return {
    output: removeRangesCleanly(text, ranges),
    count: ranges.length,
  };
}

export function findAstroHtmlCommentRanges(templateText) {
  const ranges = [];
  let i = 0;
  let inTag = false;
  let attrQuote = '';

  while (i < templateText.length) {
    const ch = templateText[i];

    if (inTag) {
      if (attrQuote) {
        if (ch === attrQuote) attrQuote = '';
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        attrQuote = ch;
        i += 1;
        continue;
      }
      if (ch === '>') {
        inTag = false;
      }
      i += 1;
      continue;
    }

    if (templateText.startsWith('<!--', i)) {
      const closeIdx = templateText.indexOf('-->', i + 4);
      const end = closeIdx === -1 ? templateText.length : closeIdx + 3;
      ranges.push({ start: i, end, isSingleLine: false });
      i = end;
      continue;
    }

    if (templateText.startsWith('{/*', i)) {
      const closeIdx = templateText.indexOf('*/}', i + 3);
      const end = closeIdx === -1 ? templateText.length : closeIdx + 3;
      ranges.push({ start: i, end, isSingleLine: false });
      i = end;
      continue;
    }

    if (ch === '<' && /[A-Za-z/!]/.test(templateText[i + 1] || '')) {
      inTag = true;
      i += 1;
      continue;
    }

    i += 1;
  }

  return ranges;
}

export function stripAstroComments(text, filePath = 'component.astro') {
  let totalCount = 0;
  let frontmatterPrefix = '';
  let body = text;

  const fmMatch = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?=[ \t]*(?:\r?\n|$))/);
  if (fmMatch) {
    const fullFm = fmMatch[0];
    const openEnd = fullFm.indexOf('\n') + 1;
    const closeStart = fullFm.lastIndexOf('---');
    const fmCode = fullFm.slice(openEnd, closeStart);
    const strippedFm = stripTsJsComments(fmCode, `${filePath}.ts`);
    totalCount += strippedFm.count;
    frontmatterPrefix = fullFm.slice(0, openEnd) + strippedFm.output + fullFm.slice(closeStart);
    body = text.slice(fullFm.length);
  }

  const blockRegex = /<(script|style)(\b[^>]*)>([\s\S]*?)<\/\1>/gi;
  let resultBody = '';
  let lastIdx = 0;
  let match = blockRegex.exec(body);

  while (match !== null) {
    const beforeHtml = body.slice(lastIdx, match.index);
    const htmlRanges = findAstroHtmlCommentRanges(beforeHtml);
    totalCount += htmlRanges.length;
    resultBody += removeRangesCleanly(beforeHtml, htmlRanges);

    const tagName = match[1].toLowerCase();
    const attrs = match[2];
    const inner = match[3];
    const isJsonLd = /application\/ld\+json/i.test(attrs);

    if (tagName === 'script' && !isJsonLd) {
      const strippedScript = stripTsJsComments(inner, `${filePath}.script.ts`);
      totalCount += strippedScript.count;
      resultBody += `<${match[1]}${attrs}>${strippedScript.output}</${match[1]}>`;
    } else if (tagName === 'style') {
      const strippedStyle = stripCssComments(inner);
      totalCount += strippedStyle.count;
      resultBody += `<${match[1]}${attrs}>${strippedStyle.output}</${match[1]}>`;
    } else {
      resultBody += match[0];
    }

    lastIdx = match.index + match[0].length;
    match = blockRegex.exec(body);
  }

  const tailHtml = body.slice(lastIdx);
  const tailRanges = findAstroHtmlCommentRanges(tailHtml);
  totalCount += tailRanges.length;
  resultBody += removeRangesCleanly(tailHtml, tailRanges);

  const combined = collapseBlankLines(frontmatterPrefix + resultBody);
  return {
    output: combined,
    count: totalCount,
  };
}

export function stripHashConfigComments(text, fileName) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const outLines = [];
  let count = 0;
  const isToml = fileName.endsWith('.toml');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      count += 1;
      continue;
    }

    if (isToml) {
      let inQuote = '';
      let hashIdx = -1;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inQuote) {
          if (inQuote === '"' && ch === '\\') {
            i += 1;
            continue;
          }
          if (ch === inQuote) inQuote = '';
          continue;
        }
        if (ch === '"' || ch === "'") {
          inQuote = ch;
          continue;
        }
        if (ch === '#') {
          hashIdx = i;
          break;
        }
      }
      if (hashIdx !== -1) {
        count += 1;
        outLines.push(line.slice(0, hashIdx).replace(/[ \t]+$/, ''));
        continue;
      }
    }

    outLines.push(line);
  }

  return {
    output: collapseBlankLines(outLines.join(eol)),
    count,
  };
}

export function stripFileContent(filePath, content) {
  const fileName = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  if (HASH_CONFIG_FILES.has(fileName)) {
    return stripHashConfigComments(content, fileName);
  }
  if (TS_JS_EXTENSIONS.has(ext)) {
    return stripTsJsComments(content, filePath);
  }
  if (ext === '.css') {
    return stripCssComments(content);
  }
  if (ext === '.astro') {
    return stripAstroComments(content, filePath);
  }
  return { output: content, count: 0 };
}

export function scanCommentsInProject(websiteRoot = DEFAULT_WEBSITE_ROOT) {
  const files = collectProjectFiles(websiteRoot);
  const violations = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8');
    const result = stripFileContent(filePath, content);
    if (result.count > 0) {
      violations.push({
        file: relative(websiteRoot, filePath).replace(/\\/g, '/'),
        count: result.count,
      });
    }
  }

  return violations;
}

export function stripCommentsInProject(websiteRoot = DEFAULT_WEBSITE_ROOT) {
  const files = collectProjectFiles(websiteRoot);
  const modified = [];

  for (const filePath of files) {
    const original = readFileSync(filePath, 'utf8');
    const result = stripFileContent(filePath, original);
    if (result.count > 0 && result.output !== original) {
      writeFileSync(filePath, result.output, 'utf8');
      modified.push({
        file: relative(websiteRoot, filePath).replace(/\\/g, '/'),
        removed: result.count,
      });
    }
  }

  return {
    scannedCount: files.length,
    modified,
  };
}

const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const summary = stripCommentsInProject(DEFAULT_WEBSITE_ROOT);
  const remaining = scanCommentsInProject(DEFAULT_WEBSITE_ROOT);
  console.log(
    `[strip-comments] Scanned ${summary.scannedCount} files, cleaned ${summary.modified.length} file(s), remaining comment files: ${remaining.length}`,
  );
  for (const item of summary.modified) {
    console.log(`  - ${item.file}: removed ${item.removed} comment(s)`);
  }
  if (remaining.length > 0) {
    for (const item of remaining) {
      console.error(`  ! Remaining comment(s) in ${item.file}: ${item.count}`);
    }
    process.exit(1);
  }
}
