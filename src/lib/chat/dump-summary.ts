// The words chat shows for a dump that took the older review path (a proposal
// review modal instead of one turn card): the summary under the dump, the
// setup wizard's first dump, and the offer of a roadmap for a project with no
// steps (moved out of AppShell, 2026-10-04).

export interface DumpSummaryFacts {
  appliedCount: number;
  reviewCount: number;
  completedTitles: string[];
  questionCount: number;
  // Ranking changes the dump made (already applied).
  priorityChanged: boolean;
  // Weekly commitments saved, or a reorganization waiting on a card.
  otherChange: boolean;
  unclear: string[];
}

export function dumpSummaryText(facts: DumpSummaryFacts): string {
  const { appliedCount, reviewCount, completedTitles, questionCount, priorityChanged, otherChange, unclear } = facts;
  return [
    appliedCount > 0
      ? `I added ${appliedCount} item${appliedCount === 1 ? "" : "s"} to your graph${
          reviewCount > 0
            ? ` — ${reviewCount} ${reviewCount === 1 ? "needs" : "need"} a quick look in the panel that just opened.`
            : "."
        }`
      : reviewCount > 0
        ? `I analyzed your dump and proposed ${reviewCount} node${reviewCount === 1 ? "" : "s"} and their connections — review and accept them in the panel that just opened.`
        : priorityChanged
          ? "Nothing new to add — I updated what matters instead:"
          : otherChange
            ? "Nothing new to add to the graph."
            : "I went through your dump but didn't find anything new worth proposing.",
    completedTitles.length > 0
      ? `I also marked ${completedTitles.length} existing item${completedTitles.length === 1 ? "" : "s"} done: ${completedTitles.slice(0, 3).join(", ")}${completedTitles.length > 3 ? "…" : ""}.`
      : null,
    questionCount > 0
      ? `I have ${questionCount} quick clarifying question${questionCount === 1 ? "" : "s"} — answer inline when ready.`
      : null,
    priorityChanged && appliedCount + reviewCount > 0 ? "I also updated what matters:" : null,
    unclear.length > 0 ? `One thing I didn't change — ${unclear[0]} Tell me here and I'll update it.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The setup wizard's first dump, as chat's reply under it. */
export function bootstrapSummaryText(facts: { extractionFailed: boolean; nodeCount: number; questionCount: number }): string {
  const { extractionFailed, nodeCount, questionCount } = facts;
  return extractionFailed
    ? "I couldn't process that dump right now — your notes are saved. Try a Brain Dump again in a moment."
    : [
        nodeCount > 0
          ? `I analyzed your first dump and proposed ${nodeCount} node${nodeCount === 1 ? "" : "s"} and their connections — review and accept them in the panel that just opened.`
          : "I went through your dump but didn't find anything new worth proposing yet.",
        questionCount > 0
          ? `I have ${questionCount} quick clarifying question${questionCount === 1 ? "" : "s"} — answer inline when ready.`
          : null,
      ]
        .filter(Boolean)
        .join(" ");
}

/** The in-thread "want a roadmap?" offer for projects that landed with no steps. */
export function roadmapOfferText(projects: Array<{ title: string }>): string {
  const names = projects.slice(0, 3).map((p) => `"${p.title}"`);
  const extra = projects.length - names.length;
  const nameList =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return projects.length === 1
    ? `${nameList} is a project with no steps under it yet. Want me to suggest a roadmap for it? Just say the word and I'll propose steps you can review.`
    : `${nameList}${extra > 0 ? ` and ${extra} more` : ""} are projects with no steps under them yet. Want me to suggest a roadmap for any of them?`;
}
