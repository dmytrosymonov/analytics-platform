import { syncGtoLookerOrders } from '../services/gto-looker-sync.service';
import { prisma } from '../lib/prisma';

function readArg(name: string) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main() {
  const mode = (readArg('mode') || 'manual') as 'daily' | 'manual' | 'backfill';
  const dateFrom = readArg('from');
  const dateTo = readArg('to');

  if (!dateFrom || !dateTo) {
    throw new Error('Usage: tsx src/scripts/gto-looker-sync.ts --mode=backfill --from=YYYY-MM-DD --to=YYYY-MM-DD');
  }

  const result = await syncGtoLookerOrders({
    mode,
    dateFrom,
    dateTo,
    triggeredBy: 'cli',
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
