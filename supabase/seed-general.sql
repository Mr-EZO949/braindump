-- Replace the placeholder UUID below with the auth.users.id you want to seed.
do $$
declare
  target_user_id uuid := '00000000-0000-0000-0000-000000000000';
  general_workspace_id uuid;
begin
  if target_user_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'Replace target_user_id in supabase/seed-general.sql before running it.';
  end if;

  insert into public.workspaces (user_id, name)
  values (target_user_id, 'General')
  on conflict (user_id, name) do nothing;

  select id
  into general_workspace_id
  from public.workspaces
  where user_id = target_user_id
    and name = 'General';

  create temporary table temp_seed_nodes (
    slug text primary key,
    id uuid not null default gen_random_uuid()
  ) on commit drop;

  insert into temp_seed_nodes (slug)
  values
    ('long_term_flexibility'),
    ('financial_stability'),
    ('career_projects'),
    ('coursework'),
    ('skill_growth'),
    ('personal_stability'),
    ('capstone_project'),
    ('student_planner_app'),
    ('internship_search'),
    ('part_time_tutoring'),
    ('systems_thinking'),
    ('statistics_ii'),
    ('research_methods'),
    ('ship_first_prototype'),
    ('contact_advisor'),
    ('resume_rewrite'),
    ('applications_sprint'),
    ('weekly_review'),
    ('sleep_routine'),
    ('meal_prep_loop'),
    ('language_practice'),
    ('practice_prompts'),
    ('exchange_options'),
    ('portfolio_site'),
    ('portfolio_refresh');

  delete from public.edges
  where user_id = target_user_id
    and workspace_id = general_workspace_id;

  delete from public.nodes
  where user_id = target_user_id
    and workspace_id = general_workspace_id;

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
    general_workspace_id,
    seed.title,
    seed.summary,
    seed.raw_text,
    seed.node_type,
    seed.importance,
    seed.importance_index,
    seed.color
  from (
    values
      ('long_term_flexibility', 'Long-Term Flexibility', 'Top-level goal around optionality, steady progress, and less stress about the future.', 'Build enough stability, skills, and momentum that choices after school feel open instead of forced.', 'goal', 'high', 95, '#d8d0c4'),
      ('financial_stability', 'Financial Stability', 'Practical money security that lowers pressure during school and after graduation.', 'Keep income and costs stable enough that bigger academic and career decisions are made from strength.', 'goal', 'high', 88, '#d4ccc0'),
      ('career_projects', 'Career Projects', 'Project work that builds portfolio quality and career proof.', 'Use projects to develop evidence of execution, taste, and technical ability beyond class assignments.', 'concept', 'high', 82, '#7d5b67'),
      ('coursework', 'Coursework', 'Classes and deliverables that still need to support the larger plan.', 'Treat classes as part of the system, not as isolated obligations that compete with everything else.', 'class', 'high', 76, '#9c7c49'),
      ('skill_growth', 'Skill Growth', 'Compounding capabilities that make later projects easier and better.', 'Build technical, communication, and systems skills that keep paying off across semesters.', 'concept', 'high', 73, '#667581'),
      ('personal_stability', 'Personal Stability', 'Enough health and routine to keep output consistent.', 'Protect sleep, planning, and energy so the rest of the graph does not collapse under stress.', 'goal', 'medium', 70, '#d2cbc0'),
      ('capstone_project', 'Capstone Project', 'Main portfolio-quality project for the term.', 'A serious build that can demonstrate technical depth, follow-through, and product sense.', 'project', 'high', 84, '#8b5663'),
      ('student_planner_app', 'Student Planner App', 'Product idea around planning coursework, tasks, and weekly review.', 'A calmer system for balancing classes, deliverables, and self-directed work without getting lost in tools.', 'project', 'medium', 63, '#875360'),
      ('internship_search', 'Internship Search', 'Structured search for internships or summer roles.', 'Turn the search into a repeatable process instead of a vague background worry.', 'project', 'high', 79, '#8a5562'),
      ('part_time_tutoring', 'Part-Time Tutoring', 'Flexible paid work that fits the academic schedule.', 'Use tutoring as predictable income while keeping enough time and attention for classes and projects.', 'project', 'medium', 66, '#83505d'),
      ('systems_thinking', 'Systems Thinking', 'Ability to see structure, dependencies, and tradeoffs across work.', 'Improve the ability to break large efforts into cleaner systems and next actions.', 'concept', 'medium', 60, '#64717c'),
      ('statistics_ii', 'Statistics II', 'Probability and statistics course feeding better project judgment.', 'Use formal stats training to improve experiment design and interpretation.', 'class', 'medium', 59, '#96784d'),
      ('research_methods', 'Research Methods', 'Methods work that improves evaluation and evidence quality.', 'Use stronger framing and evaluation so projects can be defended clearly.', 'class', 'medium', 57, '#94764b'),
      ('ship_first_prototype', 'Ship First Prototype', 'Get to a working first version quickly.', 'Finish a first usable version fast enough to learn from reality instead of endlessly planning.', 'task', 'medium', 52, '#a15b47'),
      ('contact_advisor', 'Contact Advisor', 'Ask for targeted guidance when a branch is blocked or unclear.', 'Use short specific outreach to unblock the next decision instead of staying uncertain for weeks.', 'task', 'low', 30, '#a15b47'),
      ('resume_rewrite', 'Resume Rewrite', 'Refresh resume around stronger evidence and language.', 'Tighten the resume so internship applications reflect the strongest actual work.', 'task', 'medium', 46, '#a15b47'),
      ('applications_sprint', 'Applications Sprint', 'Focused application window instead of constant low-grade searching.', 'Run applications in a tight cycle with clearer targets, materials, and follow-up.', 'task', 'medium', 54, '#a15b47'),
      ('weekly_review', 'Weekly Review', 'Short loop for checking priorities and resetting the week.', 'Use a quick weekly reset so academic deadlines and project work stay visible together.', 'task', 'medium', 47, '#a15b47'),
      ('sleep_routine', 'Sleep Routine', 'Protect sleep consistency enough for stable work.', 'Treat sleep as a foundational system rather than a leftover variable.', 'task', 'low', 31, '#a15b47'),
      ('meal_prep_loop', 'Meal Prep Loop', 'Simple repeatable meals to reduce friction during busy weeks.', 'Reduce daily decision cost so energy is spent on the graph rather than logistics.', 'task', 'low', 29, '#a15b47'),
      ('language_practice', 'Language Practice', 'Separate island around language and exchange options.', 'Keep a side branch alive that expands options later without distracting from the main semester plan.', 'goal', 'low', 40, '#cfc7bb'),
      ('practice_prompts', 'Practice Prompts', 'Small speaking and writing prompts for consistent practice.', 'Use small recurring prompts so this branch stays alive with low effort.', 'task', 'low', 26, '#a15b47'),
      ('exchange_options', 'Exchange Options', 'Research on semester exchange or short study-abroad options.', 'Collect lightweight information without turning this side branch into planning overload.', 'idea', 'low', 28, '#717883'),
      ('portfolio_site', 'Portfolio Site', 'Public-facing home for projects and applications.', 'Use a simple portfolio site as the connective layer between projects and opportunities.', 'project', 'medium', 61, '#84515e'),
      ('portfolio_refresh', 'Portfolio Refresh', 'Update portfolio content and framing based on current work.', 'Keep the portfolio legible enough that strong work is actually visible to other people.', 'task', 'low', 43, '#a15b47')
  ) as seed(slug, title, summary, raw_text, node_type, importance, importance_index, color)
  join temp_seed_nodes map using (slug);

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
    general_workspace_id,
    source_map.id,
    target_map.id,
    seed.edge_type
  from (
    values
      ('financial_stability', 'long_term_flexibility', 'belongs_to'),
      ('career_projects', 'long_term_flexibility', 'belongs_to'),
      ('coursework', 'long_term_flexibility', 'belongs_to'),
      ('skill_growth', 'long_term_flexibility', 'belongs_to'),
      ('personal_stability', 'long_term_flexibility', 'belongs_to'),
      ('capstone_project', 'career_projects', 'belongs_to'),
      ('student_planner_app', 'career_projects', 'belongs_to'),
      ('portfolio_site', 'career_projects', 'belongs_to'),
      ('internship_search', 'financial_stability', 'belongs_to'),
      ('part_time_tutoring', 'financial_stability', 'belongs_to'),
      ('systems_thinking', 'skill_growth', 'belongs_to'),
      ('statistics_ii', 'coursework', 'belongs_to'),
      ('research_methods', 'coursework', 'belongs_to'),
      ('ship_first_prototype', 'capstone_project', 'belongs_to'),
      ('contact_advisor', 'capstone_project', 'belongs_to'),
      ('resume_rewrite', 'internship_search', 'belongs_to'),
      ('applications_sprint', 'internship_search', 'belongs_to'),
      ('weekly_review', 'personal_stability', 'belongs_to'),
      ('sleep_routine', 'personal_stability', 'belongs_to'),
      ('meal_prep_loop', 'personal_stability', 'belongs_to'),
      ('practice_prompts', 'language_practice', 'belongs_to'),
      ('exchange_options', 'language_practice', 'belongs_to'),
      ('portfolio_refresh', 'portfolio_site', 'belongs_to'),
      ('statistics_ii', 'research_methods', 'required_for'),
      ('systems_thinking', 'capstone_project', 'supports'),
      ('research_methods', 'capstone_project', 'supports'),
      ('resume_rewrite', 'applications_sprint', 'required_for'),
      ('weekly_review', 'ship_first_prototype', 'supports'),
      ('portfolio_site', 'internship_search', 'useful_for'),
      ('student_planner_app', 'capstone_project', 'related_to')
  ) as seed(source_slug, target_slug, edge_type)
  join temp_seed_nodes source_map
    on source_map.slug = seed.source_slug
  join temp_seed_nodes target_map
    on target_map.slug = seed.target_slug;
end $$;
