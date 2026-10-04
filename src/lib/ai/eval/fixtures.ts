// Eval fixtures — synthetic data only, never a real workspace.
//
// What the product does today (2026-10-04), and what these check:
//   builder  — a dump or chat's build_graph: extract-v26 for long texts,
//              extract-light for ≤700 chars, the edit pass for the requests
//              the long prompt quotes, node types v2 (docs/node-types.md),
//              belongs_to parents, and the one-turn change set + policy
//              (docs/unified-turn.md). Runner and checks: ./builder.ts.
//   edges    — the connection engine's batched infer-edge call, read through
//              edge-selection.ts as connection.ts does.
//   merge    — the merge check behind merge alerts.
//   planner  — short (Haiku) plans, incl. fixed commitments inside a session.
// Run: `npx tsx --env-file=.env.local scripts/eval-run.ts` (or POST
// /api/eval/run in dev). A whole run is sized to stay under ~$0.25.
// When a prompt's behaviour changes on purpose, change the expectation here.

import type { NodeType } from "@/types/graph";
import type { PlanningWindow } from "@/types/ai";
import type { BusyInterval } from "@/lib/planner/commitments";

// ---------------------------------------------------------------------------
// The synthetic workspace the builder fixtures run against
// ---------------------------------------------------------------------------

// The date the fixtures are written for: a Wednesday, so "by friday" is
// 2026-10-09 and "thursday" 2026-10-08 (lib/time/relative-day.ts).
export const EVAL_TODAY = "2026-10-07";

export interface SyntheticNode {
  id: string;
  title: string;
  node_type: NodeType;
  summary?: string;
  parent?: string; // id
}

const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SYNTHETIC_IDS = {
  root: id(1),
  university: id(2),
  stats: id(3),
  statsMidterm: id(4),
  problemSet4: id(5),
  machineLearning: id(6),
  mlProject: id(7),
  health: id(8),
  gym: id(9),
  moneyProjects: id(10),
  testMarket: id(11),
  clothes: id(12),
  career: id(13),
  internship: id(14),
  italian: id(15),
  personalDev: id(16),
  lifeAdmin: id(17),
  parkingPass: id(18),
} as const;

const S = SYNTHETIC_IDS;

// A student with side projects — the shape of the owner's Round 2 graph,
// with made-up content. The root is an area (node types v2).
export const SYNTHETIC_GRAPH: SyntheticNode[] = [
  { id: S.root, title: "Alex", node_type: "area" },
  { id: S.university, title: "University", node_type: "area", parent: S.root },
  { id: S.stats, title: "Statistics 302", node_type: "class", parent: S.university, summary: "Tue/Thu lectures; midterm in November." },
  { id: S.statsMidterm, title: "Pass the Stats 302 Midterm", node_type: "goal", parent: S.stats },
  { id: S.problemSet4, title: "Problem Set 4", node_type: "task", parent: S.stats, summary: "Regression problems, due this week." },
  { id: S.machineLearning, title: "Machine Learning", node_type: "class", parent: S.university },
  { id: S.mlProject, title: "ML Course Project", node_type: "big_task", parent: S.machineLearning, summary: "Semester project: pick a dataset, write a proposal, build a model." },
  { id: S.health, title: "Health", node_type: "area", parent: S.root },
  { id: S.gym, title: "Go to the Gym", node_type: "habit", parent: S.health, summary: "3× a week." },
  { id: S.moneyProjects, title: "Money Projects", node_type: "project", parent: S.root, summary: "Side projects that should bring in money." },
  { id: S.testMarket, title: "Test & Market BrainDump", node_type: "big_task", parent: S.moneyProjects, summary: "BrainDump is my productivity app — it needs testing and marketing." },
  { id: S.clothes, title: "Clothes Reselling", node_type: "idea", parent: S.moneyProjects, summary: "Maybe resell vintage clothes from Milan online." },
  { id: S.career, title: "Career", node_type: "area", parent: S.root },
  { id: S.internship, title: "Land an Internship in Milan by November", node_type: "goal", parent: S.career },
  { id: S.italian, title: "Italian Crash Course", node_type: "big_task", parent: S.career, summary: "Get to conversational Italian for the internship." },
  { id: S.personalDev, title: "Personal Development", node_type: "area", parent: S.root },
  { id: S.lifeAdmin, title: "Life Admin", node_type: "area", parent: S.root },
  { id: S.parkingPass, title: "Renew Parking Pass", node_type: "task", parent: S.lifeAdmin },
];

