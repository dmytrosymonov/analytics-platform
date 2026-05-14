const LOOKER_IGNORED_TEST_AGENT_NAMES = new Set([
  'gto for test-goodwin',
  'ocoo мтревел test agent for gto-test website',
  'esky_test',
  'kg goodwin test agent гранд турс паруса',
  'test_b2b',
  'tina test online.gto.global',
  'o2_test',
  'test new',
  'tina test agent mtp gto pl',
  'goodwin test kz',
  'tina test agent mtp gto kz',
  'test1watt',
  'test verify',
  'reg travel test',
  'test goodwin agent gto.online.global',
  'gto global kazakhstan test goodwin agent (gto.kz)',
  'kz test agency',
  'gto global poland test goodwin agent (gto.pl)',
  'test registration pl',
  'pl test agent',
  'your brand travel (test agent. view only)',
  'testuser',
  '2025 test agent',
  'testagency',
  'test-',
  'test',
]);

export function normalizeLookerAgentName(value?: string | null) {
  return String(value || '').trim().toLocaleLowerCase('uk-UA');
}

export function isIgnoredLookerTestAgentName(value?: string | null) {
  return LOOKER_IGNORED_TEST_AGENT_NAMES.has(normalizeLookerAgentName(value));
}

export function getIgnoredLookerTestAgentNames() {
  return Array.from(LOOKER_IGNORED_TEST_AGENT_NAMES);
}
