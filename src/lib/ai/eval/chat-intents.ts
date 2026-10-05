// One message, every intent (#22, 2026-10-05) — chat messages that carry
// several things, each with what must come of it. "Chat controls everything":
// a message with three things in it does three things. What the user STATED is
// applied, or waits on the card where the policy says so (a move, a rename, a
// plan); what they only ASKED about stays advice (advice-guard.ts).
//
// Run live through the real route: scripts/eval-chat-intents.ts. The titles
// are the synthetic graph that script seeds. Dates assume the run's "today" is
// before them (they are spelled out, not relative).

export type IntentCheckKind =
  | "habit_done" // a habit check-in logged
  | "status" // node status became value
  | "steer" // a focus / deprioritize steer (advice: true → must NOT be applied)
  | "drop_advice" // asked "should I drop X?" → X still active
  | "field" // a node field set to value
  | "created" // a new node whose title matches
  | "waits" // a reorganizing op (value = kind) on the card
  | "tool_waits" // a call (value = tool name) on the card
  | "commitment"; // a weekly fixed time saved

export interface IntentCheck {
  label: string;
  kind: IntentCheckKind;
  title?: string;
  value?: string | number;
  field?: string;
  match?: RegExp;
  advice?: boolean;
}

export interface MultiIntentCase {
  id: string;
  message: string;
  checks: IntentCheck[];
}

export const MULTI_INTENT_CASES: MultiIntentCase[] = [
  {
    id: "gym-cv-advice",
    message: "Did the gym. Also the CV update can wait till next week, should I focus on stats or the internship?",
    checks: [
      { label: "gym logged", kind: "habit_done", title: "Go to the gym" },
      { label: "CV can wait (applied)", kind: "steer", title: "Update CV", value: "deprioritize" },
      { label: "stats focus stays advice", kind: "steer", title: "Pass Statistics Midterm", value: "focus", advice: true },
      { label: "internship focus stays advice", kind: "steer", title: "Get Internship by November", value: "focus", advice: true },
    ],
  },
  {
    id: "done-defer-question",
    message: "finally updated my CV! clothes reselling can wait till after the midterm. what should I do first today?",
    checks: [
      { label: "CV done", kind: "status", title: "Update CV", value: "completed" },
      { label: "reselling can wait (applied)", kind: "steer", title: "Clothes Reselling", value: "deprioritize" },
      { label: "no focus applied from the answer", kind: "steer", title: "Pass Statistics Midterm", value: "focus", advice: true },
    ],
  },
  {
    id: "add-and-move",
    message: "Add a task to email the stats TA about office hours, and move Italian Crash Course under Personal Development.",
    checks: [
      { label: "email-TA task added", kind: "created", match: /\bTA\b|teaching assistant/i },
      { label: "Italian move on the card", kind: "waits", title: "Italian Crash Course", value: "move" },
    ],
  },
  {
    id: "vent-date-task",
    message: "ugh I'm so behind on everything. the stats midterm is on oct 20, and I need to book a room for the study group",
    checks: [
      { label: "midterm dated 2026-10-20", kind: "field", title: "Pass Statistics Midterm", field: "target_date", value: "2026-10-20" },
      { label: "book-a-room task added", kind: "created", match: /room/i },
    ],
  },
  {
    id: "habit-and-plan",
    message: "went to the gym this morning, now plan my afternoon",
    checks: [
      { label: "gym logged", kind: "habit_done", title: "Go to the gym" },
      { label: "afternoon plan on the card", kind: "tool_waits", value: "plan_day" },
    ],
  },
  {
    id: "plan-rest-of-day",
    message: "plan the rest of my day",
    checks: [{ label: "plan on the card, no questions first", kind: "tool_waits", value: "plan_day" }],
  },
  {
    id: "plan-with-time-block",
    message: "plan my day, I want 3h on the Italian course",
    checks: [{ label: "plan on the card", kind: "tool_waits", value: "plan_day" }],
  },
  {
    id: "wait-and-add",
    message: "Took the stats midterm today, now waiting on results. Also add 'apply to the Milan internship' under the internship goal.",
    checks: [
      { label: "midterm waiting", kind: "status", title: "Pass Statistics Midterm", value: "paused" },
      { label: "Milan application added", kind: "created", match: /milan/i },
    ],
  },
  {
    id: "commitment-defer-question",
    message: "I have statistics lectures every Tue and Thu 2-4pm. The BrainDump fixes can wait. Is getting the internship by November realistic?",
    checks: [
      { label: "lectures saved", kind: "commitment", match: /stat/i },
      { label: "BrainDump fixes can wait (applied)", kind: "steer", title: "BrainDump Future Fixes & Features", value: "deprioritize" },
    ],
  },
  {
    id: "stakes-focus-drop-question",
    message: "I really need the stats midterm for my scholarship, so I'm focusing on it this week. should I drop clothes reselling?",
    checks: [
      { label: "midterm stakes high", kind: "field", title: "Pass Statistics Midterm", field: "stakes", value: 1 },
      { label: "midterm focus (applied)", kind: "steer", title: "Pass Statistics Midterm", value: "focus" },
      { label: "reselling not dropped (advice)", kind: "drop_advice", title: "Clothes Reselling" },
    ],
  },
  {
    id: "done-deadline-question",
    message: "I finished the BrainDump future fixes. The internship deadline moved to november 15. what's next for me?",
    checks: [
      { label: "fixes done", kind: "status", title: "BrainDump Future Fixes & Features", value: "completed" },
      { label: "internship dated 2026-11-15", kind: "field", title: "Get Internship by November", field: "target_date", value: "2026-11-15" },
    ],
  },
  {
    id: "rename-and-habit",
    message: "Rename Clothes Reselling to Vintage Reselling, and mark the gym done for today",
    checks: [
      { label: "rename on the card", kind: "waits", title: "Clothes Reselling", value: "update" },
      { label: "gym logged", kind: "habit_done", title: "Go to the gym" },
    ],
  },
];
