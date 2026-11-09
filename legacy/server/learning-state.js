import { randomUUID } from 'node:crypto';
export function mergeGaps(session, proposed) {
  for (const candidate of proposed.slice(0, 4)) {
    if (!candidate.title.trim()) continue;
    let gap = session.gaps.find(g => g.id === candidate.id || g.title === candidate.title);
    if (!gap && session.gaps.length < 6) {
      const id = /^[a-zA-Z0-9_-]{1,50}$/.test(candidate.id) ? candidate.id : 'gap_' + randomUUID().slice(0, 8);
      gap = { id, title: candidate.title.slice(0, 100), status: 'hypothesis', reason: candidate.reason.slice(0, 1000), evidenceIds: [] };
      session.gaps.push(gap);
    } else if (gap) gap.reason = candidate.reason.slice(0, 1000);
  }
  if (!session.gaps.length) session.gaps.push({ id: 'understanding', title: '当前概念的理解', status: 'hypothesis', reason: '尚无足够证据，需要一个具体例子。', evidenceIds: [] });
}
export function applyGrade(session, user, grade) {
  const check = session.check;
  if (!check) return;
  if (grade.helpRequested || user.action === 'hint' || user.action === 'example') {
    check.assisted = true;
    return;
  }
  // Only evidence quoted from this answer can change a learning state.
  if (!grade.quote.trim() || !user.content.includes(grade.quote) || grade.verdict === 'unclear') return;
  const gap = session.gaps.find(g => g.id === check.skillId);
  if (!gap) return;
  const assisted = Boolean(check.assisted);
  const evidence = { id: randomUUID(), messageId: user.id, checkId: check.id, skillId: gap.id,
    question: check.question, quote: grade.quote, explanation: grade.explanation, verdict: grade.verdict,
    kind: check.kind, assisted, createdAt: new Date().toISOString() };
  session.evidence.push(evidence);
  gap.evidenceIds.push(evidence.id);
  if (grade.verdict === 'incorrect') gap.status = gap.status === 'independent' ? 'revisit' : 'needs_work';
  else if (gap.status !== 'independent') gap.status = assisted ? 'assisted' : check.kind === 'transfer' ? 'independent' : 'observed';
  // Reusing a completed question can never be counted as a new independent transfer.
  if (!session.completedChecks.includes(check.question)) session.completedChecks.push(check.question);
}
export function installCheck(session, check) {
  const previous = session.check;
  const known = session.gaps.some(g => g.id === check.skillId);
  if (!known || !check.question.trim() || !check.rubric.trim()) throw new Error('辅导响应缺少有效的验证问题。');
  const repeated = previous?.question.trim() === check.question.trim();
  session.check = { ...check, id: repeated ? previous.id : randomUUID(),
    assisted: (repeated && previous.assisted) || session.completedChecks.includes(check.question),
    createdAt: new Date().toISOString() };
}