// ---------------------------------------------------------------------------
// Builder fixtures
// ---------------------------------------------------------------------------

// How a check names a node:
//   • the exact title of a SYNTHETIC_GRAPH node (any case) → that node;
//   • anything else → a node this turn creates whose title contains it
//     (an exact title match wins over a partial one).
export type NodeName = string;

export interface ExpectedOp {
  kind: "create_node" | "move" | "update" | "complete" | "create_edge";
  // A create: the new node; move / update / complete: the existing node;
  // create_edge: either end.
  node: NodeName;
}

export interface BuilderFixture {
  id: string;
  // The rules this fixture exercises, in one line.
  covers: string;
  // Which prompt the text must take — the runner picks by length exactly as
  // runBuilder does (≤ AI_INGESTION.LIGHT_DUMP_MAX_CHARS → light); a unit test
  // keeps the two in step.
  prompt: "light" | "full";
  // Run against SYNTHETIC_GRAPH (as if retrieval returned all of it) or an
  // empty workspace.
  graph: "synthetic" | "empty";
  input: string;
  expect: {
    // New nodes and the types they may have.        → check "nodes"
    nodes?: Array<{ title: NodeName; type: NodeType | NodeType[] }>;
    // A new node's belongs_to parent (one of).        → check "parents"
    parents?: Array<{ child: NodeName; parent: NodeName | NodeName[] }>;
    // Links in the change set (source → target).      → check "links"
    links?: Array<{ source: NodeName; target: NodeName; types?: string[] }>;
    // Existing nodes the turn marks done — and nothing else. → check "completions"
    completes?: NodeName[];
    // Substrings of the sentences the long prompt quotes as edit requests.
    // A full-prompt fixture without it must quote nothing. → check "edit_requests"
    edit_requests?: string[];
    // Moves / renames of existing nodes. Without either, the turn must not
    // move or edit any existing node.                  → check "edits"
    moves?: Array<{ node: NodeName; parent: NodeName }>;
    renames?: Array<{ node: NodeName; title_contains: string }>;
    // target_date on a new node (from the user's date words). → check "dates"
    dates?: Array<{ title: NodeName; date: string }>;
    // No new node whose title contains any of these; caps.  → check "no_extra"
    absent?: string[];
    max_new_nodes?: number;
    max_questions?: number;
    // How the change set splits under the turn policy, for a user whose
    // calibration trusts every new node (so what waits is what the policy
    // itself holds back).                               → check "policy"
    waits?: ExpectedOp[];
    applies?: ExpectedOp[];
  };
}

