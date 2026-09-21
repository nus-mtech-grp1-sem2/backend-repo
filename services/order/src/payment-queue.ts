import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { setTimeout as delay } from 'node:timers/promises';

export interface PaymentRequest { readonly orderId: number; readonly customerSub: string }
export interface PaymentResult { readonly status: number; readonly body: unknown }

export function parsePaymentRequest(body: string | undefined): PaymentRequest {
  const value: unknown = JSON.parse(body ?? 'null');
  if (!value || typeof value !== 'object') throw new Error('invalid_payment_message');
  const data = value as Record<string, unknown>;
  if (data['type'] !== 'PaymentRequested' || data['version'] !== 1 ||
      !Number.isSafeInteger(data['orderId']) || Number(data['orderId']) <= 0 ||
      typeof data['customerSub'] !== 'string' || !data['customerSub'] || data['customerSub'].length > 255) {
    throw new Error('invalid_payment_message');
  }
  return { orderId: Number(data['orderId']), customerSub: data['customerSub'] };
}

export async function enqueuePayment(sqs: Pick<SQSClient, 'send'>, queueUrl: string, request: PaymentRequest): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    DelaySeconds: 7,
    MessageBody: JSON.stringify({ type: 'PaymentRequested', version: 1, orderId: request.orderId, customerSub: request.customerSub }),
  }));
}

/** One message per receive keeps the 60-second visibility lease available for the whole transaction. */
export async function consumePayments(
  sqs: Pick<SQSClient, 'send'>,
  queueUrl: string,
  process: (request: PaymentRequest) => Promise<PaymentResult>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20, VisibilityTimeout: 60,
      }), { abortSignal: signal });
      for (const message of result.Messages ?? []) {
        if (signal.aborted) break;
        if (!message.ReceiptHandle) continue;
        try {
          const request = parsePaymentRequest(message.Body);
          const result = await process(request);
          // Transient failures (including publishing OrderPaid after commit) must be redelivered.
          if (result.status >= 500) throw new Error('retryable_payment_failure');
          if (![200, 402, 403, 404, 409].includes(result.status)) throw new Error('unexpected_payment_result');
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
          console.info('payment request handled', { orderId: request.orderId, status: result.status });
        } catch {
          // Do not log payloads. Invalid/transiently failing messages eventually move to the DLQ.
          console.error('payment request will retry or enter DLQ', { messageId: message.MessageId });
        }
      }
    } catch {
      if (signal.aborted) break;
      console.error('payment queue receive failed');
      await delay(5_000, undefined, { signal }).catch(() => undefined);
    }
  }
}
