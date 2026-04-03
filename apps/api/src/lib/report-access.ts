export type ManualReportAccessCategory = 'sales';

export interface ManualReportAccessDefinition {
  key: string;
  category: ManualReportAccessCategory;
  label: string;
  description: string;
}

export const MANUAL_REPORT_ACCESS_DEFINITIONS: ManualReportAccessDefinition[] = [
  {
    key: 'sales.yesterday',
    category: 'sales',
    label: 'Yesterday',
    description: 'GTO sales report for the previous business day.',
  },
  {
    key: 'sales.today',
    category: 'sales',
    label: 'Today',
    description: 'GTO same-day sales snapshot for the current business date.',
  },
  {
    key: 'sales.payments_yesterday',
    category: 'sales',
    label: 'Payments Yesterday',
    description: 'GTO payments summary for the previous business day.',
  },
  {
    key: 'sales.payments_today',
    category: 'sales',
    label: 'Payments Today',
    description: 'GTO payments summary for the current business day.',
  },
  {
    key: 'sales.summer',
    category: 'sales',
    label: 'Summer',
    description: 'Dedicated summer sales outlook report.',
  },
];

export function getManualReportAccessDefinition(reportKey: string): ManualReportAccessDefinition | undefined {
  return MANUAL_REPORT_ACCESS_DEFINITIONS.find((definition) => definition.key === reportKey);
}