export const BUILDER_FIXTURES: BuilderFixture[] = [
  {
    id: "light-types",
    covers: "types v2 on a short dump: task / big_task / idea / note; a note under the class it is about; date words",
    prompt: "light",
    graph: "synthetic",
    input:
      "need to email the ML TA about office hours by friday. I also want to write my thesis this year — that's a big one. maybe someday a podcast about student life? and noah kim is the new TA for stats, good to remember.",
    expect: {
      nodes: [
        { title: "office hours", type: "task" },
        { title: "thesis", type: "big_task" },
        { title: "podcast", type: "idea" },
        { title: "noah", type: "note" },
      ],
      parents: [
        { child: "noah", parent: "Statistics 302" },
        { child: "office hours", parent: ["Machine Learning", "ML Course Project"] },
      ],
      dates: [{ title: "office hours", date: "2026-10-09" }],
      max_new_nodes: 5,
    },
  },
  {
    id: "light-goal-habit",
    covers: "goal = a result (pass the exam), big_task = work over sittings, habit = a stated cadence, attached to an existing area",
    prompt: "light",
    graph: "synthetic",
    input:
      "this semester I want to pass the linear algebra exam in january. prepping the Q4 student-club budget deck will take a few sessions. and I'm starting to run 3x a week.",
    expect: {
      nodes: [
        { title: "linear algebra", type: ["goal", "class"] },
        { title: "budget", type: "big_task" },
        { title: "run", type: "habit" },
      ],
      parents: [{ child: "run", parent: "Health" }],
      max_new_nodes: 4,
    },
  },
  {
    id: "light-completions",
    covers: "past tense completes existing nodes (a habit too); a plan for an existing item proposes nothing",
    prompt: "light",
    graph: "synthetic",
    input: "did the gym this morning!! finished problem set 4 last night. still need to renew the parking pass at some point.",
    expect: {
      completes: ["Go to the Gym", "Problem Set 4"],
      absent: ["gym", "problem set", "parking"],
      max_new_nodes: 0,
      max_questions: 0,
      applies: [
        { kind: "complete", node: "Go to the Gym" },
        { kind: "complete", node: "Problem Set 4" },
      ],
    },
  },
  {
    id: "light-steps",
    covers: "named steps become children of the existing big task, each with its own date; no copy of the parent",
    prompt: "light",
    graph: "synthetic",
    input: "for the ML course project I have to pick a dataset by friday and then write the proposal by oct 20",
    expect: {
      nodes: [
        { title: "dataset", type: "task" },
        { title: "proposal", type: ["task", "big_task"] },
      ],
      parents: [
        { child: "dataset", parent: "ML Course Project" },
        { child: "proposal", parent: "ML Course Project" },
      ],
      dates: [
        { title: "dataset", date: "2026-10-09" },
        { title: "proposal", date: "2026-10-20" },
      ],
      absent: ["course project"],
      max_new_nodes: 2,
      applies: [
        { kind: "create_node", node: "dataset" },
        { kind: "create_node", node: "proposal" },
      ],
    },
  },
  {
    id: "light-commitment",
    covers: "a weekly fixed time is a commitment, never a node; the new item goes under the class",
    prompt: "light",
    graph: "synthetic",
    input:
      "stats lecture moved to tuesdays and thursdays 2-4pm from next week. also need to buy a graphing calculator before the midterm.",
    expect: {
      nodes: [{ title: "calculator", type: "task" }],
      parents: [{ child: "calculator", parent: ["Statistics 302", "Pass the Stats 302 Midterm"] }],
      absent: ["lecture"],
      max_new_nodes: 1,
    },
  },
  {
    id: "light-split",
    covers: "edit: a new project over an existing node — rename it into one part, create the other, move it in; the whole reorganization waits",
    prompt: "light",
    graph: "synthetic",
    input: "BrainDump should be its own project, with testing and marketing as two separate things in it",
    expect: {
      nodes: [
        { title: "BrainDump", type: "project" },
        { title: "Market", type: ["big_task", "task"] },
      ],
      parents: [
        { child: "BrainDump", parent: "Money Projects" },
        { child: "Market", parent: "BrainDump" },
      ],
      moves: [{ node: "Test & Market BrainDump", parent: "BrainDump" }],
      renames: [{ node: "Test & Market BrainDump", title_contains: "test" }],
      max_new_nodes: 2,
      waits: [
        { kind: "create_node", node: "BrainDump" },
        { kind: "create_node", node: "Market" },
        { kind: "move", node: "Test & Market BrainDump" },
        { kind: "update", node: "Test & Market BrainDump" },
      ],
    },
  },
  {
    id: "light-move-link",
    covers: "edit: move to another area and keep the old relation as a link; both wait",
    prompt: "light",
    graph: "synthetic",
    input:
      "italian is really personal development, not a career thing — but it still helps with the milan internship, so keep that connection",
    expect: {
      moves: [{ node: "Italian Crash Course", parent: "Personal Development" }],
      links: [
        {
          source: "Italian Crash Course",
          target: "Land an Internship in Milan by November",
          types: ["useful_for", "supports"],
        },
      ],
      max_new_nodes: 0,
      waits: [
        { kind: "move", node: "Italian Crash Course" },
        { kind: "create_edge", node: "Italian Crash Course" },
      ],
    },
  },
  {
    id: "full-mixed",
    covers:
      "extract-v26 on a long mixed dump: venting + a question (nothing), a habit done, a project with named parts, a stated link to an existing goal, a named list, a weekly shift (no node), a quoted edit request run by the edit pass, the last-line aside",
    prompt: "full",
    graph: "synthetic",
    input:
      "ok long one. this week was a mess, slept like 5 hours a night and the stats midterm in november stresses me out. honestly I'm exhausted and kind of behind on everything — should I just drop something? anyway. did the gym this morning at least. I'm starting a portfolio site: need to pick a template, write the about page, and add the ML course project as a case study. the portfolio is mostly for the milan internship applications. I also have to pass three exams this winter: probability, fuzzy systems and deep learning. my shift at the café is every saturday 9 to 2 now. oh and clothes reselling isn't a money project anymore, it's just me selling my old stuff — move it under life admin. also need to call the bank about the card fee at some point.",
    expect: {
      edit_requests: ["clothes reselling"],
      moves: [{ node: "Clothes Reselling", parent: "Life Admin" }],
      completes: ["Go to the Gym"],
      nodes: [
        { title: "portfolio", type: ["project", "big_task"] },
        { title: "template", type: "task" },
        { title: "about", type: "task" },
        { title: "case study", type: ["task", "big_task"] },
        { title: "probability", type: "goal" },
        { title: "fuzzy", type: "goal" },
        { title: "deep learning", type: "goal" },
        { title: "bank", type: "task" },
      ],
      parents: [
        { child: "template", parent: "portfolio" },
        { child: "about", parent: "portfolio" },
        { child: "case study", parent: "portfolio" },
        { child: "probability", parent: ["University", "exam", "winter"] },
        { child: "bank", parent: "Life Admin" },
      ],
      links: [
        {
          source: "portfolio",
          target: "Land an Internship in Milan by November",
          types: ["useful_for", "supports"],
        },
      ],
      absent: ["exhausted", "sleep", "shift", "café", "cafe", "midterm", "gym", "clothes"],
      max_questions: 0,
      waits: [{ kind: "move", node: "Clothes Reselling" }],
      applies: [
        { kind: "complete", node: "Go to the Gym" },
        { kind: "create_node", node: "bank" },
      ],
    },
  },
  {
    id: "full-scratch",
    covers:
      "extract-v26 from an empty workspace: a class anchor, an implied project anchor, an idea, goals vs work, a stated blocker as required_for, a due date on the assignment, nothing quoted as an edit",
    prompt: "full",
    graph: "empty",
    input:
      "brain dump for the week: stats homework chapter 7 problems due thursday. ML project — need to decide between climate dataset or the healthcare one, climate seems more interesting but healthcare has cleaner data. should ask prof martinez which is more feasible for the timeline. random idea: what if I built a tool that visualizes how all my coursework connects together, like a graph of prerequisites and skills? could be a cool side project. goals for this semester: get into the honors program, finish thesis proposal, learn pytorch. the pytorch thing is blocked until I finish the linear algebra review. also I keep forgetting to submit the IRB form for the survey study, that's been on my list for three weeks. need to book a room for the study group tuesday. and I should really start the grad school application essays, deadlines are in december",
    expect: {
      nodes: [
        { title: "stat", type: "class" },
        { title: "chapter 7", type: "task" },
        { title: "honors", type: "goal" },
        { title: "thesis proposal", type: "big_task" },
        { title: "pytorch", type: ["project", "big_task"] },
        { title: "IRB", type: "task" },
        { title: "survey", type: "project" },
        { title: "coursework", type: "idea" },
        { title: "study group", type: "task" },
      ],
      parents: [
        { child: "chapter 7", parent: "stat" },
        { child: "IRB", parent: "survey" },
      ],
      links: [{ source: "linear algebra", target: "pytorch", types: ["required_for"] }],
      dates: [{ title: "chapter 7", date: "2026-10-08" }],
      absent: ["tasks", "misc", "errands"],
    },
  },
];

