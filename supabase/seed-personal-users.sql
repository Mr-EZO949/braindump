do $$
declare
  target_user_id uuid := '1781935f-fbbb-48bb-86ed-bd1ba21de9d6';
  personal_workspace_id uuid;
begin
  create table if not exists public.workspaces (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now(),
    unique (user_id, name)
  );

  alter table public.nodes
  add column if not exists importance_index integer;

  alter table public.nodes
  add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

  alter table public.edges
  add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

  insert into public.workspaces (user_id, name)
  values (target_user_id, 'Personal')
  on conflict (user_id, name) do nothing;

  select id
  into personal_workspace_id
  from public.workspaces
  where user_id = target_user_id
    and name = 'Personal';

  create temporary table temp_seed_nodes_student (
    slug text primary key,
    id uuid not null default gen_random_uuid()
  ) on commit drop;

  insert into temp_seed_nodes_student (slug)
  values
    ('personal_freedom'),
    ('money_independence'),
    ('startups'),
    ('income_paths'),
    ('skills_stack'),
    ('academics'),
    ('personal_systems'),
    ('neurolight'),
    ('workflow_studio'),
    ('clinical_ops_copilot'),
    ('freelance_ml_systems'),
    ('ai_automation_agency'),
    ('probability_2'),
    ('computer_vision'),
    ('ml_evaluation'),
    ('data_sources'),
    ('research_notes'),
    ('build_prototype'),
    ('email_professor'),
    ('offer_design'),
    ('outreach_sprint'),
    ('weekly_review'),
    ('sleep_tracking'),
    ('meal_prep_loop');

  delete from public.edges
  where user_id = target_user_id
    and workspace_id = personal_workspace_id;

  delete from public.nodes
  where user_id = target_user_id
    and workspace_id = personal_workspace_id;

  insert into public.nodes (
    id,
    user_id,
    workspace_id,
    title,
    summary,
    raw_text,
    node_type,
    importance,
    importance_index,
    color
  )
  select
    map.id,
    target_user_id,
    personal_workspace_id,
    seed.title,
    seed.summary,
    seed.raw_text,
    seed.node_type,
    seed.importance,
    seed.importance_index,
    seed.color
  from (
    values
      ('personal_freedom', 'Personal Freedom', 'Top-level driver around autonomy, calm decisions, and optionality.', 'Build enough leverage that work is chosen deliberately instead of being dictated by short-term pressure.', 'goal', 'high', 96, '#d7d0c5'),
      ('money_independence', 'Money Independence', 'Financial independence as the practical route toward freedom.', 'Create resilient income and leverage so projects can be pursued with less fear.', 'goal', 'high', 92, '#d6cec2'),
      ('startups', 'Startups', 'Venture path for asymmetric upside and ownership.', 'Pursue product bets that can create leverage, identity, and upside beyond hourly work.', 'concept', 'high', 84, '#7b5966'),
      ('income_paths', 'Income Paths', 'Cash-flow channels that protect the bigger bets.', 'Balance startup bets with service revenue and lighter products so exploration does not collapse under pressure.', 'concept', 'high', 78, '#825e69'),
      ('skills_stack', 'Skills Stack', 'Compounding abilities that strengthen products and income options.', 'Develop a combined stack of ML systems, product thinking, writing, and technical judgment.', 'concept', 'high', 72, '#4f726e'),
      ('academics', 'Academics', 'Formal study used selectively to feed real projects.', 'Treat academic work as fuel for product and research execution instead of isolated effort.', 'class', 'medium', 68, '#9b7a42'),
      ('personal_systems', 'Personal Systems', 'Life systems that protect attention and execution quality.', 'Keep enough stability in sleep, energy, and review rhythms that harder work can continue.', 'goal', 'medium', 64, '#c7beb2'),
      ('neurolight', 'Neurolight', 'Seizure detection venture combining clinical relevance and technical depth.', 'Build a clinically useful seizure detection product that can become both a company and proof of real capability.', 'project', 'high', 82, '#8d5866'),
      ('workflow_studio', 'Workflow Studio', 'Graph-native workspace product idea.', 'A calmer operating environment for projects, ideas, and AI-assisted work rather than a generic productivity app.', 'project', 'medium', 64, '#8b5664'),
      ('clinical_ops_copilot', 'Clinical Ops Copilot', 'Startup idea around operational tooling for clinical environments.', 'Use clinical workflow pain points as a direction for AI-assisted tooling with operational depth.', 'project', 'medium', 60, '#8a5663'),
      ('freelance_ml_systems', 'Freelance ML Systems', 'Service path around ML systems and decision tooling.', 'Offer high-trust ML systems work as cash flow while longer startup bets compound.', 'project', 'medium', 61, '#865360'),
      ('ai_automation_agency', 'AI Automation Agency', 'Service-business direction built around workflow automation.', 'Package automation, internal tooling, and system design into a cleaner service offer.', 'project', 'medium', 58, '#86535f'),
      ('probability_2', 'Probability 2', 'Probability course for uncertainty and model reasoning.', 'Use formal probability training to improve evaluation and uncertainty handling in ML work.', 'class', 'medium', 56, '#a27f45'),
      ('computer_vision', 'Computer Vision', 'Academic area that supports visual and sensor-based product work.', 'Study perception pipelines and practical computer vision methods that can strengthen future products.', 'class', 'medium', 54, '#a48146'),
      ('ml_evaluation', 'ML Evaluation', 'Evaluation and calibration thinking for model-based products.', 'Track metrics, calibration, and failure modes so model decisions are trustworthy and legible.', 'concept', 'medium', 58, '#567772'),
      ('data_sources', 'Data Sources', 'Candidate datasets and access constraints for Neurolight.', 'Map candidate EEG datasets and what is required to get reliable access.', 'concept', 'low', 42, '#4f726e'),
      ('research_notes', 'Research Notes', 'Captured papers, constraints, and observations tied to product decisions.', 'Store literature notes, technical constraints, and open questions so project choices stay grounded.', 'journal', 'low', 38, '#81868d'),
      ('build_prototype', 'Build Prototype', 'Turn the strongest idea into a tangible test quickly.', 'Build a first working version fast enough to generate signal instead of refining assumptions forever.', 'task', 'medium', 53, '#a05b47'),
      ('email_professor', 'Email Professor', 'Ask for targeted guidance on probability and project framing.', 'Send a focused note requesting guidance on the parts of probability that matter most for the project.', 'task', 'low', 31, '#a05b47'),
      ('offer_design', 'Offer Design', 'Define a productized automation offer before outreach.', 'Shape the scope, value proposition, and price logic of the automation agency before selling it.', 'concept', 'low', 40, '#54716c'),
      ('outreach_sprint', 'Outreach Sprint', 'Short cycle of outbound tests to validate agency positioning.', 'Run a focused outreach window to test whether the service offer is legible and desirable.', 'task', 'medium', 45, '#a05b47'),
      ('weekly_review', 'Weekly Review', 'Review loop to keep priorities legible and prevent drift.', 'Use a lightweight weekly review to reconnect tasks, projects, and goals before entropy builds.', 'task', 'medium', 47, '#a05b47'),
      ('sleep_tracking', 'Sleep Tracking', 'Simple tracking to stabilize attention and recovery.', 'Keep enough signal on sleep consistency to notice drift before it hits work quality.', 'task', 'low', 29, '#a05b47'),
      ('meal_prep_loop', 'Meal Prep Loop', 'Low-friction nutrition routine to reduce daily decision cost.', 'Use repeatable meal structure to protect energy for deeper work instead of re-deciding basics every day.', 'task', 'low', 28, '#a05b47')
  ) as seed(slug, title, summary, raw_text, node_type, importance, importance_index, color)
  join temp_seed_nodes_student map using (slug);

  insert into public.edges (
    id,
    user_id,
    workspace_id,
    source_node_id,
    target_node_id,
    edge_type
  )
  select
    gen_random_uuid(),
    target_user_id,
    personal_workspace_id,
    source_map.id,
    target_map.id,
    seed.edge_type
  from (
    values
      ('money_independence', 'personal_freedom', 'belongs_to'),
      ('startups', 'money_independence', 'belongs_to'),
      ('income_paths', 'money_independence', 'belongs_to'),
      ('skills_stack', 'money_independence', 'belongs_to'),
      ('academics', 'money_independence', 'belongs_to'),
      ('personal_systems', 'personal_freedom', 'belongs_to'),
      ('neurolight', 'startups', 'belongs_to'),
      ('workflow_studio', 'startups', 'belongs_to'),
      ('clinical_ops_copilot', 'startups', 'belongs_to'),
      ('freelance_ml_systems', 'income_paths', 'belongs_to'),
      ('ai_automation_agency', 'income_paths', 'belongs_to'),
      ('probability_2', 'academics', 'belongs_to'),
      ('computer_vision', 'academics', 'belongs_to'),
      ('ml_evaluation', 'skills_stack', 'belongs_to'),
      ('data_sources', 'neurolight', 'belongs_to'),
      ('research_notes', 'neurolight', 'belongs_to'),
      ('build_prototype', 'neurolight', 'belongs_to'),
      ('email_professor', 'neurolight', 'belongs_to'),
      ('offer_design', 'ai_automation_agency', 'belongs_to'),
      ('outreach_sprint', 'ai_automation_agency', 'belongs_to'),
      ('weekly_review', 'personal_systems', 'belongs_to'),
      ('sleep_tracking', 'personal_systems', 'belongs_to'),
      ('meal_prep_loop', 'personal_systems', 'belongs_to'),
      ('probability_2', 'ml_evaluation', 'required_for'),
      ('data_sources', 'neurolight', 'required_for'),
      ('ml_evaluation', 'neurolight', 'supports'),
      ('computer_vision', 'neurolight', 'supports'),
      ('offer_design', 'outreach_sprint', 'required_for'),
      ('weekly_review', 'build_prototype', 'supports'),
      ('workflow_studio', 'neurolight', 'related_to')
  ) as seed(source_slug, target_slug, edge_type)
  join temp_seed_nodes_student source_map
    on source_map.slug = seed.source_slug
  join temp_seed_nodes_student target_map
    on target_map.slug = seed.target_slug;
