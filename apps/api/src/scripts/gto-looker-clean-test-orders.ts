import { prisma } from '../lib/prisma';
import { getIgnoredLookerTestAgentNames } from '../services/gto-looker-test-agents';

async function main() {
  const blacklist = getIgnoredLookerTestAgentNames();
  const orders = await (prisma as any).reportingGtoOrder.findMany({
    where: {
      OR: [
        { agentName: { in: blacklist, mode: 'insensitive' } },
        { companyName: { in: blacklist, mode: 'insensitive' } },
      ],
    },
    select: {
      orderId: true,
      agentName: true,
      companyName: true,
    },
  });

  const orderIds = orders.map((row: any) => row.orderId);
  let deletedLineRows = 0;
  let deletedOrderRows = 0;

  if (orderIds.length > 0) {
    deletedLineRows = await (prisma as any).reportingGtoOrderLine.deleteMany({
      where: { orderId: { in: orderIds } },
    }).then((result: any) => result.count);

    deletedOrderRows = await (prisma as any).reportingGtoOrder.deleteMany({
      where: { orderId: { in: orderIds } },
    }).then((result: any) => result.count);
  }

  console.log(JSON.stringify({
    matchedOrders: orders.length,
    deletedOrderRows,
    deletedLineRows,
    sample: orders.slice(0, 10).map((row: any) => ({
      orderId: String(row.orderId),
      agentName: row.agentName,
      companyName: row.companyName,
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
