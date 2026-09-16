#!/usr/bin/env node
/**
 * Self-test for the sync engine and the public pattern set.
 *
 * Builds a throwaway upstream repository and a throwaway destination, runs the
 * real sync.mjs against them, and asserts on glob handling, replacement order,
 * override precedence, stale deletion, rollback, and every forbidden pattern.
 *
 * Run: node tools/sync/selftest.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(here, 'sync.mjs');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runSync(manifest, src, dest, extra = []) {
  try {
    const stdout = execFileSync(process.execPath,
      [SYNC, '--manifest', manifest, '--src', src, '--dest', dest, ...extra],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

// --------------------------------------------------------------- fixtures

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mallkit-selftest-'));
const upstream = path.join(tmp, 'upstream');
const dest = path.join(tmp, 'dest');

fs.mkdirSync(upstream, { recursive: true });
fs.mkdirSync(dest, { recursive: true });

// A destination repository with the real engine and pattern file in place.
fs.mkdirSync(path.join(dest, 'tools', 'sync'), { recursive: true });
fs.copyFileSync(SYNC, path.join(dest, 'tools', 'sync', 'sync.mjs'));
fs.copyFileSync(path.join(here, 'forbidden.json'), path.join(dest, 'tools', 'sync', 'forbidden.json'));
fs.copyFileSync(path.join(here, '..', '..', '.gitattributes'), path.join(dest, '.gitattributes'));
write(dest, 'README.md', '# destination\n');
write(dest, 'docs/guide.md', 'owned by destination\n');
git(['init', '-q', '-b', 'main'], dest);
git(['config', 'user.email', 'test@example.com'], dest);
git(['config', 'user.name', 'test'], dest);
git(['add', '-A'], dest);
git(['commit', '-q', '-m', 'init'], dest);

// Upstream content exercising each engine feature.
write(upstream, 'app.js', "// Brandy Farm admin\nconst env = 'cloudbase-abcdefgh12345678';\n");
write(upstream, 'lib/util.js', 'export const label = "Brandy Farm";\r\nexport const n = 1;\r\n');
write(upstream, 'config.json', '{"envId":"cloudbase-abcdefgh12345678"}\n');
write(upstream, 'keep/nested/deep.txt', 'plain text\n');
write(upstream, 'docs/private-notes.md', 'my phone is 13912345678\n');
write(upstream, 'notes/scratch.md', 'scratch\n');
// Built at runtime so this file never contains a literal that a scanner would
// flag. The fixture only needs the shape, not a plausible value.
const fakeSecretId = `AKID${'z'.repeat(32)}`;
write(upstream, 'secret.bak', `${fakeSecretId}\n`);
write(upstream, 'run.bat', `set KEY=${fakeSecretId}\n`);
write(upstream, 'stale-later.js', 'const a = 1;\n');
fs.writeFileSync(path.join(upstream, 'logo.png'),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x00, 0xff]));
git(['init', '-q', '-b', 'main'], upstream);
git(['config', 'user.email', 'test@example.com'], upstream);
git(['config', 'user.name', 'test'], upstream);
git(['add', '-A'], upstream);
git(['commit', '-q', '-m', 'upstream init'], upstream);

// Manifest plus its private pattern file and an override template.
const rules = path.join(upstream, '.github', 'mallkit');
fs.mkdirSync(path.join(rules, 'overrides'), { recursive: true });
write(rules, 'overrides/config.json', '{"envId":"your-env-id"}\n');
write(rules, 'forbidden.private.json', JSON.stringify({
  patterns: [{ category: 'brand', pattern: 'Brandy\\s*Farm' }],
}, null, 2));
write(rules, 'manifest.json', JSON.stringify({
  target: 'admin',
  deny: ['docs/**', 'notes/**', '*.bak', '*.bat', '.github/**'],
  replace: [
    { from: 'Brandy Farm', to: 'Mallkit' },
    { from: 'cloudbase-abcdefgh12345678', to: 'your-env-id' },
  ],
  overrides: { 'config.json': 'overrides/config.json' },
  targetOwned: ['README.md', 'docs/**', 'tools/**'],
  forbiddenPrivate: 'forbidden.private.json',
  textExt: ['.js', '.json', '.txt', '.md'],
}, null, 2));

const manifest = path.join(rules, 'manifest.json');

// ------------------------------------------------------------- run 1: clean

const run1 = runSync(manifest, upstream, dest, ['--no-push']);
check('run1 退出码为 0', run1.code === 0, run1.out.slice(0, 400));
if (run1.code !== 0) {
  console.error('run1 失败，后续断言无意义。引擎输出：');
  console.error(run1.out);
  process.exit(1);
}

const adminDir = path.join(dest, 'admin');
check('deny 排除 docs/', !fs.existsSync(path.join(adminDir, 'docs')));
check('deny 排除 notes/', !fs.existsSync(path.join(adminDir, 'notes')));
check('deny 排除 *.bak', !fs.existsSync(path.join(adminDir, 'secret.bak')));
check('deny 排除 *.bat', !fs.existsSync(path.join(adminDir, 'run.bat')));
check('deny 排除 .github/', !fs.existsSync(path.join(adminDir, '.github')));
check('保留嵌套目录', fs.existsSync(path.join(adminDir, 'keep', 'nested', 'deep.txt')));

const appBody = fs.readFileSync(path.join(adminDir, 'app.js'), 'utf8');
check('替换品牌名', appBody.includes('Mallkit') && !appBody.includes('Brandy'));
check('替换环境 id', appBody.includes('your-env-id'));

const utilBody = fs.readFileSync(path.join(adminDir, 'lib', 'util.js'), 'utf8');
check('CRLF 规范化为 LF', !utilBody.includes('\r\n') && utilBody.includes('\n'), JSON.stringify(utilBody));

const cfgBody = fs.readFileSync(path.join(adminDir, 'config.json'), 'utf8');
check('override 覆盖上游文件', cfgBody.trim() === '{"envId":"your-env-id"}');

const pngOut = fs.readFileSync(path.join(adminDir, 'logo.png'));
check('二进制按字节复制', pngOut.length === 13 && pngOut[0] === 0x89);

const state = JSON.parse(fs.readFileSync(path.join(dest, 'tools', 'sync', 'state.json'), 'utf8'));
check('state 记录 sha', typeof state.admin.sha === 'string' && state.admin.sha.length === 40);
check('state 记录文件清单', state.admin.emittedFiles.includes('app.js'));

const log1 = git(['log', '--oneline', '-1'], dest);
check('提交信息只含 sha', /^[0-9a-f]+ sync\(admin\): upstream [0-9a-f]{7}$/.test(log1), log1);

// ------------------------------------------------------ run 2: idempotence

const run2 = runSync(manifest, upstream, dest, ['--no-push']);
check('run2 退出码为 0', run2.code === 0, run2.out.slice(0, 300));
check('run2 幂等无提交', run2.out.includes('无变更'), run2.out.slice(0, 300));

// --------------------------------------------------- run 3: stale deletion

fs.rmSync(path.join(upstream, 'stale-later.js'));
git(['add', '-A'], upstream);
git(['commit', '-q', '-m', 'drop file'], upstream);
const run3 = runSync(manifest, upstream, dest, ['--no-push']);
check('run3 退出码为 0', run3.code === 0, run3.out.slice(0, 300));
check('上游删除会传播', !fs.existsSync(path.join(adminDir, 'stale-later.js')));
check('destination 自有文件未被删', fs.existsSync(path.join(dest, 'docs', 'guide.md')));
check('destination README 未被删', fs.existsSync(path.join(dest, 'README.md')));

// ------------------------------------------------- run 4: gate blocks + rollback

const goodAppBody = fs.readFileSync(path.join(adminDir, 'app.js'), 'utf8');
write(upstream, 'leak.js', 'const owner = "Brandy Farm";\nconst tel = "13912345678";\n');
git(['add', '-A'], upstream);
git(['commit', '-q', '-m', 'add leak'], upstream);

const run4 = runSync(manifest, upstream, dest, ['--no-push']);
check('run4 门禁拦截', run4.code === 1, `code=${run4.code}`);
check('run4 报告命中', run4.out.includes('FAIL gate'), run4.out.slice(0, 300));
check('run4 命中手机号类别', run4.out.includes('cn-mobile'), run4.out.slice(0, 600));
check('run4 掩码命中片段', !run4.out.includes('13912345678'), run4.out.slice(0, 600));
check('run4 回滚未留下泄露文件', !fs.existsSync(path.join(adminDir, 'leak.js')));
check('run4 回滚保留原内容',
  fs.readFileSync(path.join(adminDir, 'app.js'), 'utf8') === goodAppBody);
const log4 = git(['log', '--oneline'], dest).split('\n').length;
check('run4 未产生提交', log4 === 3, `commits=${log4}`);

fs.rmSync(path.join(upstream, 'leak.js'));
git(['add', '-A'], upstream);
git(['commit', '-q', '-m', 'remove leak'], upstream);
const run5 = runSync(manifest, upstream, dest, ['--no-push']);
check('移除泄露后恢复通过', run5.code === 0, run5.out.slice(0, 300));

// ------------------------------------- run 6: tooling is exempt from the scan

// The self-test carries fixtures that look exactly like secrets, on purpose.
// If the repository-wide second pass scanned the sync tooling, every real run
// would be blocked by this file. Copy it in and prove the run still passes.
fs.copyFileSync(path.join(here, 'selftest.mjs'), path.join(dest, 'tools', 'sync', 'selftest.mjs'));
const run6 = runSync(manifest, upstream, dest, ['--no-push']);
check('同步工具自身豁免全仓扫描', run6.code === 0, run6.out.slice(0, 500));

// A file outside the tooling with the same content must still be caught, so
// the exemption is scoped and not a blanket hole.
fs.writeFileSync(path.join(dest, 'docs', 'leaky.md'), 'tel 13912345678\n');
const run7 = runSync(manifest, upstream, dest, ['--no-push']);
check('豁免不外溢到其他目录', run7.code === 1, `code=${run7.code}`);
fs.rmSync(path.join(dest, 'docs', 'leaky.md'));

// --------------------------------------------- pattern-by-pattern coverage

const patterns = JSON.parse(fs.readFileSync(path.join(here, 'forbidden.json'), 'utf8')).patterns;
const byCategory = Object.fromEntries(patterns.map((p) => [p.category, p]));

function hits(category, sample) {
  const entry = byCategory[category];
  if (!entry) return false;
  const re = new RegExp(entry.pattern, entry.flags || 'gi');
  const match = re.exec(sample);
  if (!match) return false;
  const allow = (entry.allow || []).map((a) => new RegExp(a, 'i'));
  return !allow.some((a) => a.test(match[0]));
}

const cases = [
  ['cn-mobile', '联系 13912345678 下单', true],
  ['cn-mobile', '示例 13800138000 占位', false],
  ['cn-mobile', '订单号 O1782466350095243', false],
  ['personal-email', 'mail: someone@gmail.com', true],
  ['personal-email', 'mail: support@example.com', false],
  ['cloudbase-env-id', `env cloudbase-${'a1b2c3d4'.repeat(2)} here`, true],
  ['cloudbase-env-id', 'env cloudbase-your-env-id here', false],
  ['wechat-appid', `appid wx${'0123abcd'.repeat(2)}`, true],
  ['wechat-appid', 'appid touristappid', false],
  ['tencent-secret-id', `id=AKID${'E'.repeat(32)}`, true],
  ['tencent-app-id', 'bucket 636c-env-1300000001', true],
  ['private-key-block', `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEowIBAAKCAQEA'.repeat(4)}`, true],
  // A bare header is a format constant, not a secret. Shipped code reformats a
  // PEM read from the environment and legitimately mentions it.
  ['private-key-block', "'-----BEGIN PRIVATE KEY-----'", false],
  ['wechat-appid', 'provider wx9ad912bf20548d92', false],
  ['jwt', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoiYWdlbnQifQ.sig', true],
  ['wecom-webhook', `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${'a'.repeat(8)}-0000`, true],
  ['uuid-token', `key ${'a'.repeat(8)}-1111-2222-3333-${'b'.repeat(12)}`, true],
  ['uuid-token', 'key 00000000-0000-0000-0000-000000000000', false],
  ['cloudbase-host', 'https://svc-000000-0-1300000001.sh.run.tcloudbase.com/', true],
  ['cloudbase-storage-host', '636c-env-1300000001.tcb.qcloud.la', true],
  ['edgeone-project-id', `project makers-${'x'.repeat(12)}`, true],
  ['wechat-merchant-id', 'mch_id: 1000000001', true],
  ['wechat-cert-serial', `serial_no = ${'AB'.repeat(20)}`, true],
  ['signed-cos-url', 'https://x.com/a.png?sign=q-sign-time%3D1234%26abcdefgh', true],
  ['windows-user-path', 'C:\\Users\\someone\\Desktop\\apiclient_cert.pem', true],
  ['windows-user-path', 'C:\\Users\\your-name\\cert.pem', false],
  ['github-token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', true],
  ['generic-api-secret', 'api_key: "sk-abcdefghijklmnopqrstuvwxyz012345"', true],
  ['local-project-path', 'cd e:\\10_项目\\app', true],
  ['generic-api-secret', 'api_key: process.env.AI_GATEWAY_API_KEY', false],
];

for (const [category, sample, expected] of cases) {
  check(`模式 ${category} ${expected ? '命中' : '豁免'}：${sample.slice(0, 32)}`,
    hits(category, sample) === expected);
}

check('每个模式都有测试用例',
  patterns.every((p) => cases.some(([c]) => c === p.category)),
  patterns.filter((p) => !cases.some(([c]) => c === p.category)).map((p) => p.category).join(', '));

// ------------------------------------------------------------------ report

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('全部通过');