end $$;

do $$
declare
  target_user_id uuid := 'ab428e62-f13f-4de3-bfc5-228d70653626';
  personal_workspace_id uuid;
begin
  create table if not exists public.workspaces (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now(),
    unique (user_id, name)
  );

  alter table public.nodes
  add column if not exists importance_index integer;

  alter table public.nodes
  add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

  alter table public.edges
  add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

  insert into public.workspaces (user_id, name)
  values (target_user_id, 'Personal')
  on conflict (user_id, name) do nothing;

  select id
  into personal_workspace_id
  from public.workspaces
  where user_id = target_user_id
    and name = 'Personal';

  create temporary table temp_seed_nodes_teacher (
    slug text primary key,
    id uuid not null default gen_random_uuid()
  ) on commit drop;

  insert into temp_seed_nodes_teacher (slug)
  values
    ('student_growth'),
    ('classroom_clarity'),
    ('teaching_systems'),
    ('student_tracking'),
    ('intervention_queue'),
    ('algebra_section'),
    ('writing_seminar'),
    ('maya_chen'),
    ('luca_romero'),
    ('noah_kim'),
    ('fractions_gap'),
    ('essay_structure'),
    ('attendance_watch'),
    ('quiz_retake_plan'),
    ('office_hours_check_in'),
    ('parent_follow_up'),
    ('progress_note_update'),
    ('weekly_planning'),
    ('reading_support'),
    ('rubric_refresh'),
    ('conference_notes'),
    ('project_feedback_loop');

  delete from public.edges
  where user_id = target_user_id
    and workspace_id = personal_workspace_id;

  delete from public.nodes
  where user_id = target_user_id
    and workspace_id = personal_workspace_id;

  insert into public.nodes (
    id,
    user_id,
    workspace_id,
    title,
    summary,
    raw_text,
    node_type,
    importance,
    importance_index,
    color
  )
  select
    map.id,
    target_user_id,
    personal_workspace_id,
    seed.title,
    seed.summary,
    seed.raw_text,
    seed.node_type,
    seed.importance,
    seed.importance_index,
    seed.color
  from (
    values
      ('student_growth', 'Student Growth', 'Top-level goal around steady academic growth across students.', 'Keep the graph centered on what each student is learning, not just on task completion and admin noise.', 'goal', 'high', 94, '#d7d0c5'),
      ('classroom_clarity', 'Classroom Clarity', 'Clear class-level expectations, pacing, and topic visibility.', 'Track the major class branches so student-level support can connect to something concrete.', 'goal', 'high', 86, '#d4cdc2'),
      ('teaching_systems', 'Teaching Systems', 'Routines and templates that keep tracking sustainable.', 'Use a few repeatable systems so student follow-up stays accurate without becoming overwhelming.', 'concept', 'high', 78, '#667581'),
      ('student_tracking', 'Student Tracking', 'Active tracking of student progress and current status.', 'Keep each student branch legible enough to know who needs help and why.', 'concept', 'high', 80, '#6a7680'),
      ('intervention_queue', 'Intervention Queue', 'Focused next-step actions for students who need support.', 'Convert vague concern into concrete next actions and follow-ups.', 'concept', 'high', 74, '#8a5562'),
      ('algebra_section', 'Algebra Section', 'Math class branch with topic-specific support needs.', 'Track who is missing prerequisite understanding before later units pile on top.', 'class', 'medium', 67, '#9b7a42'),
      ('writing_seminar', 'Writing Seminar', 'Writing course branch with structure, feedback, and revision loops.', 'Keep writing progress tied to concrete skills and feedback routines.', 'class', 'medium', 65, '#977a4b'),
      ('maya_chen', 'Maya Chen', 'Student branch with a math support need.', 'Needs cleaner tracking around fractions and confidence in class participation.', 'concept', 'medium', 64, '#6b7580'),
      ('luca_romero', 'Luca Romero', 'Student branch with a writing support need.', 'Needs stronger essay structure and clearer revision checkpoints.', 'concept', 'medium', 61, '#69737d'),
      ('noah_kim', 'Noah Kim', 'Student branch with attendance and consistency concerns.', 'Needs early intervention before missed sessions turn into a broader performance issue.', 'concept', 'medium', 57, '#67717a'),
      ('fractions_gap', 'Fractions Gap', 'Foundational math weakness blocking later work.', 'This topic is upstream of current algebra confusion and should be addressed directly.', 'concept', 'medium', 48, '#64707a'),
      ('essay_structure', 'Essay Structure', 'Weakness in thesis, paragraph flow, and revision quality.', 'This is the clearest topic-level issue in the writing branch right now.', 'concept', 'medium', 46, '#64707a'),
      ('attendance_watch', 'Attendance Watch', 'Pattern of missed classes or inconsistent presence.', 'Needs active tracking before it becomes a larger academic or behavioral problem.', 'concept', 'low', 43, '#64707a'),
      ('quiz_retake_plan', 'Quiz Retake Plan', 'Concrete recovery plan after a weak quiz result.', 'Turn concern into a clear retake path with timeline and support.', 'task', 'medium', 52, '#a05b47'),
      ('office_hours_check_in', 'Office Hours Check-In', 'Short one-on-one meeting to unblock the next step.', 'Use office hours strategically to get one branch moving again.', 'task', 'medium', 49, '#a05b47'),
      ('parent_follow_up', 'Parent Follow-Up', 'Contact parent or guardian when a support loop needs reinforcement.', 'Keep outreach short, factual, and tied to one or two concrete next actions.', 'task', 'low', 44, '#a05b47'),
      ('progress_note_update', 'Progress Note Update', 'Record the latest meaningful change in a student branch.', 'Keep notes current so interventions and patterns are grounded in evidence.', 'task', 'low', 41, '#a05b47'),
      ('weekly_planning', 'Weekly Planning', 'Short weekly pass through students, topics, and intervention queue.', 'Reset the week so teacher attention is allocated deliberately.', 'task', 'medium', 45, '#a05b47'),
      ('reading_support', 'Reading Support', 'Supporting branch for comprehension and assignment interpretation.', 'Useful support layer when writing or class participation issues are partly reading-driven.', 'concept', 'medium', 50, '#68747f'),
      ('rubric_refresh', 'Rubric Refresh', 'Light update of the rubric so feedback is clearer and more consistent.', 'Tighten the rubric so students and teacher share the same expectations.', 'task', 'low', 39, '#a05b47'),
      ('conference_notes', 'Conference Notes', 'Captured observations from quick student conversations.', 'Keep a compact record of what was discussed and what to check next.', 'journal', 'low', 35, '#81868d'),
      ('project_feedback_loop', 'Project Feedback Loop', 'System for tracking recurring strengths and misses in project work.', 'Use recurring feedback patterns to make later student support faster and less ad hoc.', 'concept', 'medium', 47, '#69737d')
  ) as seed(slug, title, summary, raw_text, node_type, importance, importance_index, color)
  join temp_seed_nodes_teacher map using (slug);

  insert into public.edges (
    id,
    user_id,
    workspace_id,
    source_node_id,
    target_node_id,
    edge_type
  )
  select
    gen_random_uuid(),
    target_user_id,
    personal_workspace_id,
    source_map.id,
    target_map.id,
    seed.edge_type
  from (
    values
      ('student_tracking', 'student_growth', 'belongs_to'),
      ('intervention_queue', 'student_growth', 'belongs_to'),
      ('classroom_clarity', 'student_growth', 'belongs_to'),
      ('teaching_systems', 'classroom_clarity', 'belongs_to'),
      ('algebra_section', 'classroom_clarity', 'belongs_to'),
      ('writing_seminar', 'classroom_clarity', 'belongs_to'),
      ('maya_chen', 'student_tracking', 'belongs_to'),
      ('luca_romero', 'student_tracking', 'belongs_to'),
      ('noah_kim', 'student_tracking', 'belongs_to'),
      ('fractions_gap', 'maya_chen', 'belongs_to'),
      ('essay_structure', 'luca_romero', 'belongs_to'),
      ('attendance_watch', 'noah_kim', 'belongs_to'),
      ('quiz_retake_plan', 'intervention_queue', 'belongs_to'),
      ('office_hours_check_in', 'intervention_queue', 'belongs_to'),
      ('parent_follow_up', 'intervention_queue', 'belongs_to'),
      ('progress_note_update', 'teaching_systems', 'belongs_to'),
      ('weekly_planning', 'teaching_systems', 'belongs_to'),
      ('reading_support', 'writing_seminar', 'belongs_to'),
      ('rubric_refresh', 'writing_seminar', 'belongs_to'),
      ('conference_notes', 'teaching_systems', 'belongs_to'),
      ('project_feedback_loop', 'teaching_systems', 'belongs_to'),
      ('fractions_gap', 'quiz_retake_plan', 'required_for'),
      ('essay_structure', 'office_hours_check_in', 'supports'),
      ('attendance_watch', 'parent_follow_up', 'required_for'),
      ('progress_note_update', 'parent_follow_up', 'supports'),
      ('weekly_planning', 'quiz_retake_plan', 'supports'),
      ('reading_support', 'luca_romero', 'supports'),
      ('conference_notes', 'progress_note_update', 'supports'),
      ('project_feedback_loop', 'rubric_refresh', 'related_to')
  ) as seed(source_slug, target_slug, edge_type)
  join temp_seed_nodes_teacher source_map
    on source_map.slug = seed.source_slug
  join temp_seed_nodes_teacher target_map
    on target_map.slug = seed.target_slug;
end $$;
