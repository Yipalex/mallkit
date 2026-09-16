#!/usr/bin/env node
/**
 * Mallkit upstream sync engine.
 *
 * Copies files from a private upstream checkout into this repository, applying
 * a manifest that denies private paths, rewrites strings, and overlays template
 * files. A privacy gate then scans the produced tree; any hit aborts the run
 * without writing state or committing anything.
 *
 * Text output is normalized to LF to match this repository's .gitattributes,
 * which keeps repeated runs byte-identical and therefore commit-free.
 *
 * The engine is generic and public. All project-specific rules (deny globs,
 * replacement table, private patterns, override templates) live in the upstream
 * repository under .github/mallkit/ and are passed in via --manifest.
 *
 * Usage:
 *   node tools/sync/sync.mjs --manifest <path> --src <upstream> --dest <repo> [--no-push] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SELF_RELATIVE = 'tools/sync/sync.mjs';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { noPush: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-push') out.noPush = true;
    else if (arg === '--dry-run') { out.dryRun = true; out.noPush = true; }
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`选项 ${arg} 缺少取值`);
      out[key] = value;
      i += 1;
    } else fail(`无法识别的参数：${arg}`);
  }
  for (const required of ['manifest', 'src', 'dest']) {
    if (!out[required]) fail(`缺少必需选项 --${required}`);
  }
  return out;
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(2);
}

// --------------------------------------------------------------- glob match

/**
 * Translate a glob into a regular expression.
 * Supports **, *, ?, character classes and {a,b} alternation.
 * `*` never matches a path separator; `**` does.
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero segments, so the trailing slash is optional.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) re += '\\{';
      else {
        const parts = glob.slice(i + 1, close).split(',');
        re += `(?:${parts.map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = close;
      }
    } else if (ch === '[') {
      const close = glob.indexOf(']', i);
      if (close === -1) re += '\\[';
      else { re += glob.slice(i, close + 1); i = close; }
    } else if ('.+^$()|\\'.includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

function makeMatcher(globs) {
  const patterns = (globs || []).map(globToRegExp);
  return (relPath) => patterns.some((re) => re.test(relPath));
}

// ------------------------------------------------------------- file helpers

function listFiles(root, subdir = '') {
  const abs = path.join(root, subdir);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const rel = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      files.push(...listFiles(root, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function isProbablyBinary(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function isTextFile(relPath, textExt) {
  const ext = path.extname(relPath).toLowerCase();
  if (textExt.includes(ext)) return true;
  // Extension-less dotfiles such as .gitignore are treated as text.
  return ext === '' && path.basename(relPath).startsWith('.');
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function removeEmptyDirs(root, dir) {
  let current = dir;
  while (current.startsWith(root) && current !== root) {
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// ------------------------------------------------------------- replacements

/**
 * Apply the manifest replacement table to a text body.
 * Entries are objects: { from, to, regex?: bool, flags?: string, files?: [glob] }
 * Order matters; entries run top to bottom. Line endings are preserved because
 * we never split on newlines.
 */
function applyReplacements(body, rules, relPath) {
  let out = body;
  for (const rule of rules) {
    if (rule.files && !makeMatcher(rule.files)(relPath)) continue;
    const flags = rule.flags || 'g';
    const pattern = rule.regex
      ? new RegExp(rule.from, flags)
      : new RegExp(rule.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    out = out.replace(pattern, rule.to);
  }
  return out;
}

// -------------------------------------------------------------- privacy gate

function loadPatterns(entries, origin) {
  return (entries || []).map((entry) => {
    try {
      return {
        category: entry.category || 'unnamed',
        origin,
        re: new RegExp(entry.pattern, entry.flags || 'gi'),
        allow: (entry.allow || []).map((a) => new RegExp(a, 'i')),
      };
    } catch (err) {
      fail(`${origin} 中的正则无法编译（${entry.category}）：${err.message}`);
      return null;
    }
  });
}

function maskSnippet(line, matchText) {
  const masked = matchText.length <= 4
    ? '*'.repeat(matchText.length)
    : `${matchText.slice(0, 2)}${'*'.repeat(Math.max(matchText.length - 4, 1))}${matchText.slice(-2)}`;
  const replaced = line.replace(matchText, masked);
  const trimmed = replaced.trim();
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed;
}

/**
 * Scan a directory tree for forbidden patterns.
 * Returns a list of { file, line, category, snippet }.
 */
function scanTree(root, scanRoot, patterns, textExt, skipMatcher) {
  const hits = [];
  const files = listFiles(path.join(root, scanRoot));
  for (const rel of files) {
    const displayPath = scanRoot ? `${scanRoot}/${rel}` : rel;
    if (skipMatcher && skipMatcher(displayPath)) continue;
    const absolute = path.join(root, scanRoot, rel);
    const buffer = fs.readFileSync(absolute);
    if (isProbablyBinary(buffer)) continue;
    if (!isTextFile(rel, textExt)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      for (const pattern of patterns) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(line)) !== null) {
          const text = match[0];
          if (pattern.allow.some((a) => a.test(text))) {
            if (match.index === pattern.re.lastIndex) pattern.re.lastIndex += 1;
            continue;
          }
          hits.push({
            file: displayPath,
            line: i + 1,
            category: pattern.category,
            origin: pattern.origin,
            snippet: maskSnippet(line, text),
          });
          if (match.index === pattern.re.lastIndex) pattern.re.lastIndex += 1;
          break;
        }
      }
    }
  }
  return hits;
}

