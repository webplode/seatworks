import type { PluginHookContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHookContext["paseo"];

export type SeatView = {
  id: string;
  workspaceId?: string | null;
  title?: string | null;
  provider: string;
  cwd: string;
  status: string;
  updatedAt: string;
  createdAt?: string;
  archivedAt?: string | null;
  labels?: Record<string, string>;
  pendingPermissions?: PendingPermission[];
};

export type PendingPermission = { id?: string; kind?: string; name?: string; title?: string; description?: string; input?: Record<string, unknown> };

export type PermissionResponse = { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message?: string };

type Question = { question: string; header?: string; options: string[] };

export function questionsIn(request: PendingPermission): Question[] {
  const listed = Array.isArray(request.input?.questions) ? (request.input.questions as unknown[]) : [];
  const found: Question[] = [];
  for (const item of listed) {
    const entry = (item ?? {}) as Record<string, unknown>;
    if (typeof entry.question !== "string" || !entry.question.trim()) continue;
    const options = Array.isArray(entry.options)
      ? entry.options.map((option) => (typeof option === "string" ? option : typeof (option as { label?: unknown })?.label === "string" ? (option as { label: string }).label : "")).filter(Boolean)
      : [];
    found.push({ question: entry.question, header: typeof entry.header === "string" ? entry.header : undefined, options });
  }
  return found;
}

/** Paseo's own question screen keys answers by header; Claude reads them by the question's words. */
export function answerWith(request: PendingPermission, text: string): PermissionResponse {
  const answers: Record<string, string> = {};
  questionsIn(request).forEach((entry, index) => {
    const answer = index === 0 ? text : "Answered together with the first question.";
    answers[entry.question] = answer;
    if (entry.header) answers[entry.header] = answer;
  });
  return { behavior: "allow", updatedInput: { answers } };
}
