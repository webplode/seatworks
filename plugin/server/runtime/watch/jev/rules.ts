import type { Question } from "../../../catalog/kit.ts";
import type { Fact } from "../facts.ts";
import { type Finding, type Verdict, rank } from "../findings.ts";

export function confirmable(questions: Record<string, Question>): Set<string> {
  return new Set(Object.values(questions).flatMap((question) => (question.threshold === undefined ? [] : (question.confirms ?? []))));
}

export type Reading = { unclear: number; ended: boolean; before?: Record<string, number> };

export function weigh(assessment: { answers: Record<string, number>; model: string }, questions: Record<string, Question>, noted: Fact[], reading: Reading): { findings: Finding[]; verdicts: Verdict[] } {
  const { unclear, ended, before } = reading;
  const findings: Finding[] = [];
  const verdicts: Verdict[] = [];
  for (const [name, question] of Object.entries(questions)) {
    const p = assessment.answers[name];
    const threshold = question.threshold;
    if (p === undefined || threshold === undefined) continue;
    const passes = p >= threshold;
    const doubtful = !passes && p >= Math.round((threshold - unclear) * 1e9) / 1e9;
    for (const kind of new Set(noted.filter((fact) => question.confirms?.includes(fact.kind)).map((fact) => fact.kind))) {
      verdicts.push({ kind, question: name, p, model: assessment.model, says: passes ? "confirms" : doubtful ? "unclear" : "vetoes" });
    }
    // An answer in the unclear band opens nothing: the sensor cannot tell, and the panel shows it as a lean.
    if (!question.level || !passes) continue;
    const again = before?.[name];
    if (question.alone && question.level === "attend" && !ended && (again === undefined || again < threshold)) continue;
    const agreeing = question.alone ? [] : noted.filter((fact) => question.agrees?.includes(fact.kind));
    if (!question.alone && agreeing.length === 0) continue;
    const because = agreeing.map((fact) => `${fact.kind}: ${fact.quote}`).join("; ");
    findings.push({ kind: name, level: question.level, quote: because ? `${question.instructions} — ${because}` : question.instructions, facts: [...new Set(agreeing.map((fact) => fact.kind))], p, model: assessment.model });
  }
  return { findings: findings.sort((a, b) => rank(a) - rank(b)), verdicts };
}
