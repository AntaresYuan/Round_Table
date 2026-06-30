export type AgentRole = 'planner' | 'pm' | 'architect' | 'implementer' | 'reviewer' | 'fixer';

export type AgentProfile = {
  id: string;
  role: AgentRole;
  assignee: string;
  displayName: string;
  aliases: string[];
};

export const AGENT_ROSTER: AgentProfile[] = [
  {
    id: 'orchestrator',
    role: 'planner',
    assignee: '@planning',
    displayName: 'Planning',
    aliases: ['planning', 'planner', 'orchestrator', 'all'],
  },
  {
    id: 'mira',
    role: 'pm',
    assignee: '@pm',
    displayName: 'PM',
    aliases: ['pm', 'product', 'manager'],
  },
  {
    id: 'nova',
    role: 'architect',
    assignee: '@nova',
    displayName: 'Nova',
    aliases: ['nova', 'architect', 'architecture'],
  },
  {
    id: 'atlas',
    role: 'implementer',
    assignee: '@atlas',
    displayName: 'Atlas',
    aliases: ['atlas', 'implementer', 'frontend', 'dev'],
  },
  {
    id: 'beam',
    role: 'implementer',
    assignee: '@beam',
    displayName: 'Beam',
    aliases: ['beam', 'backend', 'api'],
  },
  {
    id: 'vera',
    role: 'reviewer',
    assignee: '@vera',
    displayName: 'Vera',
    aliases: ['vera', 'reviewer', 'review'],
  },
  {
    id: 'fixer',
    role: 'fixer',
    assignee: '@fixer',
    displayName: 'Fixer',
    aliases: ['fixer', 'fix', 'debugger'],
  },
];

export function resolveAgentMention(value: string): AgentProfile | null {
  const normalized = value.replace(/^@/, '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  return AGENT_ROSTER.find((agent) =>
    agent.id === normalized
    || agent.role === normalized
    || agent.aliases.includes(normalized),
  ) ?? null;
}

export function agentForTask(input: {
  owner?: string | undefined;
  assignee: string;
  role?: string | undefined;
}): AgentProfile {
  const byOwner = input.owner ? resolveAgentMention(input.owner) : null;
  if (byOwner) return byOwner;
  const byAssignee = resolveAgentMention(input.assignee);
  if (byAssignee) return byAssignee;
  const byRole = input.role ? resolveAgentMention(input.role) : null;
  return byRole ?? AGENT_ROSTER[0]!;
}

export function mentionTokens(message: string): string[] {
  return [...message.matchAll(/@([a-zA-Z][\w-]*)/g)].map((match) => match[1] ?? '');
}

export function messageWithoutMentions(message: string): string {
  return message.replace(/@([a-zA-Z][\w-]*)/g, ' ').replace(/\s+/g, ' ').trim();
}

export function mentionedAgents(message: string): AgentProfile[] {
  const tokens = mentionTokens(message);
  if (tokens.length === 0 || tokens.some((token) => token.toLowerCase() === 'all')) {
    return [...AGENT_ROSTER];
  }

  const seen = new Set<string>();
  const agents: AgentProfile[] = [];
  for (const token of tokens) {
    const target = resolveAgentMention(token);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    agents.push(target);
  }
  return agents.length > 0 ? agents : [...AGENT_ROSTER];
}
