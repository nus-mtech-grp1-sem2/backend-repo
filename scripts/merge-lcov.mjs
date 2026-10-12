import { readFile, writeFile } from 'node:fs/promises';

const nodeReport = 'coverage/node.lcov';
const rootReport = 'coverage/lcov.info';
const notificationReport = 'coverage/notification/lcov.info';
const [nodeCoverage, notification] = await Promise.all([
  readFile(nodeReport, 'utf8'),
  readFile(notificationReport, 'utf8'),
]);

const notificationFromRepoRoot = notification.replace(
  /^SF:(?!services\/notification\/)(.+)$/gm,
  'SF:services/notification/$1',
);

const recordsBySource = new Map();
for (const record of `${nodeCoverage}\n${notificationFromRepoRoot}`
  .split(/^end_of_record\s*$/m)
  .map((value) => value.trim())
  .filter(Boolean)) {
  const source = record.split('\n').find((line) => line.startsWith('SF:'));
  if (!source) throw new Error('LCOV record has no SF source entry');
  const previous = recordsBySource.get(source);
  if (previous && previous !== record) {
    throw new Error(`Conflicting LCOV records for ${source}`);
  }
  recordsBySource.set(source, record);
}

await writeFile(
  rootReport,
  `${[...recordsBySource.values()].join('\nend_of_record\n')}\nend_of_record\n`,
);