// --------------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  const srcRoot = path.resolve(args.src);
  const destRoot = path.resolve(args.dest);
  const manifestPath = path.resolve(args.manifest);

  if (!fs.existsSync(srcRoot)) fail(`上游目录不存在：${srcRoot}`);
  if (!fs.existsSync(destRoot)) fail(`目标目录不存在：${destRoot}`);
  if (!fs.existsSync(manifestPath)) fail(`清单文件不存在：${manifestPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const target = manifest.target;
  if (!target) fail('清单缺少 target 字段');
  if (target.includes('/') || target.startsWith('.')) fail(`target 取值不合法：${target}`);

  const manifestDir = path.dirname(manifestPath);
  const textExt = manifest.textExt || ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.jsonc',
    '.html', '.css', '.md', '.wxml', '.wxss', '.yml', '.yaml', '.txt', '.sh', '.env', '.example'];

  const denyMatch = makeMatcher(manifest.deny);
  const targetOwnedMatch = makeMatcher(manifest.targetOwned);
  const replacements = manifest.replace || [];

  let upstreamSha = 'unknown';
  try {
    upstreamSha = git(['rev-parse', 'HEAD'], srcRoot);
  } catch {
    console.warn('WARN 无法读取上游 HEAD，继续执行');
  }
  const shortSha = upstreamSha.slice(0, 7);

  console.log(`同步 ${target} ← ${shortSha}`);

  // -- 1. collect candidates -------------------------------------------------
  const upstreamFiles = listFiles(srcRoot).filter((rel) => !denyMatch(rel));
  const emitted = new Map(); // relative path inside target dir -> source absolute path

  for (const rel of upstreamFiles) emitted.set(rel, path.join(srcRoot, rel));

  // -- 2. overlay override templates ----------------------------------------
  for (const [rel, templateRel] of Object.entries(manifest.overrides || {})) {
    const templatePath = path.resolve(manifestDir, templateRel);
    if (!fs.existsSync(templatePath)) fail(`覆盖模板不存在：${templatePath}`);
    emitted.set(rel, templatePath);
  }

  const overrideSet = new Set(Object.keys(manifest.overrides || {}));

  // -- 3. write the tree -----------------------------------------------------
  const targetDir = path.join(destRoot, target);
  const stateFile = path.join(destRoot, 'tools', 'sync', 'state.json');
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : {};
  const previous = state[target] || { emittedFiles: [] };

  // Snapshot for rollback if the gate fails.
  const backupDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'mallkit-sync-'));
  if (fs.existsSync(targetDir)) {
    fs.cpSync(targetDir, path.join(backupDir, target), { recursive: true });
  }

  const rollback = () => {
    fs.rmSync(targetDir, { recursive: true, force: true });
    const saved = path.join(backupDir, target);
    if (fs.existsSync(saved)) fs.cpSync(saved, targetDir, { recursive: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  };

  let textCount = 0;
  let binaryCount = 0;
  for (const [rel, sourcePath] of emitted) {
    const destPath = path.join(targetDir, rel);
    ensureDir(destPath);
    const buffer = fs.readFileSync(sourcePath);
    const isOverride = overrideSet.has(rel);
    if (!isProbablyBinary(buffer) && isTextFile(rel, textExt)) {
      // Override templates are authored clean, so they skip the rewrite table.
      const body = buffer.toString('utf8');
      const rewritten = isOverride ? body : applyReplacements(body, replacements, rel);
      // Normalize to LF. This repository pins eol=lf via .gitattributes, so
      // writing CRLF here would leave the working tree and the index
      // permanently out of step and make every run produce a phantom commit.
      const out = rewritten.replace(/\r\n/g, '\n');
      fs.writeFileSync(destPath, out, 'utf8');
      textCount += 1;
    } else {
      fs.writeFileSync(destPath, buffer);
      binaryCount += 1;
    }
  }

  // -- 4. delete files this sync no longer produces --------------------------
  const emittedList = [...emitted.keys()].sort();
  const emittedSet = new Set(emittedList);
  const stale = (previous.emittedFiles || []).filter((rel) => !emittedSet.has(rel));
  const protectedStale = stale.filter((rel) => targetOwnedMatch(`${target}/${rel}`) || targetOwnedMatch(rel));
  if (protectedStale.length > 0) {
    rollback();
    console.error('ERROR 待删除清单与 targetOwned 冲突，已中止：');
    for (const rel of protectedStale) console.error(`  ${target}/${rel}`);
    process.exit(2);
  }
  for (const rel of stale) {
    const abs = path.join(targetDir, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs);
      removeEmptyDirs(targetDir, path.dirname(abs));
    }
  }

  console.log(`  写入 ${textCount} 个文本文件、${binaryCount} 个二进制文件；删除 ${stale.length} 个`);

  // Verify every promised file actually landed. Without this a bug in the write
  // loop could report success while producing an empty tree, and the gate would
  // happily pass because there is nothing left to find.
  const missing = emittedList.filter((rel) => !fs.existsSync(path.join(targetDir, rel)));
  if (missing.length > 0) {
    rollback();
    console.error(`ERROR 有 ${missing.length} 个文件未能写入，已回滚：`);
    for (const rel of missing.slice(0, 20)) console.error(`  ${target}/${rel}`);
    process.exit(2);
  }

  // -- 5. privacy gate -------------------------------------------------------
  const publicPatternsPath = path.join(destRoot, 'tools', 'sync', 'forbidden.json');
  const publicPatterns = fs.existsSync(publicPatternsPath)
    ? loadPatterns(JSON.parse(fs.readFileSync(publicPatternsPath, 'utf8')).patterns, 'public')
    : [];
  let privatePatterns = [];
  if (manifest.forbiddenPrivate) {
    const privatePath = path.resolve(manifestDir, manifest.forbiddenPrivate);
    if (!fs.existsSync(privatePath)) fail(`私有禁词表不存在：${privatePath}`);
    privatePatterns = loadPatterns(JSON.parse(fs.readFileSync(privatePath, 'utf8')).patterns, 'private');
  }
  const allPatterns = [...publicPatterns, ...privatePatterns];
  if (allPatterns.length === 0) fail('禁词表为空，拒绝在无门禁的情况下同步');

  const hits = scanTree(destRoot, target, allPatterns, textExt);

  // Second pass: the whole repository, public patterns only. Catches slips in
  // our own docs and tooling. The engine itself is skipped because it documents
  // the pattern shapes it looks for.
  const skipSelf = makeMatcher([SELF_RELATIVE, 'tools/sync/forbidden.json', target, `${target}/**`]);
  const repoHits = scanTree(destRoot, '', publicPatterns, textExt, skipSelf);

  const allHits = [...hits, ...repoHits];
  if (allHits.length > 0) {
    rollback();
    const files = new Set(allHits.map((h) => h.file));
    console.error(`\nFAIL gate: ${allHits.length} hit(s) in ${files.size} file(s)`);
    for (const hit of allHits.slice(0, 60)) {
      console.error(`  ${hit.file}:${hit.line}  [${hit.category}]  ${hit.snippet}`);
    }
    if (allHits.length > 60) console.error(`  … 另有 ${allHits.length - 60} 处`);
    console.error(`\n→ upstream ${shortSha}，目标目录已回滚，未提交任何内容`);
    console.error('→ 修复方式：在上游仓改代码，或补 .github/mallkit/ 下的替换表 / deny 列表，然后重跑');
    process.exit(1);
  }

  fs.rmSync(backupDir, { recursive: true, force: true });
  console.log('  门禁通过');

  if (args.dryRun) {
    console.log('  --dry-run：不写 state、不提交');
    return;
  }

  // -- 6. persist state and commit ------------------------------------------
  // The state file records only content-derived values. A wall-clock timestamp
  // here would differ on every run, so an unchanged upstream would still
  // produce a commit and the daily schedule would churn the history.
  state[target] = {
    sha: upstreamSha,
    emittedFiles: emittedList,
  };
  ensureDir(stateFile);
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  git(['add', '--all', target, 'tools/sync/state.json'], destRoot);
  const staged = git(['diff', '--cached', '--name-only'], destRoot);
  if (!staged) {
    console.log('  无变更，跳过提交');
    return;
  }

  // The upstream commit subject may carry private wording, so it is never copied.
  git(['commit', '-m', `sync(${target}): upstream ${shortSha}`], destRoot);
  console.log(`  已提交 sync(${target}): upstream ${shortSha}`);

  if (args.noPush) {
    console.log('  --no-push：保留在本地');
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      git(['push'], destRoot);
      console.log('  已推送');
      return;
    } catch (err) {
      if (attempt === 3) {
        console.error(`ERROR 推送失败：${err.message}`);
        process.exit(2);
      }
      console.warn(`  推送失败，重新拉取后重试（${attempt}/3）`);
      try {
        git(['pull', '--rebase'], destRoot);
      } catch (pullErr) {
        console.error(`ERROR 变基失败：${pullErr.message}`);
        process.exit(2);
      }
    }
  }
}

main();
