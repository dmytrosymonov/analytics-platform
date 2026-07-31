import { prisma } from '../lib/prisma';
import {
  getGtoAgentSegmentHistoryStart,
  refreshGtoAgentSegments,
  segmentDateRangeDays,
} from '../services/gto-agent-segmentation.service';

function readArg(name: string) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readFlag(name: string) {
  return process.argv.includes(`--${name}`) || readArg(name) === 'true' || readArg(name) === '1';
}

async function main() {
  const snapshotDate = readArg('snapshot-date');
  const from = readArg('from');
  const to = readArg('to');
  const dryRun = readFlag('dry-run');

  if (snapshotDate && (from || to)) {
    throw new Error('Use either --snapshot-date or --from/--to');
  }
  if ((from && !to) || (!from && to)) {
    throw new Error('Use both --from and --to');
  }
  if (!snapshotDate && !from && !to) {
    throw new Error(`Usage: refresh:gto-agent-segments -- --snapshot-date=YYYY-MM-DD [--dry-run] or --from=${getGtoAgentSegmentHistoryStart()} --to=YYYY-MM-DD [--dry-run]`);
  }
  if (from && to && segmentDateRangeDays(from, to) > 800) {
    throw new Error('Snapshot range exceeds the 800-day safety limit');
  }

  const result = await refreshGtoAgentSegments({
    snapshotDate,
    from,
    to,
    dryRun,
    processDirty: !dryRun,
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
    process.exit(process.exitCode || 0);
  });
