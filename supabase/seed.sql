do $$
declare
  seed_user_id uuid;
begin
  select id
    into seed_user_id
  from auth.users
  order by created_at asc
  limit 1;

  if seed_user_id is null then
    raise exception 'Create at least one auth user before running supabase/seed.sql';
  end if;

  insert into public.nodes (
    id,
    user_id,
    title,
    summary,
    raw_text,
    node_type,
    importance,
    color
  )
  values
    ('10000000-0000-0000-0000-000000000001', seed_user_id, 'Personal Freedom', 'Top-level life driver around autonomy, calm decisions, and optionality.', 'Build enough leverage and control that work is chosen deliberately instead of being dictated by short-term pressure.', 'goal', 'high', '#d7d0c5'),
    ('10000000-0000-0000-0000-000000000002', seed_user_id, 'Money Independence', 'Financial independence as the clearest practical route toward freedom.', 'Create enough resilient income and leverage to self-fund projects, move more freely, and work with less fear.', 'goal', 'high', '#d6cec2'),
    ('10000000-0000-0000-0000-000000000003', seed_user_id, 'Startups', 'Venture path for asymmetric upside and long-term ownership.', 'Pursue product bets that can create leverage, identity, and upside beyond hourly work.', 'concept', 'high', '#7b5966'),
    ('10000000-0000-0000-0000-000000000004', seed_user_id, 'Income Paths', 'Practical cash-flow channels that support bigger bets.', 'Balance startup bets with service revenue and lighter products so financial pressure does not collapse exploration.', 'concept', 'medium', '#825e69'),
    ('10000000-0000-0000-0000-000000000005', seed_user_id, 'Skills Stack', 'Compounding abilities that strengthen products and income options.', 'Develop a combined stack of ML systems, product thinking, writing, and technical judgment.', 'concept', 'medium', '#4f726e'),
    ('10000000-0000-0000-0000-000000000006', seed_user_id, 'Academics', 'Formal study used selectively to feed real projects.', 'Treat academic work as fuel for product and research execution instead of letting it drift into isolated effort.', 'concept', 'medium', '#9b7a42'),
    ('10000000-0000-0000-0000-000000000007', seed_user_id, 'Personal Systems', 'Life systems that protect attention and execution quality.', 'Keep enough stability in sleep, energy, and review rhythms that the harder work can continue.', 'goal', 'medium', '#c7beb2'),
    ('10000000-0000-0000-0000-000000000008', seed_user_id, 'Neurolight', 'Seizure detection venture combining clinical relevance and technical depth.', 'Build a clinically useful seizure detection product that can become both a company and a proof of real capability.', 'project', 'high', '#8d5866'),
    ('10000000-0000-0000-0000-000000000009', seed_user_id, 'Workflow Studio', 'Workspace product idea around planning, thought capture, and graph-native work.', 'A calmer operating environment for projects, ideas, and AI-assisted work rather than a generic productivity app.', 'project', 'medium', '#8b5664'),
    ('10000000-0000-0000-0000-000000000010', seed_user_id, 'Clinical Ops Copilot', 'Startup idea around operational tooling for clinical environments.', 'Use clinical workflow pain points as a direction for AI-assisted tooling with operational depth.', 'project', 'medium', '#8a5663'),
    ('10000000-0000-0000-0000-000000000011', seed_user_id, 'Freelance ML Systems', 'Service path around ML systems and decision tooling.', 'Offer high-trust ML systems work as cash flow while longer startup bets compound.', 'project', 'medium', '#865360'),
    ('10000000-0000-0000-0000-000000000012', seed_user_id, 'AI Automation Agency', 'Service-business direction built around workflow automation and process design.', 'Package automation, internal tooling, and system design into a cleaner service offer for clients.', 'project', 'medium', '#86535f'),
    ('10000000-0000-0000-0000-000000000013', seed_user_id, 'Creator Tool Bundle', 'Smaller paid tools as experiments in product taste and revenue.', 'Ship compact tools for creators and operators to learn pricing, packaging, and distribution.', 'idea', 'low', '#7f4f5a'),
    ('10000000-0000-0000-0000-000000000014', seed_user_id, 'ML Systems Design', 'Designing dependable ML workflows, interfaces, and operational constraints.', 'Understand how to design ML systems that can actually survive contact with messy real usage.', 'concept', 'medium', '#567772'),
    ('10000000-0000-0000-0000-000000000015', seed_user_id, 'Writing Clarity', 'Clear writing as leverage for products, outreach, and positioning.', 'Use clearer writing to make project framing, offers, and decisions legible to other people.', 'concept', 'low', '#54716c'),
    ('10000000-0000-0000-0000-000000000016', seed_user_id, 'Probability 2', 'Probability course for uncertainty, distributions, and model reasoning.', 'Use formal probability training to improve evaluation, uncertainty handling, and reasoning in ML work.', 'class', 'medium', '#a27f45'),
    ('10000000-0000-0000-0000-000000000017', seed_user_id, 'Computer Vision', 'Academic area that supports visual and sensor-based product work.', 'Study perception pipelines and practical computer vision methods that can strengthen future products.', 'class', 'medium', '#a48146'),
    ('10000000-0000-0000-0000-000000000018', seed_user_id, 'ML Evaluation', 'Evaluation, calibration, and decision-quality thinking for model-based products.', 'Track metrics, calibration, and failure modes so model decisions are trustworthy and legible.', 'concept', 'medium', '#567772'),
    ('10000000-0000-0000-0000-000000000019', seed_user_id, 'Data Sources', 'Possible datasets, access constraints, and collection strategy for Neurolight.', 'Map candidate EEG datasets and what is required to get reliable access or substitute collection paths.', 'concept', 'low', '#4f726e'),
    ('10000000-0000-0000-0000-000000000020', seed_user_id, 'Research Notes', 'Captured papers, constraints, and observations tied to product decisions.', 'Store literature notes, technical constraints, and open questions so project choices stay grounded.', 'journal', 'low', '#81868d'),
    ('10000000-0000-0000-0000-000000000021', seed_user_id, 'Build Prototype', 'Turn the strongest idea into a tangible test quickly.', 'Build a first working version fast enough to generate signal instead of endlessly refining assumptions.', 'task', 'medium', '#a05b47'),
    ('10000000-0000-0000-0000-000000000022', seed_user_id, 'Email Professor', 'Ask for targeted guidance on probability and project framing.', 'Send a focused note requesting guidance on the parts of probability that matter most for the project.', 'task', 'low', '#a05b47'),
    ('10000000-0000-0000-0000-000000000023', seed_user_id, 'Paper Ideas', 'Possible writeups or experiment directions around Neurolight.', 'Capture possible publication angles and research directions without letting them dominate product execution.', 'idea', 'low', '#7f4f5a'),
    ('10000000-0000-0000-0000-000000000024', seed_user_id, 'Offer Design', 'Define a productized automation offer before client outreach.', 'Shape the scope, value proposition, and price logic of the automation agency before selling it.', 'concept', 'low', '#54716c'),
    ('10000000-0000-0000-0000-000000000025', seed_user_id, 'Outreach Sprint', 'Short cycle of outbound tests to validate agency positioning.', 'Run a focused outreach window to test whether the service offer is legible and desirable.', 'task', 'low', '#a05b47'),
    ('10000000-0000-0000-0000-000000000026', seed_user_id, 'Health Baseline', 'Base operating stability for energy, cognition, and consistency.', 'Protect the minimum health routines that make ambitious work sustainable instead of volatile.', 'goal', 'low', '#d6cec2'),
    ('10000000-0000-0000-0000-000000000027', seed_user_id, 'Weekly Review', 'Review loop to keep priorities legible and prevent drift.', 'Use a lightweight weekly review to reconnect tasks, projects, and goals before entropy builds.', 'task', 'low', '#a05b47'),
    ('10000000-0000-0000-0000-000000000028', seed_user_id, 'Sleep Tracking', 'Simple tracking to stabilize attention and recovery.', 'Keep enough signal on sleep consistency to notice drift before it hits work quality.', 'task', 'low', '#a05b47'),
    ('10000000-0000-0000-0000-000000000029', seed_user_id, 'Meal Prep Loop', 'Low-friction nutrition routine to reduce daily decision cost.', 'Use repeatable meal structure to protect energy for deeper work instead of re-deciding basics every day.', 'task', 'low', '#a05b47'),
    ('10000000-0000-0000-0000-000000000030', seed_user_id, 'Italian Practice', 'Separate life-direction cluster around language and mobility.', 'Build enough language confidence that location flexibility later feels more realistic and less abstract.', 'goal', 'low', '#d6cec2'),
    ('10000000-0000-0000-0000-000000000031', seed_user_id, 'Conversation Deck', 'Small recurring prompt deck for speaking practice.', 'Use a compact recurring deck of phrases and scenarios to make language practice less fragile.', 'task', 'low', '#a05b47'),
    ('10000000-0000-0000-0000-000000000032', seed_user_id, 'Residency Options', 'Notes on countries, visas, and longer-term living options.', 'Collect lightweight research on residency options without overcommitting before the financial base exists.', 'idea', 'low', '#7f4f5a'),
    ('10000000-0000-0000-0000-000000000033', seed_user_id, 'Writing Habit', 'Standalone writing island for long-form thinking and clarity.', 'Use a consistent writing habit to turn loose thinking into more durable ideas and clearer decisions.', 'goal', 'low', '#d6cec2'),
    ('10000000-0000-0000-0000-000000000034', seed_user_id, 'Essay Notes', 'Fragments, outlines, and themes for longer essays.', 'Capture raw ideas and fragments so writing can accumulate instead of restarting from zero.', 'journal', 'low', '#81868d'),
    ('10000000-0000-0000-0000-000000000035', seed_user_id, 'Draft One', 'First complete pass on one essay rather than another outline.', 'Ship one real draft to break the cycle of collecting notes without finishing a piece.', 'task', 'low', '#a05b47')
  on conflict (id) do update
    set
      user_id = excluded.user_id,
      title = excluded.title,
      summary = excluded.summary,
      raw_text = excluded.raw_text,
      node_type = excluded.node_type,
      importance = excluded.importance,
      color = excluded.color,
      updated_at = now();

  insert into public.edges (
    id,
    user_id,
    source_node_id,
    target_node_id,
    edge_type
  )
  values
    ('20000000-0000-0000-0000-000000000001', seed_user_id, '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000002', seed_user_id, '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000003', seed_user_id, '10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000004', seed_user_id, '10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000005', seed_user_id, '10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000002', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000006', seed_user_id, '10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000007', seed_user_id, '10000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000003', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000008', seed_user_id, '10000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000003', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000009', seed_user_id, '10000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000003', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000010', seed_user_id, '10000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000004', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000011', seed_user_id, '10000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000004', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000012', seed_user_id, '10000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000004', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000013', seed_user_id, '10000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000005', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000014', seed_user_id, '10000000-0000-0000-0000-000000000015', '10000000-0000-0000-0000-000000000005', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000015', seed_user_id, '10000000-0000-0000-0000-000000000016', '10000000-0000-0000-0000-000000000006', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000016', seed_user_id, '10000000-0000-0000-0000-000000000017', '10000000-0000-0000-0000-000000000006', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000017', seed_user_id, '10000000-0000-0000-0000-000000000018', '10000000-0000-0000-0000-000000000005', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000018', seed_user_id, '10000000-0000-0000-0000-000000000019', '10000000-0000-0000-0000-000000000008', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000019', seed_user_id, '10000000-0000-0000-0000-000000000020', '10000000-0000-0000-0000-000000000008', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000020', seed_user_id, '10000000-0000-0000-0000-000000000021', '10000000-0000-0000-0000-000000000008', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000021', seed_user_id, '10000000-0000-0000-0000-000000000022', '10000000-0000-0000-0000-000000000008', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000022', seed_user_id, '10000000-0000-0000-0000-000000000023', '10000000-0000-0000-0000-000000000008', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000023', seed_user_id, '10000000-0000-0000-0000-000000000024', '10000000-0000-0000-0000-000000000012', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000024', seed_user_id, '10000000-0000-0000-0000-000000000025', '10000000-0000-0000-0000-000000000012', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000025', seed_user_id, '10000000-0000-0000-0000-000000000026', '10000000-0000-0000-0000-000000000007', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000026', seed_user_id, '10000000-0000-0000-0000-000000000027', '10000000-0000-0000-0000-000000000007', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000027', seed_user_id, '10000000-0000-0000-0000-000000000028', '10000000-0000-0000-0000-000000000026', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000028', seed_user_id, '10000000-0000-0000-0000-000000000029', '10000000-0000-0000-0000-000000000026', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000029', seed_user_id, '10000000-0000-0000-0000-000000000031', '10000000-0000-0000-0000-000000000030', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000030', seed_user_id, '10000000-0000-0000-0000-000000000032', '10000000-0000-0000-0000-000000000030', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000031', seed_user_id, '10000000-0000-0000-0000-000000000034', '10000000-0000-0000-0000-000000000033', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000032', seed_user_id, '10000000-0000-0000-0000-000000000035', '10000000-0000-0000-0000-000000000033', 'belongs_to'),
    ('20000000-0000-0000-0000-000000000033', seed_user_id, '10000000-0000-0000-0000-000000000016', '10000000-0000-0000-0000-000000000018', 'prerequisite_for'),
    ('20000000-0000-0000-0000-000000000034', seed_user_id, '10000000-0000-0000-0000-000000000019', '10000000-0000-0000-0000-000000000008', 'required_for'),
    ('20000000-0000-0000-0000-000000000035', seed_user_id, '10000000-0000-0000-0000-000000000018', '10000000-0000-0000-0000-000000000008', 'supports'),
    ('20000000-0000-0000-0000-000000000036', seed_user_id, '10000000-0000-0000-0000-000000000017', '10000000-0000-0000-0000-000000000008', 'supports'),
    ('20000000-0000-0000-0000-000000000037', seed_user_id, '10000000-0000-0000-0000-000000000020', '10000000-0000-0000-0000-000000000009', 'supports'),
    ('20000000-0000-0000-0000-000000000038', seed_user_id, '10000000-0000-0000-0000-000000000015', '10000000-0000-0000-0000-000000000009', 'supports'),
    ('20000000-0000-0000-0000-000000000039', seed_user_id, '10000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000008', 'supports'),
    ('20000000-0000-0000-0000-000000000040', seed_user_id, '10000000-0000-0000-0000-000000000024', '10000000-0000-0000-0000-000000000025', 'required_for'),
    ('20000000-0000-0000-0000-000000000041', seed_user_id, '10000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000009', 'related_to'),
    ('20000000-0000-0000-0000-000000000042', seed_user_id, '10000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000008', 'related_to'),
    ('20000000-0000-0000-0000-000000000043', seed_user_id, '10000000-0000-0000-0000-000000000027', '10000000-0000-0000-0000-000000000021', 'supports'),
    ('20000000-0000-0000-0000-000000000044', seed_user_id, '10000000-0000-0000-0000-000000000023', '10000000-0000-0000-0000-000000000020', 'related_to')
  on conflict (id) do update
    set
      user_id = excluded.user_id,
      source_node_id = excluded.source_node_id,
      target_node_id = excluded.target_node_id,
      edge_type = excluded.edge_type;
end $$;
