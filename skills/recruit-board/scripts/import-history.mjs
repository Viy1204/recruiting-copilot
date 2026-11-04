import { idForIdentity } from '../decisions-domain.mjs';
import { resolveWorkspace } from './reader.mjs';
import { readRunRecord } from './results.mjs';
import { applyDecisionCommand, readDecision } from './decisions.mjs';

export async function importLegacyDecisions(workspace, runId, now = () => new Date().toISOString()) {
  const root = await resolveWorkspace(workspace);
  const run = await readRunRecord(root, runId);
  const imported = [], skipped = [], diagnostics = [];
  for (const result of run.results ?? []) {
    if (result.attention !== 'decision') continue;
    if (result.decisionId) {
      try {
        const item = await readDecision(root, result.decisionId);
        if (!item.sources.some(source => source.runId === run.id)) throw new Error('关联事项缺少该轮来源');
        skipped.push({ resultId: result.id, id: item.id });
      } catch {
        diagnostics.push({ code: 'DECISION_LINK_INVALID', source: 'decisions', level: 'error', runId: run.id, message: `结果 ${result.id} 的事项关联无法核实；未创建替代事项` });
      }
      continue;
    }
    const identity = { subjectKey: `legacy-run:${run.id}`, questionKey: `result:${result.id}`, scope: '历史收据待核对' };
    const input = {
      identity, expectedRevision: 0, requestId: `import-${run.id}-${result.id}`, title: result.nextAction.replace(/\s+/g, ' ').trim(),
      source: { runId: run.id, resultId: result.id }, evidence: result.outcome.replace(/\s+/g, ' ').trim(), createdAt: result.updatedAt,
      context: { scope: 'candidate', candidateId: result.candidateId }
    };
    const existingId = idForIdentity(identity);
    try {
      const existing = await readDecision(root, existingId);
      if (existing.history[0].operation !== 'import' || existing.sources[0].runId !== run.id || existing.sources[0].resultId !== result.id) throw new Error('历史身份已被其他记录占用');
      skipped.push({ resultId: result.id, id: existingId });
      continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const written = await applyDecisionCommand(root, 'import', input, now);
    imported.push({ resultId: result.id, id: written.item.id });
  }
  return { runId: run.id, imported, skipped, diagnostics, status: diagnostics.length ? 'error' : 'ok' };
}
