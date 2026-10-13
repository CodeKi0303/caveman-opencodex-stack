#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

// Keep this entry point dependency-free so a fresh clone can guide its own setup.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Node.js 22.13 이상이 필요합니다. Node.js LTS를 설치한 뒤 다시 실행하세요.');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const helpOnly = args.includes('--help') || args.includes('-h');
const dependenciesPresent = ['@iarna/toml', '@modelcontextprotocol/sdk/client/index.js'].every(name => {
  try { require.resolve(name); return true; } catch { return false; }
});
if (!dependenciesPresent) {
  if (helpOnly) {
    console.log('Caveman 관리 메뉴: Manage.cmd (Windows), ./Manage.sh (Linux/WSL), npm run manage');
    console.log('선택 옵션: --codex-home <경로>, --system 또는 --user, --status (읽기 전용)');
    console.log('첫 대화형 실행에서 필요한 라이브러리 설치 여부를 묻습니다. Node.js 22.13+ 및 npm이 필요합니다.');
    process.exit(0);
  }
  if (!process.stdin.isTTY || args.includes('--status')) {
    console.error('필요한 라이브러리가 없습니다. 저장소에서 npm ci --ignore-scripts를 실행하세요.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try { answer = await rl.question('처음 실행에 필요한 라이브러리를 설치할까요? [y/N] '); }
  finally { rl.close(); }
  if (!/^(y|yes)$/i.test(answer.trim())) process.exit(0);
  // The Windows shell command is fixed: no user input or credentials are interpolated.
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts --no-audit --no-fund'], { cwd: repo, stdio: 'inherit' })
    : spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: repo, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('라이브러리를 설치하지 못했습니다. Node.js/npm 설치 및 인터넷 연결을 확인하세요.');
    process.exit(result.status || 1);
  }
}
const child = spawnSync(process.execPath, [fileURLToPath(new URL('./manage.mjs', import.meta.url)), ...args], { cwd: repo, stdio: 'inherit' });
if (child.error) console.error('관리 메뉴를 시작하지 못했습니다. 실행 파일 경로를 확인하세요.');
process.exit(child.status ?? 1);
