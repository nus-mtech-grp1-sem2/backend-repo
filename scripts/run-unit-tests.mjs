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
  source('inventory', 'src', 'inventory.test.ts'),
  source('inventory', 'src', 'holds.test.ts'),
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

const coverageArgs =
  process.env.COVERAGE === '1'
    ? [
        '--experimental-test-coverage',
        '--test-coverage-exclude=services/**/*.test.ts',
        '--test-coverage-exclude=services/**/test-helpers.ts',
        '--test-coverage-exclude=services/test-support/**',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=lcov',
        '--test-reporter-destination=coverage/node.lcov',
      ]
    : [];

let exitCode = await run(process.execPath, [
  ...coverageArgs,
  '--import',
  'tsx',
  '--experimental-test-module-mocks',
  '--test',
  ...nodeTestFiles,
]);

if (exitCode === 0) {
  const notificationArgs = [
    path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
  ];
  if (process.env.COVERAGE === '1') {
    notificationArgs.push(
      '--coverage.enabled',
      '--coverage.provider=v8',
      '--coverage.reporter=lcov',
      '--coverage.reportsDirectory=../../coverage/notification',
    );
  }
  exitCode = await run(process.execPath, notificationArgs, { cwd: source('notification') });
}

process.exitCode = exitCode;
