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
    (
      '11111111-1111-1111-1111-111111111111',
      seed_user_id,
      'Neurolight',
      'Seizure detection project for the M1 graph seed.',
      'Build an early concept for seizure detection tooling and map the work into nodes.',
      'project',
      'high',
      '#5b8def'
    ),
    (
      '22222222-2222-2222-2222-222222222222',
      seed_user_id,
      'Probability 2',
      'Probability course that supports the seeded project graph.',
      'Covers probability theory, distributions, and inference that supports model evaluation.',
      'class',
      'high',
      '#3ecf8e'
    ),
    (
      '33333333-3333-3333-3333-333333333333',
      seed_user_id,
      'ML Evaluation',
      'Concept node about measuring model quality and uncertainty.',
      'Track metrics, error analysis, and calibration for machine learning experiments.',
      'concept',
      'medium',
      '#f59e0b'
    ),
    (
      '44444444-4444-4444-4444-444444444444',
      seed_user_id,
      'Email Professor',
      'Task node for requesting project feedback.',
      'Send a short email to ask for guidance on probability topics relevant to Neurolight.',
      'task',
      'medium',
      '#f97316'
    ),
    (
      '55555555-5555-5555-5555-555555555555',
      seed_user_id,
      'Research Notes',
      'Journal node for captured observations and references.',
      'Collected notes about seizure datasets, related literature, and open questions.',
      'journal',
      'low',
      '#64748b'
    ),
    (
      '66666666-6666-6666-6666-666666666666',
      seed_user_id,
      'Data Sources',
      'Concept node for possible datasets and data access strategy.',
      'List candidate EEG datasets, source quality concerns, and access constraints.',
      'concept',
      'medium',
      '#8b5cf6'
    ),
    (
      '77777777-7777-7777-7777-777777777777',
      seed_user_id,
      'Paper Ideas',
      'Idea node for possible writeups and experiments.',
      'Explore paper directions around seizure classification, benchmarking, and clinical utility.',
      'idea',
      'medium',
      '#14b8a6'
    ),
    (
      '88888888-8888-8888-8888-888888888888',
      seed_user_id,
      'Build Prototype',
      'Task node for creating the first working prototype.',
      'Assemble a minimal prototype to validate the core project direction and workflow.',
      'task',
      'high',
      '#ef4444'
    )
  on conflict (id) do nothing;

  insert into public.edges (
    id,
    user_id,
    source_node_id,
    target_node_id,
    edge_type
  )
  values
    (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      seed_user_id,
      '22222222-2222-2222-2222-222222222222',
      '11111111-1111-1111-1111-111111111111',
      'supports'
    ),
    (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      seed_user_id,
      '33333333-3333-3333-3333-333333333333',
      '11111111-1111-1111-1111-111111111111',
      'supports'
    ),
    (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
      seed_user_id,
      '44444444-4444-4444-4444-444444444444',
      '11111111-1111-1111-1111-111111111111',
      'belongs_to'
    ),
    (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
      seed_user_id,
      '55555555-5555-5555-5555-555555555555',
      '11111111-1111-1111-1111-111111111111',
      'related_to'
    ),
    (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
      seed_user_id,
      '66666666-6666-6666-6666-666666666666',
      '11111111-1111-1111-1111-111111111111',
      'supports'
    ),
    (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',
      seed_user_id,
      '77777777-7777-7777-7777-777777777777',
      '11111111-1111-1111-1111-111111111111',
      'related_to'
    ),
    (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7',
      seed_user_id,
      '88888888-8888-8888-8888-888888888888',
      '11111111-1111-1111-1111-111111111111',
      'belongs_to'
    )
  on conflict (id) do nothing;
end $$;
