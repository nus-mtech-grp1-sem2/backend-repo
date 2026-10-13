import { setTimeout as delay } from 'node:timers/promises';

import { consumePayments } from '../services/order/src/payment-queue.ts';

const messageCount = Number(process.env.PAYMENT_DRAIN_MESSAGES ?? 40);
const processingDelayMs = Number(process.env.PAYMENT_PROCESSING_DELAY_MS ?? 25);
const maximumDurationMs = Number(process.env.PAYMENT_DRAIN_MAX_MS ?? 5_000);
if (!Number.isSafeInteger(messageCount) || messageCount < 1 || messageCount > 1_000 ||
    !Number.isSafeInteger(processingDelayMs) || processingDelayMs < 0 || processingDelayMs > 5_000) {
  throw new Error('invalid payment-drain parameters');
}

const queue = Array.from({ length: messageCount }, (_, index) => ({
  MessageId: `payment-${index + 1}`,
  ReceiptHandle: `receipt-${index + 1}`,
  Body: JSON.stringify({ type: 'PaymentRequested', version: 1, orderId: index + 1, customerSub: `buyer-${index + 1}` }),
}));
let inFlight;
let processed = 0;
const controller = new AbortController();
const sqs = {
  async send(command) {
    if (command.constructor.name === 'ReceiveMessageCommand') {
      if (!inFlight) inFlight = queue[0];
      return { Messages: inFlight ? [inFlight] : [] };
    }
    if (command.constructor.name === 'DeleteMessageCommand') {
      if (queue[0]?.ReceiptHandle === command.input.ReceiptHandle) queue.shift();
      inFlight = undefined;
      if (queue.length === 0) controller.abort();
      return {};
    }
    throw new Error(`unexpected command: ${command.constructor.name}`);
  },
};

const startedAt = performance.now();
let timeout;
try {
  await Promise.race([
    consumePayments(sqs, 'memory://payments', async () => {
    await delay(processingDelayMs);
    processed += 1;
    return { status: 200, body: {} };
    }, controller.signal),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('payment drain exceeded maximum duration')), maximumDurationMs);
      timeout.unref();
    }),
  ]);
} finally {
  clearTimeout(timeout);
}
const durationMs = Math.round(performance.now() - startedAt);
if (processed !== messageCount || queue.length !== 0) {
  throw new Error(`payment drain incomplete: processed=${processed}, remaining=${queue.length}`);
}
const result = {
  messages: messageCount,
  processingDelayMs,
  durationMs,
  throughputPerSecond: Number((messageCount / (durationMs / 1_000)).toFixed(2)),
  workerConcurrency: 1,
};
console.log(JSON.stringify(result, null, 2));
if (process.env.PAYMENT_DRAIN_RESULT_FILE) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.PAYMENT_DRAIN_RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);
}
