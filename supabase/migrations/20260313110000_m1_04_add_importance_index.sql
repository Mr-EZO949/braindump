alter table public.nodes
add column if not exists importance_index integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'nodes_importance_index_range'
  ) then
    alter table public.nodes
    add constraint nodes_importance_index_range
    check (importance_index between 0 and 100);
  end if;
end $$;

update public.nodes
set importance_index = case importance
  when 'high' then 80
  when 'medium' then 56
  else 32
end
where importance_index is null;

update public.nodes
set importance = case
  when importance_index >= 72 then 'high'
  when importance_index >= 45 then 'medium'
  else 'low'
end;
