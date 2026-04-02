// Eval fixtures — Phase 5.6 + Phase 9
// Manually annotated ground truth for regression testing extraction, edge inference,
// assistant, and planner prompts.
// Run via POST /api/eval/run (dev only).
// Update expected values when you intentionally change prompt behavior.

import type { AssistantMode } from "@/types/ai";

export interface BrainDumpFixture {
  id: string;
  input: string;
  expected_nodes: Array<{
    title_contains: string; // substring match — exact titles vary by model run
    node_type: string;
  }>;
  expected_links?: Array<{
    source_title_contains: string;
    target_title_contains: string;
    edge_types?: string[];
  }>;
}

export interface EdgeFixture {
  id: string;
  source_title: string;
  source_summary: string | null;
  target_title: string;
  target_summary: string | null;
  expected_related: boolean;
  expected_edge_type?: string; // optional — some pairs have multiple valid types
}

export interface AssistantFixture {
  id: string;
  mode: AssistantMode;
  message: string;
  context: string;
  scope: string;
  /** Substrings that MUST appear in the answer (case-insensitive). */
  answer_must_contain: string[];
  /** Substrings that must NOT appear — catches generic filler. */
  answer_must_not_contain?: string[];
}

export interface PlannerFixture {
  id: string;
  planning_window: "1h" | "2h" | "day" | "custom";
  total_minutes: number;
  candidate_nodes: Array<{
    id: string;
    title: string;
    summary: string | null;
    node_type: "task" | "project" | "concept" | "goal" | "idea" | "question" | "class" | "journal";
  }>;
  /** Minimum number of blocks expected. */
  min_blocks: number;
  /** At least one block title must contain each of these (case-insensitive). */
  expected_block_titles: string[];
  /** Must include a break if session is 90+ minutes. */
  expect_break: boolean;
  /** Must include a buffer block. */
  expect_buffer: boolean;
}

// ---------------------------------------------------------------------------
// Brain dump extraction fixtures
// ---------------------------------------------------------------------------

