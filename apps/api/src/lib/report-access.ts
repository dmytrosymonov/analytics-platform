export type ManualReportAccessCategory = 'sales' | 'comments' | 'redmine' | 'youtrack';

export interface ManualReportAccessDefinition {
  key: string;
  category: ManualReportAccessCategory;
  sourceType: string;
  label: string;
  description: string;
}

export const MANUAL_REPORT_ACCESS_DEFINITIONS: ManualReportAccessDefinition[] = [
  {
    key: 'sales.yesterday',
    category: 'sales',
    sourceType: 'gto',
    label: 'Yesterday',
    description: 'GTO sales report for the previous business day.',
  },
  {
    key: 'sales.today',
    category: 'sales',
    sourceType: 'gto',
    label: 'Today',
    description: 'GTO same-day sales snapshot for the current business date.',
  },
  {
    key: 'sales.agents',
    category: 'sales',
    sourceType: 'gto',
    label: 'Agents activity',
    description: 'GTO agent activity reports for preset and custom Telegram periods.',
  },
  {
    key: 'sales.payments_yesterday',
    category: 'sales',
    sourceType: 'gto',
    label: 'Payments Yesterday',
    description: 'GTO payments summary for the previous business day.',
  },
  {
    key: 'sales.payments_today',
    category: 'sales',
    sourceType: 'gto',
    label: 'Payments Today',
    description: 'GTO payments summary for the current business day.',
  },
  {
    key: 'sales.summer',
    category: 'sales',
    sourceType: 'gto',
    label: 'Summer',
    description: 'Dedicated summer sales outlook report.',
  },
  {
    key: 'redmine.hours.24',
    category: 'redmine',
    sourceType: 'redmine',
    label: '24 hours',
    description: 'Redmine activity report for the last 24 hours.',
  },
  {
    key: 'redmine.hours.48',
    category: 'redmine',
    sourceType: 'redmine',
    label: '48 hours',
    description: 'Redmine activity report for the last 48 hours.',
  },
  {
    key: 'redmine.hours.168',
    category: 'redmine',
    sourceType: 'redmine',
    label: '7 days',
    description: 'Redmine activity report for the last 7 days.',
  },
];

export interface ScheduleAccessLike {
  id: string;
  name: string;
  source: {
    type: string;
    name: string;
  };
}

export function makeScheduleRunReportKey(scheduleId: string): string {
  return `schedule.run.${scheduleId}`;
}

export function makeScheduleHoursReportKey(scheduleId: string, hours: number): string {
  return `schedule.hours.${scheduleId}.${hours}`;
}

export function listManualReportAccessDefinitions(schedules: ScheduleAccessLike[]): ManualReportAccessDefinition[] {
  const dynamic: ManualReportAccessDefinition[] = [];

  for (const schedule of schedules) {
    const sourceType = String(schedule.source.type);
    if (sourceType === 'gto_comments' || sourceType === 'youtrack' || sourceType === 'youtrack_progress') {
      dynamic.push({
        key: makeScheduleRunReportKey(schedule.id),
        category: sourceType === 'gto_comments' ? 'comments' : 'youtrack',
        sourceType,
        label: schedule.name,
        description: `Manual generation of ${schedule.name}.`,
      });
    }

    if (sourceType === 'youtrack_progress') {
      for (const hours of [24, 48, 168]) {
        const label = hours === 168 ? '7 days' : `${hours}h`;
        dynamic.push({
          key: makeScheduleHoursReportKey(schedule.id, hours),
          category: 'youtrack',
          sourceType,
          label: `${schedule.name} · ${label}`,
          description: `Manual YouTrack Daily Progress report for the last ${hours} hours.`,
        });
      }
    }
  }

  return [...MANUAL_REPORT_ACCESS_DEFINITIONS, ...dynamic];
}

export function getManualReportAccessDefinition(reportKey: string, schedules: ScheduleAccessLike[]): ManualReportAccessDefinition | undefined {
  return listManualReportAccessDefinitions(schedules).find((definition) => definition.key === reportKey);
}
