import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
process.env.DB_NAME = process.env.DB_NAME_TICKETING ?? 'ticketing';

const apply = process.argv.includes('--apply');
const orderIds = process.argv
  .filter((argument) => /^\d+$/.test(argument))
  .map(Number)
  .filter((orderId) => Number.isSafeInteger(orderId) && orderId > 0);

if (!apply || orderIds.length === 0) {
  console.error('Usage: npm exec cross-env NODE_ENV=test node --import tsx scripts/backfill-unissued-tickets.mjs -- --apply ORDER_ID...');
  process.exitCode = 1;
} else {
  const { closeTicketDatabase, issueTicketsForOrder } = await import('../services/ticket/src/index.ts');
  try {
    for (const orderId of orderIds) {
      const result = await issueTicketsForOrder(orderId);
      console.log(JSON.stringify({ orderId, ...result }));
    }
  } finally {
    await closeTicketDatabase();
  }
}