// ---------------------------------------------------------------------------
// Edge inference fixtures — one batched call per source, like connection.ts
// ---------------------------------------------------------------------------

export interface EdgeFixture {
  id: string;
  covers: string;
  source: { title: string; summary: string | null; node_type: NodeType; has_parent: boolean };
  candidates: Array<{
    id: string;
    title: string;
    summary: string | null;
    node_type: NodeType;
    // The link edge-selection.ts should propose, or null for none. `from`:
    // which end the link starts at ("source" = source → candidate).
    expect: { types: string[]; from: "source" | "candidate" } | null;
  }>;
}

export const EDGE_FIXTURES: EdgeFixture[] = [
  {
    id: "edge-skill",
    covers: "a skill is useful_for what needs it; a near-duplicate and an unrelated chore get nothing",
    source: {
      title: "Linear Algebra Review",
      summary: "Vectors, matrices and eigenvalues before the ML material gets heavy.",
      node_type: "big_task",
      has_parent: true,
    },
    candidates: [
      { id: "c-ml", title: "Machine Learning", summary: "This term's ML class.", node_type: "class", expect: { types: ["useful_for", "supports"], from: "source" } },
      { id: "c-torch", title: "Learn PyTorch", summary: "Tutorials plus a small practice model.", node_type: "project", expect: { types: ["useful_for", "supports", "required_for"], from: "source" } },
      { id: "c-groceries", title: "Buy Groceries", summary: "Weekly shop.", node_type: "task", expect: null },
      { id: "c-dup", title: "Review Linear Algebra", summary: "Go over vectors and matrices again.", node_type: "task", expect: null },
    ],
  },
  {
    id: "edge-direction",
    covers: "direction is its own field: what helps the source points at it; unrelated work and a habit get nothing",
    source: {
      title: "Market BrainDump",
      summary: "Get the first 100 users for the productivity app.",
      node_type: "big_task",
      has_parent: true,
    },
    candidates: [
      { id: "c-tiktok", title: "Faceless Productivity TikToks", summary: "Short videos about planning with ADHD.", node_type: "project", expect: { types: ["supports"], from: "candidate" } },
      { id: "c-beta", title: "Launch the BrainDump Beta", summary: "Public beta with the first cohort of users.", node_type: "goal", expect: { types: ["supports", "useful_for"], from: "source" } },
      { id: "c-k8s", title: "Kubernetes Cluster Setup", summary: "Multi-node cluster for the lab's servers.", node_type: "big_task", expect: null },
      { id: "c-gym", title: "Go to the Gym", summary: "3× a week.", node_type: "habit", expect: null },
    ],
  },
  {
    id: "edge-blocker",
    covers: "a hard blocker is required_for in the right direction (or a parentless step belongs_to its goal); helping is not blocking",
    source: {
      title: "Get the Student Visa",
      summary: "Visa appointment at the consulate, needs the internship offer letter.",
      node_type: "task",
      has_parent: false,
    },
    candidates: [
      { id: "c-move", title: "Move to Milan for the Internship", summary: "Be in Milan by November.", node_type: "goal", expect: { types: ["required_for", "belongs_to"], from: "source" } },
      { id: "c-passport", title: "Renew Passport", summary: "Current passport expires in December.", node_type: "task", expect: { types: ["required_for"], from: "candidate" } },
      { id: "c-italian", title: "Italian Crash Course", summary: "Conversational Italian for the internship.", node_type: "big_task", expect: null },
    ],
  },
];

