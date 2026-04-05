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

export interface MergeFixture {
  id: string;
  node_a_title: string;
  node_a_summary: string | null;
  node_a_type: string;
  node_b_title: string;
  node_b_summary: string | null;
  node_b_type: string;
  /** Cosine similarity hint passed to the merge-check prompt (0–1). */
  similarity: number;
  expected_same_entity: boolean;
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
  // --- 16 new fixtures (Phase 15) ---
  {
    id: "bd-10",
    input: "Need to track my monthly spending. Categories: rent, groceries, subscriptions. Goal is to save 20% of my income by year end.",
    expected_nodes: [
      { title_contains: "budget", node_type: "project" },
      { title_contains: "subscriptions", node_type: "task" },
      { title_contains: "save", node_type: "goal" },
    ],
  },
  {
    id: "bd-11",
    input: "Preparing for a Google software engineering interview. Need to study dynamic programming, system design principles, and behavioral questions. Also need to refresh my data structures knowledge.",
    expected_nodes: [
      { title_contains: "interview", node_type: "goal" },
      { title_contains: "dynamic programming", node_type: "task" },
      { title_contains: "system design", node_type: "task" },
      { title_contains: "data structures", node_type: "task" },
    ],
  },
  {
    id: "bd-12",
    input: "Building an AI scheduling assistant for remote teams. Core features: calendar sync, conflict detection, smart rescheduling. Backend in FastAPI, frontend in Next.js. Need to nail the MVP scope first.",
    expected_nodes: [
      { title_contains: "scheduling", node_type: "project" },
      { title_contains: "calendar sync", node_type: "task" },
      { title_contains: "conflict detection", node_type: "task" },
    ],
    expected_links: [
      {
        source_title_contains: "calendar sync",
        target_title_contains: "scheduling",
        edge_types: ["belongs_to"],
      },
    ],
  },
  {
    id: "bd-13",
    input: "Dissertation progress: chapter 1 is drafted, chapter 2 needs a full literature review, need to schedule my next advisor meeting. Defending in Spring 2027.",
    expected_nodes: [
      { title_contains: "dissertation", node_type: "project" },
      { title_contains: "literature review", node_type: "task" },
      { title_contains: "advisor", node_type: "task" },
    ],
  },
  {
    id: "bd-14",
    input: "Kitchen renovation plan: demo the old cabinets, then install new plumbing, add tile backsplash. Need to pull permits before any of the demo work starts.",
    expected_nodes: [
      { title_contains: "renovation", node_type: "project" },
      { title_contains: "permit", node_type: "task" },
      { title_contains: "plumbing", node_type: "task" },
      { title_contains: "cabinet", node_type: "task" },
    ],
    expected_links: [
      {
        source_title_contains: "permit",
        target_title_contains: "cabinet",
        edge_types: ["prerequisite_for", "blocks"],
      },
    ],
  },
  {
    id: "bd-15",
    input: "Learning Spanish for a trip to Argentina in March. Daily Duolingo practice, watch Spanish Netflix shows, find a language exchange partner on Tandem.",
    expected_nodes: [
      { title_contains: "Spanish", node_type: "goal" },
      { title_contains: "Duolingo", node_type: "task" },
      { title_contains: "language exchange", node_type: "task" },
    ],
  },
  {
    id: "bd-16",
    input: "Starting a tech podcast. Need to buy a microphone, set up recording software, brainstorm topics for the first 3 episodes, and find intro music.",
    expected_nodes: [
      { title_contains: "podcast", node_type: "project" },
      { title_contains: "microphone", node_type: "task" },
      { title_contains: "episode", node_type: "task" },
    ],
  },
  {
    id: "bd-17",
    input: "Freelance project for a Shopify client: redesign the checkout flow and integrate a loyalty rewards program. Need to send the proposal first. Deadline is end of month.",
    expected_nodes: [
      { title_contains: "checkout", node_type: "project" },
      { title_contains: "loyalty", node_type: "task" },
      { title_contains: "proposal", node_type: "task" },
    ],
    expected_links: [
      {
        source_title_contains: "proposal",
        target_title_contains: "checkout",
        edge_types: ["prerequisite_for", "blocks"],
      },
    ],
  },
  {
    id: "bd-18",
    input: "Found a bug in NextAuth.js — the OAuth refresh token flow breaks after token expiry. Steps: reproduce consistently, write a failing test, fix the logic, open a PR.",
    expected_nodes: [
      { title_contains: "NextAuth", node_type: "project" },
      { title_contains: "failing test", node_type: "task" },
      { title_contains: "PR", node_type: "task" },
    ],
  },
  {
    id: "bd-19",
    input: "Planning a trip to Japan in April. Need to book flights and hotels in Tokyo and Kyoto, get a JR Pass, and learn some basic Japanese before I go.",
    expected_nodes: [
      { title_contains: "Japan", node_type: "project" },
      { title_contains: "flight", node_type: "task" },
      { title_contains: "hotel", node_type: "task" },
      { title_contains: "Japanese", node_type: "goal" },
    ],
  },
  {
    id: "bd-20",
    input: "Health goals: run a 5K in under 30 minutes. Following the Couch to 5K program, 3 days per week. Also trying to sleep better by cutting screen time after 10pm.",
    expected_nodes: [
      { title_contains: "5K", node_type: "goal" },
      { title_contains: "Couch to 5K", node_type: "task" },
      { title_contains: "screen time", node_type: "task" },
    ],
  },
  {
    id: "bd-21",
    input: "Giving a talk at ReactConf on server components. Outline: problem statement, how server components work, live demo, migration tips. Slides need to be done by Friday.",
    expected_nodes: [
      { title_contains: "ReactConf", node_type: "project" },
      { title_contains: "server components", node_type: "concept" },
      { title_contains: "slides", node_type: "task" },
      { title_contains: "demo", node_type: "task" },
    ],
  },
  {
    id: "bd-22",
    input: "Writing a research paper on distributed consensus algorithms. Sections: intro, related work, our approach, experiments, conclusion. Submitting to OSDI 2027.",
    expected_nodes: [
      { title_contains: "consensus", node_type: "project" },
      { title_contains: "related work", node_type: "task" },
      { title_contains: "experiments", node_type: "task" },
    ],
  },
  {
    id: "bd-23",
    input: "Q2 product roadmap: Auth team builds SSO support, Platform team ships API v2, Growth team runs an A/B test on the onboarding funnel. All streams due end of June.",
    expected_nodes: [
      { title_contains: "SSO", node_type: "task" },
      { title_contains: "API v2", node_type: "task" },
      { title_contains: "A/B test", node_type: "task" },
    ],
  },
  {
    id: "bd-24",
    input: "Mobile app launch checklist: App Store screenshots, write a privacy policy, test push notifications, set up crash reporting with Sentry, recruit beta testers.",
    expected_nodes: [
      { title_contains: "launch", node_type: "project" },
      { title_contains: "privacy policy", node_type: "task" },
      { title_contains: "crash reporting", node_type: "task" },
      { title_contains: "beta", node_type: "task" },
    ],
  },
  {
    id: "bd-25",
    input: "Reading list for Q2: Designing Data-Intensive Applications, The Staff Engineer's Path, Clean Architecture. Want to apply the learnings to the current backend refactor.",
    expected_nodes: [
      { title_contains: "reading", node_type: "project" },
      { title_contains: "Data-Intensive", node_type: "concept" },
      { title_contains: "Staff Engineer", node_type: "concept" },
    ],
    expected_links: [
      {
        source_title_contains: "Data-Intensive",
        target_title_contains: "refactor",
        edge_types: ["supports", "useful_for"],
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
  // Phase 15 additions
  {
    id: "edge-09",
    source_title: "Thesis Proposal",
    source_summary: "A formal document outlining the research plan and contributions for a PhD thesis.",
    target_title: "Grad School Application",
    target_summary: "Applying to PhD programs; requires statement of purpose and writing samples.",
    expected_related: true,
    expected_edge_type: "supports",
  },
  {
    id: "edge-10",
    source_title: "TypeScript Fundamentals",
    source_summary: "Learning TypeScript types, interfaces, and generics.",
    target_title: "React Native Project",
    target_summary: "Building a cross-platform mobile app using React Native and Expo.",
    expected_related: true,
    expected_edge_type: "supports",
  },
  {
    id: "edge-11",
    source_title: "Buy Groceries",
    source_summary: "Weekly grocery run for household supplies.",
    target_title: "Kubernetes Cluster Setup",
    target_summary: "Deploying a multi-node Kubernetes cluster for the production environment.",
    expected_related: false,
  },
  {
    id: "edge-12",
    source_title: "Write API Documentation",
    source_summary: "Document all REST endpoints with request/response schemas and authentication details.",
    target_title: "Ship API v2",
    target_summary: "Public release of the v2 API with breaking changes and new authentication flow.",
    expected_related: true,
    expected_edge_type: "prerequisite_for",
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
  // Phase 15 additions
  {
    id: "plan-04",
    planning_window: "1h",
    total_minutes: 60,
    candidate_nodes: [
      { id: "p13", title: "Fix OAuth Refresh Bug", summary: "Reproduce and patch the token refresh failure in NextAuth.js", node_type: "task" },
      { id: "p14", title: "Write Failing Test", summary: "Add a regression test that demonstrates the OAuth bug", node_type: "task" },
    ],
    min_blocks: 2,
    expected_block_titles: ["oauth", "test"],
    expect_break: false,
    expect_buffer: true,
  },
  {
    id: "plan-05",
    planning_window: "2h",
    total_minutes: 120,
    candidate_nodes: [
      { id: "p15", title: "ReactConf Slides", summary: "Build slide deck for server components talk", node_type: "task" },
      { id: "p16", title: "Live Demo Setup", summary: "Prepare a working code demo for the talk", node_type: "task" },
      { id: "p17", title: "Submit IRB Form", summary: "Ethics review — has been pending for three weeks", node_type: "task" },
      { id: "p18", title: "Reply to Conference Organizers", summary: "Confirm A/V requirements and session length", node_type: "task" },
    ],
    min_blocks: 4,
    expected_block_titles: ["slides", "irb"],
    expect_break: true,
    expect_buffer: true,
  },
];

// ---------------------------------------------------------------------------
// Merge suggestion fixtures — Phase 15
// ---------------------------------------------------------------------------

export const MERGE_FIXTURES: MergeFixture[] = [
  {
    id: "merge-01",
    node_a_title: "Learn React",
    node_a_summary: "Study React concepts and build practice projects.",
    node_a_type: "goal",
    node_b_title: "React.js Study Plan",
    node_b_summary: "Structured plan for learning React including hooks, context, and routing.",
    node_b_type: "project",
    similarity: 0.91,
    expected_same_entity: true,
  },
  {
    id: "merge-02",
    node_a_title: "Financial Independence",
    node_a_summary: "Long-term goal of achieving financial freedom through savings and investments.",
    node_a_type: "goal",
    node_b_title: "SaaS Revenue Goal",
    node_b_summary: "Reach $10k MRR with the BrainDump SaaS product by Q4.",
    node_b_type: "goal",
    similarity: 0.78,
    expected_same_entity: false,
  },
  {
    id: "merge-03",
    node_a_title: "Write API Documentation",
    node_a_summary: "Document all REST endpoints with request/response schemas.",
    node_a_type: "task",
    node_b_title: "API Docs",
    node_b_summary: "Technical reference documentation for the public API.",
    node_b_type: "task",
    similarity: 0.88,
    expected_same_entity: true,
  },
  {
    id: "merge-04",
    node_a_title: "Build Landing Page",
    node_a_summary: "Design and implement the full marketing landing page for the product.",
    node_a_type: "project",
    node_b_title: "Fix Landing Page CTA Button",
    node_b_summary: "The call-to-action button needs better copy and higher contrast styling.",
    node_b_type: "task",
    similarity: 0.82,
    expected_same_entity: false,
  },
  {
    id: "merge-05",
    node_a_title: "ML Project",
    node_a_summary: "Build a machine learning model for climate data prediction.",
    node_a_type: "project",
    node_b_title: "Machine Learning Project",
    node_b_summary: "ML project using historical climate datasets and regression models.",
    node_b_type: "project",
    similarity: 0.95,
    expected_same_entity: true,
  },
  {
    id: "merge-06",
    node_a_title: "Gym Session",
    node_a_summary: "Today's leg day workout at the university gym.",
    node_a_type: "task",
    node_b_title: "Workout Routine",
    node_b_summary: "Ongoing 3-day-per-week fitness schedule to improve strength and endurance.",
    node_b_type: "goal",
    similarity: 0.83,
    expected_same_entity: false,
  },
  {
    id: "merge-07",
    node_a_title: "PhD Dissertation",
    node_a_summary: "The overarching research project culminating in a doctoral thesis.",
    node_a_type: "project",
    node_b_title: "Thesis Writing",
    node_b_summary: "Writing and revising chapters of the doctoral thesis.",
    node_b_type: "task",
    similarity: 0.87,
    expected_same_entity: true,
  },
  {
    id: "merge-08",
    node_a_title: "Renew Parking Permit",
    node_a_summary: "Administrative task to renew university parking pass before it expires.",
    node_a_type: "task",
    node_b_title: "Update Parking Pass",
    node_b_summary: "Renew the campus parking permit via the student portal.",
    node_b_type: "task",
    similarity: 0.89,
    expected_same_entity: true,
  },
  {
    id: "merge-09",
    node_a_title: "Learn PyTorch",
    node_a_summary: "Goal to become proficient in the PyTorch deep learning framework.",
    node_a_type: "goal",
    node_b_title: "PyTorch Tutorial",
    node_b_summary: "Official beginner tutorial covering tensors, autograd, and simple neural nets.",
    node_b_type: "concept",
    similarity: 0.86,
    expected_same_entity: false,
  },
  {
    id: "merge-10",
    node_a_title: "Launch BrainDump Beta",
    node_a_summary: "Public beta release with core graph and AI features enabled for early users.",
    node_a_type: "goal",
    node_b_title: "Ship BrainDump MVP",
    node_b_summary: "Deliver the minimum viable product to the first cohort of beta testers.",
    node_b_type: "task",
    similarity: 0.90,
    expected_same_entity: true,
  },
];
