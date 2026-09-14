type GtoPrivateOrderListRow = Record<string, unknown>;

const ORDER_LIST_COLUMNS = [
  'order_id',
  'date_start',
  'date_end',
  'status',
  'status_name',
  'created_at',
  'updated_at',
  'company_id',
  'company_name',
  'structure_id',
  'structure_name',
  'agent_reference',
] as const;

function parseSemicolonLine(line: string) {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ';' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function parseSemicolonRows(body: string): GtoPrivateOrderListRow[] {
  const lines = body
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) return [];

  const rows = lines.map(parseSemicolonLine);
  const hasHeader = rows[0]?.[0]?.trim().toLowerCase() === 'order_id';
  const columns = hasHeader
    ? rows.shift()!.map((column) => column.trim().toLowerCase())
    : [...ORDER_LIST_COLUMNS];

  const parsed = rows
    .map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index]?.trim() ?? ''])))
    .filter((row) => Number.isFinite(Number(row.order_id)) && Number(row.order_id) > 0);

  if (parsed.length === 0) {
    throw new Error('GTO orders_list returned non-empty text with no recognizable order rows');
  }

  return parsed;
}

/**
 * GTO private API historically returned JSON from /orders_list. It now also
 * returns semicolon-delimited rows, while keeping the endpoint and status 200.
 */
export function parseGtoPrivateOrdersList(body: unknown): GtoPrivateOrderListRow[] {
  if (Array.isArray(body)) return body as GtoPrivateOrderListRow[];
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: GtoPrivateOrderListRow[] }).data;
  }

  if (typeof body !== 'string') {
    throw new Error(`GTO orders_list returned unsupported response type: ${typeof body}`);
  }

  const text = body.trim();
  if (!text) return [];

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return parseGtoPrivateOrdersList(JSON.parse(text));
    } catch (error: any) {
      throw new Error(`GTO orders_list returned invalid JSON text: ${error?.message || String(error)}`);
    }
  }

  return parseSemicolonRows(text);
}