// ---------------------------------------------------------------------------
// Merge check fixtures — node types v2
// ---------------------------------------------------------------------------

export interface MergeFixture {
  id: string;
  node_a_title: string;
  node_a_summary: string | null;
  node_a_type: NodeType;
  node_b_title: string;
  node_b_summary: string | null;
  node_b_type: NodeType;
  /** Cosine similarity hint passed to the merge-check prompt (0–1). */
  similarity: number;
  expected_same_entity: boolean;
}

export const MERGE_FIXTURES: MergeFixture[] = [
  {
    id: "merge-react",
    node_a_title: "Learn React",
    node_a_summary: "Study React concepts and build practice projects.",
    node_a_type: "project",
    node_b_title: "React.js Study Plan",
    node_b_summary: "Structured plan for learning React including hooks, context, and routing.",
    node_b_type: "project",
    similarity: 0.91,
    expected_same_entity: true,
  },
  {
    id: "merge-area-vs-goal",
    node_a_title: "Financial Independence",
    node_a_summary: "Being free of money worries — savings and investments.",
    node_a_type: "area",
    node_b_title: "Reach $10k MRR by Q4",
    node_b_summary: "Revenue target for the BrainDump SaaS product.",
    node_b_type: "goal",
    similarity: 0.78,
    expected_same_entity: false,
  },
  {
    id: "merge-api-docs",
    node_a_title: "Write API Documentation",
    node_a_summary: "Document all REST endpoints with request/response schemas.",
    node_a_type: "big_task",
    node_b_title: "API Docs",
    node_b_summary: "Technical reference documentation for the public API.",
    node_b_type: "task",
    similarity: 0.88,
    expected_same_entity: true,
  },
  {
    id: "merge-part-of",
    node_a_title: "Build Landing Page",
    node_a_summary: "Design and implement the full marketing landing page for the product.",
    node_a_type: "big_task",
    node_b_title: "Fix Landing Page CTA Button",
    node_b_summary: "The call-to-action button needs better copy and higher contrast styling.",
    node_b_type: "task",
    similarity: 0.82,
    expected_same_entity: false,
  },
  {
    id: "merge-paraphrase",
    node_a_title: "ML Project",
    node_a_summary: "Build a machine learning model for climate data prediction.",
    node_a_type: "big_task",
    node_b_title: "Machine Learning Project",
    node_b_summary: "ML project using historical climate datasets and regression models.",
    node_b_type: "big_task",
    similarity: 0.95,
    expected_same_entity: true,
  },
  {
    id: "merge-session-vs-habit",
    node_a_title: "Gym Session",
    node_a_summary: "Today's leg day workout at the university gym.",
    node_a_type: "task",
    node_b_title: "Go to the Gym",
    node_b_summary: "3× a week, strength and cardio.",
    node_b_type: "habit",
    similarity: 0.83,
    expected_same_entity: false,
  },
  {
    id: "merge-errand",
    node_a_title: "Renew Parking Permit",
    node_a_summary: "Renew the university parking pass before it expires.",
    node_a_type: "task",
    node_b_title: "Update Parking Pass",
    node_b_summary: "Renew the campus parking permit via the student portal.",
    node_b_type: "task",
    similarity: 0.89,
    expected_same_entity: true,
  },
  {
    id: "merge-goal-vs-note",
    node_a_title: "Learn PyTorch",
    node_a_summary: "Become proficient in the PyTorch deep learning framework.",
    node_a_type: "project",
    node_b_title: "PyTorch Tutorial",
    node_b_summary: "Official beginner tutorial covering tensors, autograd, and simple neural nets.",
    node_b_type: "note",
    similarity: 0.86,
    expected_same_entity: false,
  },
  {
    id: "merge-class-vs-goal",
    node_a_title: "Pass Machine Learning",
    node_a_summary: "Pass the ML exam in January.",
    node_a_type: "goal",
    node_b_title: "Machine Learning",
    node_b_summary: "This term's ML class.",
    node_b_type: "class",
    similarity: 0.87,
    expected_same_entity: false,
  },
];