export const BRAIN_DUMP_FIXTURES: BrainDumpFixture[] = [
  {
    id: "bd-01",
    input: "Need to finish the landing page for Neurolight by Friday. Also set up the Stripe integration.",
    expected_nodes: [
      { title_contains: "landing page", node_type: "task" },
      { title_contains: "Stripe", node_type: "task" },
    ],
  },
  {
    id: "bd-02",
    input: "Want to learn neural networks. Need to brush up on linear algebra first. Have an ML internship interview coming up.",
    expected_nodes: [
      { title_contains: "neural", node_type: "goal" },
      { title_contains: "linear algebra", node_type: "task" },
      { title_contains: "interview", node_type: "task" },
    ],
  },
  {
    id: "bd-03",
    input: "Reading Atomic Habits. Key idea: systems beat goals. Apply this to my workout routine.",
    expected_nodes: [
      { title_contains: "Atomic Habits", node_type: "concept" },
      { title_contains: "workout", node_type: "task" },
    ],
  },
  {
    id: "bd-04",
    input: "Clinical Ops Copilot needs a better onboarding flow. The current one loses users at step 3. Also need to write docs for the API.",
    expected_nodes: [
      { title_contains: "onboarding", node_type: "task" },
      { title_contains: "API", node_type: "task" },
    ],
  },
  {
    id: "bd-05",
    input: "Thinking about building a SaaS for freelance ML engineers. Core features: project matching, rate calculator, contract templates.",
    expected_nodes: [
      { title_contains: "SaaS", node_type: "project" },
      { title_contains: "project matching", node_type: "task" },
      { title_contains: "rate", node_type: "task" },
      { title_contains: "contract", node_type: "task" },
    ],
  },
  {
    id: "bd-06",
    input: "Weekly review: completed the auth module, still blocked on payment gateway, need to schedule 1:1 with the team.",
    expected_nodes: [
      { title_contains: "auth", node_type: "task" },
      { title_contains: "payment", node_type: "task" },
      { title_contains: "1:1", node_type: "task" },
    ],
  },
  {
    id: "bd-07",
    input: "Need to revisit the Stats 302 notes on regression before working on the ML project proposal.",
    expected_nodes: [
      { title_contains: "Stats 302", node_type: "class" },
      { title_contains: "regression", node_type: "task" },
      { title_contains: "proposal", node_type: "project" },
    ],
    expected_links: [
      {
        source_title_contains: "regression",
        target_title_contains: "Stats 302",
        edge_types: ["belongs_to"],
      },
      {
        source_title_contains: "Stats 302",
        target_title_contains: "proposal",
        edge_types: ["useful_for", "supports", "prerequisite_for"],
      },
    ],
  },
  {
    id: "bd-08",
    input:
      "brain dump for the week: stats homework chapter 7 problems due thursday. ML project — need to decide between climate dataset or the healthcare one, climate seems more interesting but healthcare has cleaner data. should ask prof martinez which is more feasible for the timeline. random idea: what if I built a tool that visualizes how all my coursework connects together, like a graph of prerequisites and skills? could be a cool side project. goals for this semester: get into the honors program, finish thesis proposal, learn pytorch. the pytorch thing is blocked until I finish the linear algebra review. also I keep forgetting to submit the IRB form for the survey study, that's been on my list for three weeks. need to book a room for the study group tuesday. and I should really start the grad school application essays, deadlines are in december",
    expected_nodes: [
      { title_contains: "stat", node_type: "class" },
      { title_contains: "chapter 7", node_type: "task" },
      { title_contains: "ML", node_type: "project" },
      { title_contains: "semester", node_type: "goal" },
      { title_contains: "survey", node_type: "project" },
    ],
    expected_links: [
      {
        source_title_contains: "chapter 7",
        target_title_contains: "stat",
        edge_types: ["belongs_to"],
      },
      {
        source_title_contains: "linear algebra",
        target_title_contains: "pytorch",
        edge_types: ["required_for", "prerequisite_for"],
      },
      {
        source_title_contains: "thesis",
        target_title_contains: "honors",
        edge_types: ["supports", "useful_for"],
      },
      {
        source_title_contains: "IRB",
        target_title_contains: "survey",
        edge_types: ["required_for", "belongs_to"],
      },
    ],
  },
  {
    id: "bd-09",
    input:
      "Under student errands I need to renew my parking pass, update my student ID, and pay the tuition installment.",
    expected_nodes: [
      { title_contains: "Student Errands", node_type: "concept" },
      { title_contains: "parking pass", node_type: "task" },
      { title_contains: "student ID", node_type: "task" },
      { title_contains: "tuition", node_type: "task" },
    ],
    expected_links: [
      {
        source_title_contains: "parking pass",
        target_title_contains: "Student Errands",
        edge_types: ["belongs_to"],
      },
      {
        source_title_contains: "student ID",
        target_title_contains: "Student Errands",
        edge_types: ["belongs_to"],
      },
      {
        source_title_contains: "tuition",
        target_title_contains: "Student Errands",
        edge_types: ["belongs_to"],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Edge inference fixtures
// ---------------------------------------------------------------------------

export const EDGE_FIXTURES: EdgeFixture[] = [
  {
    id: "edge-01",
    source_title: "Learn Neural Networks",
    source_summary: "Study neural network fundamentals including backpropagation and architectures.",
    target_title: "ML Internship Interview",
    target_summary: "Upcoming interview for a machine learning internship role.",
    expected_related: true,
    expected_edge_type: "useful_for",
  },
  {
    id: "edge-02",
    source_title: "Linear Algebra",
    source_summary: "Mathematical foundation including vectors, matrices, and transformations.",
    target_title: "Learn Neural Networks",
    target_summary: "Study neural network fundamentals.",
    expected_related: true,
    expected_edge_type: "prerequisite_for",
  },
  {
    id: "edge-03",
    source_title: "Stripe Integration",
    source_summary: "Implement payment processing using the Stripe API.",
    target_title: "Neurolight",
    target_summary: "AI-powered productivity app for knowledge workers.",
    expected_related: true,
    expected_edge_type: "belongs_to",
  },
  {
    id: "edge-04",
    source_title: "Atomic Habits",
    source_summary: "Book about building good habits through systems rather than goals.",
    target_title: "Workout Routine",
    target_summary: "Regular exercise schedule and fitness goals.",
    expected_related: true,
    expected_edge_type: "supports",
  },
  {
    id: "edge-05",
    source_title: "Landing Page",
    source_summary: "Marketing page for a SaaS product.",
    target_title: "Linear Algebra",
    target_summary: "Mathematical foundation for ML.",
    expected_related: false,
  },
  {
    id: "edge-06",
    source_title: "ML Internship Preparation",
    source_summary: "Project covering all prep work for an ML internship.",
    target_title: "ML Internship Interview",
    target_summary: "The specific interview event.",
    expected_related: true,
    expected_edge_type: "belongs_to",
  },
  {
    id: "edge-07",
    source_title: "API Documentation",
    source_summary: "Writing technical docs for the REST API endpoints.",
    target_title: "Clinical Ops Copilot",
    target_summary: "AI assistant for clinical operations teams.",
    expected_related: true,
    expected_edge_type: "belongs_to",
  },
  {
    id: "edge-08",
    source_title: "Renew Student Parking Pass",
    source_summary: "Administrative errand before the current permit expires.",
    target_title: "Data Science Club Presentation Slides",
    target_summary: "Slides for an upcoming student presentation next month.",
    expected_related: false,
  },
];

// ---------------------------------------------------------------------------
// Assistant fixtures — Phase 9.3
// ---------------------------------------------------------------------------

export const ASSISTANT_FIXTURES: AssistantFixture[] = [
  {
    id: "asst-01",
    mode: "explain",
    message: "Why is the ML project connected to Linear Algebra?",
    context: `Selected node: ML Project — Building a machine learning model for climate prediction.
Connected nodes:
- Linear Algebra (concept) — Mathematical foundation including vectors, matrices, and transformations. Edge: prerequisite_for, confidence 0.85.
- Climate Dataset (concept) — Historical weather data from NOAA. Edge: belongs_to, confidence 0.9.
Workspace: 12 nodes, 8 edges.`,
    scope: "node:ml-project",
    answer_must_contain: ["linear algebra", "ml"],
    answer_must_not_contain: ["as an AI", "I'd be happy to"],
  },
  {
    id: "asst-02",
    mode: "explain",
    message: "What should I focus on?",
    context: `Workspace overview: 3 active goals, 8 active tasks, 4 concepts.
Top nodes by importance:
- Finish Thesis Proposal (task, score 82)
- Learn PyTorch (goal, score 71)
- Submit IRB Form (task, score 68)
- Stats 302 Homework (task, score 65)
Recently completed: Auth Module (2 days ago).`,
    scope: "workspace",
    answer_must_contain: ["thesis"],
    answer_must_not_contain: ["as an AI", "generally speaking"],
  },
  {
    id: "asst-03",
    mode: "plan",
    message: "What order should I tackle my tasks in?",
    context: `Active tasks:
- Submit IRB Form (task, score 68) — blocked by: nothing
- Linear Algebra Review (task, score 58) — blocks: Learn PyTorch
- Learn PyTorch (goal, score 71) — blocked by: Linear Algebra Review
- Stats Homework Ch7 (task, score 65) — due Thursday
Dependencies: Linear Algebra Review prerequisite_for Learn PyTorch.`,
    scope: "workspace",
    answer_must_contain: ["linear algebra"],
  },
  {
    id: "asst-04",
    mode: "transform",
    message: "How can I improve my graph structure?",
    context: `Workspace overview: 15 nodes, 6 edges.
Issues detected:
- 5 orphan nodes (no edges): "Random Thought", "Meeting Notes", "Book List", "Gym Schedule", "Budget Tracker"
- 1 node with 8 children: "Life Goals"
Top nodes: Finish Thesis (82), Career Plan (75), Health Routine (60).`,
    scope: "workspace",
    answer_must_contain: ["orphan"],
  },
  {
    id: "asst-05",
    mode: "explain",
    message: "Tell me about productivity tips",
    context: `No relevant nodes found in workspace.
Workspace overview: 0 nodes, 0 edges.`,
    scope: "workspace",
    // Should acknowledge lack of context, not give generic advice
    answer_must_contain: [],
    answer_must_not_contain: ["pomodoro", "time management", "here are some tips"],
  },
];

// ---------------------------------------------------------------------------
// Planner fixtures — Phase 9.4
// ---------------------------------------------------------------------------

export const PLANNER_FIXTURES: PlannerFixture[] = [
  {
    id: "plan-01",
    planning_window: "2h",
    total_minutes: 120,
    candidate_nodes: [
      { id: "p1", title: "Stats 302 Homework Ch7", summary: "Problem set due Thursday", node_type: "task" },
      { id: "p2", title: "Linear Algebra Review", summary: "Review vectors and matrices for ML prep", node_type: "task" },
      { id: "p3", title: "Submit IRB Form", summary: "Ethics review form for survey study, overdue", node_type: "task" },
      { id: "p4", title: "ML Project Dataset Selection", summary: "Choose between climate and healthcare datasets", node_type: "task" },
    ],
    min_blocks: 4,
    expected_block_titles: ["stats", "irb"],
    expect_break: true,
    expect_buffer: true,
  },
  {
    id: "plan-02",
    planning_window: "1h",
    total_minutes: 60,
    candidate_nodes: [
      { id: "p5", title: "Fix Landing Page CTA", summary: "The call-to-action button needs better copy", node_type: "task" },
      { id: "p6", title: "Stripe Webhook Setup", summary: "Handle payment success/failure events", node_type: "task" },
    ],
    min_blocks: 2,
    expected_block_titles: ["landing", "stripe"],
    expect_break: false,
    expect_buffer: true,
  },
  {
    id: "plan-03",
    planning_window: "day",
    total_minutes: 480,
    candidate_nodes: [
      { id: "p7", title: "Thesis Chapter 2 Draft", summary: "Literature review section", node_type: "task" },
      { id: "p8", title: "TA Office Hours Prep", summary: "Prepare materials for Stats 101 section", node_type: "task" },
      { id: "p9", title: "Gym Session", summary: "Leg day workout", node_type: "task" },
      { id: "p10", title: "Grad School App Essays", summary: "First draft of personal statement", node_type: "task" },
      { id: "p11", title: "Reply to Prof Martinez", summary: "Email about dataset feasibility", node_type: "task" },
      { id: "p12", title: "Review PR for Lab Project", summary: "Code review for teammate's data pipeline changes", node_type: "task" },
    ],
    min_blocks: 8,
    expected_block_titles: ["thesis", "office hours"],
    expect_break: true,
    expect_buffer: true,
  },
];
