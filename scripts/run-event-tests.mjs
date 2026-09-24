import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptsDirectory);
const eventSource = path.join(repositoryRoot, 'services', 'event', 'src');
const testFiles = (await readdir(eventSource))
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => path.join(eventSource, file));

async function run(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

let testExitCode = 0;
try {
  if (testFiles.length === 0) {
    console.log('No event-service unit tests found.');
  } else {
    // The organiser endpoint tests replace the database and Cognito with fakes via module mocking.
    testExitCode = await run(process.execPath, [
      '--import',
      'tsx',
      '--experimental-test-module-mocks',
      '--test',
      ...testFiles,
    ]);
  }
} finally {
  const cleanupExitCode = await run(process.execPath, [
    path.join(scriptsDirectory, 'cleanup-test-events.mjs'),
    '--apply',
    '--include-related',
  ]);
  process.exitCode = testExitCode || cleanupExitCode;
}
