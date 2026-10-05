import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptsDirectory);

function source(...parts) {
  return path.join(repositoryRoot, 'services', ...parts);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const nodeTestFiles = [
  source('event', 'src', 'index.test.ts'),
  source('event', 'src', 'team-membership-access.test.ts'),
  source('inventory', 'src', 'index.test.ts'),
  source('queue', 'src', 'index.test.ts'),
  source('queue', 'src', 'purchase-window.test.ts'),
  source('order', 'src', 'index.test.ts'),
  source('order', 'src', 'inventory-selection.test.ts'),
  source('order', 'src', 'purchase-window.test.ts'),
  source('order', 'src', 'reservation.test.ts'),
  source('order', 'src', 'payment-queue.test.ts'),
  source('ticket', 'src', 'index.test.ts'),
  source('ticket', 'src', 'confirmation-status.test.ts'),
  source('ticket', 'src', 'issuance-delay.test.ts'),
];

let exitCode = await run(process.execPath, [
  '--import',
  'tsx',
  '--experimental-test-module-mocks',
  '--test',
  ...nodeTestFiles,
]);

if (exitCode === 0) {
  exitCode = await run(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run'],
    { cwd: source('notification') },
  );
}

process.exitCode = exitCode;