// ---------------------------------------------------------------------------
// Planner fixtures — short sessions (Haiku), node types v2, commitments
// ---------------------------------------------------------------------------

export interface PlannerFixture {
  id: string;
  covers: string;
  planning_window: PlanningWindow;
  // The session as the plan route resolves it (lib/planner/plan-window.ts).
  session_minutes: number;
  session_start_minute: number;
  // Fixed commitments inside the session (lib/planner/commitments.ts).
  busy?: BusyInterval[];
  candidates: Array<{
    id: string;
    title: string;
    summary: string | null;
    node_type: NodeType;
    planning_signals?: string[];
  }>;
  expect: {
    // Candidate ids that must get a block.
    scheduled: string[];
    // Candidate ids that must NOT get a focus block (blocked work).
    not_scheduled?: string[];
    expect_break: boolean;
  };
}

export const PLANNER_FIXTURES: PlannerFixture[] = [
  {
    id: "plan-2h",
    covers: "2h: the urgent items, a break, an end buffer, blocked work not booked (its unblocking message may be)",
    planning_window: "2h",
    session_minutes: 120,
    session_start_minute: 9 * 60,
    candidates: [
      { id: "p-ps5", title: "Statistics Problem Set 5", summary: "Regression problems.", node_type: "task", planning_signals: ["due tomorrow"] },
      { id: "p-irb", title: "Submit IRB Form", summary: "Ethics form for the survey study.", node_type: "task", planning_signals: ["overdue by 3 weeks"] },
      { id: "p-ch2", title: "Write Thesis Chapter 2", summary: "Literature review chapter.", node_type: "big_task", planning_signals: ["blocked: waiting on the advisor's feedback on chapter 1"] },
      { id: "p-reply", title: "Reply to Prof Martinez", summary: "Quick answer about the dataset choice.", node_type: "task" },
    ],
    expect: { scheduled: ["p-ps5", "p-irb"], not_scheduled: ["p-ch2"], expect_break: true },
  },
  {
    id: "plan-busy",
    covers: "a class inside the session: only the free 2h get planned, no block for the class",
    planning_window: "custom",
    session_minutes: 180,
    session_start_minute: 14 * 60,
    busy: [{ id: "b-lecture", title: "Statistics 302 Lecture", start: 15 * 60, end: 16 * 60 }],
    candidates: [
      { id: "p-dataset", title: "Pick a Dataset for the ML Project", summary: "Climate vs healthcare data.", node_type: "task", planning_signals: ["due Friday"] },
      { id: "p-ch4", title: "Read Chapter 4 for Statistics", summary: "Before Thursday's lecture.", node_type: "task" },
      { id: "p-parking", title: "Renew Parking Pass", summary: "Online, 10 minutes.", node_type: "task" },
    ],
    expect: { scheduled: ["p-dataset"], expect_break: true },
  },
];
