import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { decrypt } from '../lib/encryption';
import { AirlineService } from '../lib/airline.service';

const AIRLINES_CACHE_KEY = 'gto:airlines:v3';
const UPDATE_CHUNK = 500;

function normalizeCode(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

function splitCodes(value: unknown) {
  return String(value || '')
    .split('|')
    .map((item) => normalizeCode(item))
    .filter(Boolean);
}

function joinMappedNames(codes: string[], codeToName: Record<string, string>) {
  const names = codes.map((code) => String(codeToName[code] || '').trim() || code);
  return names.join(' | ') || null;
}

function chunk<T>(rows: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

async function getGtoConfig() {
  const source = await prisma.dataSource.findUnique({
    where: { type: 'gto' },
    include: { credentials: true, settings: true },
  });

  if (!source?.credentials) {
    throw new Error('GTO credentials are not configured in DataSource');
  }

  const credentials = JSON.parse(decrypt(source.credentials.encryptedPayload)) as {
    api_key?: string;
  };

  if (!credentials.api_key) {
    throw new Error('GTO api_key is missing');
  }

  const settings = Object.fromEntries((source.settings || []).map((row) => [row.key, row.value]));
  const v3BaseUrl = (settings.gto_v3_base_url || settings['gto.v3_base_url'] || 'https://api.gto.ua/api/v3').replace(/\/$/, '');

  return {
    apiKey: credentials.api_key,
    v3BaseUrl,
  };
}

async function main() {
  const { apiKey, v3BaseUrl } = await getGtoConfig();
  await redis.del(AIRLINES_CACHE_KEY).catch(() => undefined);
  const dictionary = await AirlineService.getAirlineDictionary(apiKey, v3BaseUrl);

  const [orderRows, lineRows, bridgeRows] = await Promise.all([
    prisma.reportingGtoOrder.findMany({
      where: { hasAirticket: true, airlineCodes: { not: null } },
      select: { orderId: true, airlineCodes: true },
    }),
    prisma.reportingGtoOrderLine.findMany({
      where: { productGroup: 'airticket', airlineCodes: { not: null } },
      select: { lineId: true, airlineCodes: true },
    }),
    prisma.reportingGtoOrderLineAirline.findMany({
      select: { lineId: true, airlineCode: true },
    }),
  ]);

  let updatedOrders = 0;
  for (const rows of chunk(orderRows, UPDATE_CHUNK)) {
    await prisma.$transaction(rows.map((row) =>
      prisma.reportingGtoOrder.update({
        where: { orderId: row.orderId },
        data: {
          airlineNames: joinMappedNames(splitCodes(row.airlineCodes), dictionary.codeToName),
          syncedAt: new Date(),
        },
      }),
    ));
    updatedOrders += rows.length;
  }

  let updatedLines = 0;
  for (const rows of chunk(lineRows, UPDATE_CHUNK)) {
    await prisma.$transaction(rows.map((row) =>
      prisma.reportingGtoOrderLine.update({
        where: { lineId: row.lineId },
        data: {
          airlineNames: joinMappedNames(splitCodes(row.airlineCodes), dictionary.codeToName),
          syncedAt: new Date(),
        },
      }),
    ));
    updatedLines += rows.length;
  }

  let updatedBridge = 0;
  for (const rows of chunk(bridgeRows, UPDATE_CHUNK)) {
    await prisma.$transaction(rows.map((row) =>
      prisma.reportingGtoOrderLineAirline.update({
        where: {
          lineId_airlineCode: {
            lineId: row.lineId,
            airlineCode: row.airlineCode,
          },
        },
        data: {
          airlineName: String(dictionary.codeToName[normalizeCode(row.airlineCode)] || '').trim() || normalizeCode(row.airlineCode),
          syncedAt: new Date(),
        },
      }),
    ));
    updatedBridge += rows.length;
  }

  console.log(JSON.stringify({
    refreshedAt: new Date().toISOString(),
    airlineDictionaryEntries: Object.keys(dictionary.codeToName).length,
    updatedOrders,
    updatedLines,
    updatedBridge,
    duplicateCodeWarnings: dictionary.duplicateCodeWarnings.length,
    duplicateNameWarnings: dictionary.duplicateNameWarnings.length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
