export type Diagnostic = { code: string; source: string; level: 'info' | 'warning' | 'error'; message: string; runId?: string };
export type Candidate = { id: string; name: string; role: string; rawRole: string; rating: string | null; rawStatus: string | null; stage: string; conflict: boolean; statuses: string[] };
export type Role = { name: string; priority: string | null; status: string | null; configured: boolean };
export type CandidateDocument = { id: string; label: string; kind: 'markdown' | 'text' | 'pdf' | 'unsupported'; status: 'ok' | 'missing' | 'blocked' | 'error'; message: string | null; size: number | null };
export type CandidateDetail = {
  candidate: Pick<Candidate, 'id' | 'name' | 'rawRole' | 'role' | 'rawStatus' | 'rating'>;
  background: string;
  notes: string;
  sourceRound: string;
  documents: CandidateDocument[];
  warnings: string[];
};
export type DocumentContent = { document: CandidateDocument; text: string | null; absolutePath: string };
export type RoleInfo = { contextRevision: string; roles: Role[]; allowedStatuses: string[] };
export type RoleSetResult = RoleInfo & { changed: boolean; role: string; status: string; backup: string | null };
export type RunStep = { id: string; label: string; status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'; reason: string | null; updatedAt: string };
export type RunResult = { id: string; stepId: string; candidateId: string; action: string; outcome: string; attention: 'none' | 'notice' | 'decision'; nextAction: string | null; updatedAt: string };
export type RunResultInput = Omit<RunResult, 'updatedAt'>;
export type RunResultSummary = { total: number; decisions: number; notices: number; updatedAt: string | null; revision: number };
export type RunResults = { runId: string; updatedAt: string; results: RunResult[] | null; revision: number };
export type RunActivity = { runId: string; revision: number; updatedAt: string; items: RunResult[] | null };
export type Run = {
  schemaVersion: 1;
  id: string;
  workflow: string;
  label: string;
  role: string | null;
  ownerSessionId: string | null;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  steps: RunStep[];
  results: RunResult[] | null;
  resultsRevision: number;
};
export type RunSummary = Omit<Run, 'results'> & { resultSummary: RunResultSummary | null };
export type TaskSelection = { mode: 'live' | 'pinned'; runId: string | null };
export type TaskView = { selection: TaskSelection; run: RunSummary | null; latestRunId: string | null; newerRunId: string | null };
export type RoleScope = 'active' | 'following' | 'all';
export type RoleSelection = { roles: Role[]; selectedRole: Role | null; outsideScope: boolean; selectionMissing: boolean; candidates: Candidate[] | null; total: number | null; stages: { id: string; label: string; count: number | null }[]; label: string };
export type SourceStatus = 'ok' | 'missing' | 'error' | 'stale';
export type SourceState = { status: SourceStatus; updatedAt: string | null };
export type BoardSnapshot = {
  schemaVersion: number;
  workspace: string;
  workspaceKey?: string;
  status: 'ok' | 'partial' | 'error' | 'stale';
  error: { code: string; message: string } | null;
  generatedAt: string;
  ledgerUpdatedAt: string | null;
  contextRevision: string | null;
  candidates: Candidate[] | null;
  stages: { id: string; label: string; count: number | null }[];
  roles: Role[];
  runs: RunSummary[] | null;
  unknownStatuses: { status: string; count: number }[];
  diagnostics: Diagnostic[];
  sources: { ledger: SourceState; context: SourceState; runs: SourceState; config: SourceState };
};
export type RecruitingBoardPanel = {
  kind: 'candidate'; requestId: number; candidateId: string; origin: 'stages' | 'activity' | 'confirmations'; showBackground: boolean; status: 'loading' | 'ready' | 'error'; detail: CandidateDetail | null; document: DocumentContent | null; documentId: string | null; documentBusy: boolean; message: string | null;
  returnTo: Extract<RecruitingBoardPanel, { kind: 'results' }> | null;
} | {
  kind: 'roles'; requestId: number; status: 'loading' | 'ready' | 'saving' | 'error'; info: RoleInfo | null; role: string; selectedStatus: string; message: string | null;
} | {
  kind: 'results'; requestId: number; runId: string; revision: number | null; status: 'loading' | 'ready' | 'stale' | 'error'; data: RunResults | null; filter: 'all' | 'decision' | 'notice'; expanded: string[]; message: string | null;
};
export type RecruitingBoardState = {
  snapshot: BoardSnapshot | null;
  panel: RecruitingBoardPanel | null;
  error: string | null;
  selection: {
    scope: 'active' | 'following' | 'all';
    following: string[];
    role: string;
    query: string;
    editor: { query: string } | null;
    message: string | null;
  };
  taskSelection: { mode: 'live' | 'pinned'; runId: string | null };
  activity: { requestId: number; runId: string; revision: number | null; status: 'loading' | 'ready' | 'stale' | 'error'; data: RunActivity | null; message: string | null } | null;
  confirmations: { requestId: number; runId: string; revision: number | null; status: 'loading' | 'ready' | 'stale' | 'error'; data: RunResults | null; error: string | null } | null;
  stage: string | null;
  sessionId: string | null;
  workspaceRoot: string | null;
  showRecords: boolean;
  showStages: boolean;
  showSteps: boolean;
  showDetails: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    'recruiting-board': { board: RecruitingBoardState };
  }
}
