// In-memory stand-in for the slice of supabase-js the server libs use:
// from(table).select/insert/update/upsert/delete with eq/neq/in/is/gt/gte/lt/
// lte/or/ilike filters, order, limit, single/maybeSingle, and chained .select()
// returning. Filters follow SQL NULL semantics (NULL never matches eq/neq/in),
// which is what PostgREST does — `.neq("status", "archived")` drops NULL rows.
//
// Every awaited query is one simulated network round trip. `stats.depth` is
// the longest chain of round trips that had to wait on each other — the number
// that sets a route's latency when each trip costs ~75 ms (iad1 → eu-west-1).

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
export type FakeTables = Record<string, Row[]>;

type Filter = (row: Row) => boolean;

type QueryState = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete" | null;
  payload: Row | Row[] | null;
  upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } | null;
  filters: Filter[];
  returning: boolean;
  single: "single" | "maybe" | null;
  orderBy: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
};

export type FakeSupabase = {
  client: SupabaseClient;
  tables: FakeTables;
  // `calls` lists every executed query as "table.op" (op: select, insert,
  // update, upsert, delete).
  stats: { queries: number; depth: number; calls: string[] };
};

const isNull = (v: unknown) => v === null || v === undefined;

function parseOr(expr: string): Filter {
  // "source_node_id.eq.X,target_node_id.eq.X", and "ends_on.is.null,ends_on.gte.D"
  // (loadActiveCommitments).
  const parts = expr.split(",").map((part) => {
    const [column, op, ...rest] = part.split(".");
    const value = rest.join(".");
    if (op === "is" && value === "null") return (row: Row) => isNull(row[column]);
    if (op === "gte") return (row: Row) => !isNull(row[column]) && String(row[column]) >= value;
    if (op !== "eq") throw new Error(`fake-supabase: unsupported or() op ${op}`);
    return (row: Row) => !isNull(row[column]) && String(row[column]) === value;
  });
  return (row) => parts.some((p) => p(row));
}

export function createFakeSupabase(
  initial: FakeTables,
  options: { unique?: Record<string, string[]> } = {},
): FakeSupabase {
  const tables: FakeTables = {};
  for (const [name, rows] of Object.entries(initial)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  const stats = { queries: 0, depth: 0, calls: [] as string[] };
  let idCounter = 0;
  // Depth of the most recent response each await resumed from. A query issued
  // after awaiting a depth-d response is depth d+1; queries issued together
  // share a depth.
  let resumedDepth = 0;

  const rowsOf = (table: string) => (tables[table] ??= []);

  function execute(state: QueryState): { data: unknown; error: unknown } {
    const rows = rowsOf(state.table);
    const matches = (row: Row) => state.filters.every((f) => f(row));
    let result: Row[] = [];

    switch (state.op) {
      case "select":
      case null:
        result = rows.filter(matches);
        break;
      case "insert": {
        const incoming = Array.isArray(state.payload) ? state.payload : [state.payload ?? {}];
        const uniqueCols = options.unique?.[state.table];
        for (const raw of incoming) {
          if (
            uniqueCols &&
            rows.some((r) => uniqueCols.every((c) => r[c] === raw[c]))
          ) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
        }
        result = incoming.map((raw) => {
          const row = { id: `${state.table}-${++idCounter}`, ...raw };
          rows.push(row);
          return row;
        });
        break;
      }
      case "upsert": {
        const incoming = Array.isArray(state.payload) ? state.payload : [state.payload ?? {}];
        const conflictCols = (state.upsertOptions?.onConflict ?? "id").split(",");
        for (const raw of incoming) {
          const existing = rows.find((r) => conflictCols.every((c) => r[c] === raw[c]));
          if (existing) {
            // ON CONFLICT DO NOTHING returns no row for the ignored duplicate.
            if (state.upsertOptions?.ignoreDuplicates) continue;
            Object.assign(existing, raw);
            result.push(existing);
          } else {
            const row = { id: `${state.table}-${++idCounter}`, ...raw };
            rows.push(row);
            result.push(row);
          }
        }
        break;
      }
      case "update": {
        result = rows.filter(matches);
        for (const row of result) Object.assign(row, state.payload);
        break;
      }
      case "delete": {
        result = rows.filter(matches);
        tables[state.table] = rows.filter((r) => !matches(r));
        break;
      }
    }

    let out = result.map((r) => ({ ...r }));
    for (const { column, ascending } of [...state.orderBy].reverse()) {
      out = [...out].sort((a, b) => {
        const av = a[column] as string | number | null;
        const bv = b[column] as string | number | null;
        if (av === bv) return 0;
        if (isNull(av)) return 1;
        if (isNull(bv)) return -1;
        return (av! < bv! ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (state.limit !== null) out = out.slice(0, state.limit);

    const returnsRows = state.op === "select" || state.op === null || state.returning;
    if (!returnsRows) return { data: null, error: null };
    if (state.single) {
      if (out.length === 0) {
        return state.single === "maybe"
          ? { data: null, error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows" } };
      }
      return { data: out[0], error: null };
    }
    return { data: out, error: null };
  }

  function builder(table: string) {
    const state: QueryState = {
      table,
      op: null,
      payload: null,
      upsertOptions: null,
      filters: [],
      returning: false,
      single: null,
      orderBy: [],
      limit: null,
    };
    const addFilter = (f: Filter) => {
      state.filters.push(f);
      return chain;
    };
    const chain = {
      select() {
        if (state.op === null) state.op = "select";
        else state.returning = true;
        return chain;
      },
      insert(payload: Row | Row[]) {
        state.op = "insert";
        state.payload = payload;
        return chain;
      },
      update(payload: Row) {
        state.op = "update";
        state.payload = payload;
        return chain;
      },
      upsert(payload: Row | Row[], opts?: QueryState["upsertOptions"]) {
        state.op = "upsert";
        state.payload = payload;
        state.upsertOptions = opts ?? null;
        return chain;
      },
      delete() {
        state.op = "delete";
        return chain;
      },
      eq: (c: string, v: unknown) => addFilter((r) => !isNull(r[c]) && r[c] === v),
      neq: (c: string, v: unknown) => addFilter((r) => !isNull(r[c]) && r[c] !== v),
      in: (c: string, vs: unknown[]) => addFilter((r) => !isNull(r[c]) && vs.includes(r[c])),
      is: (c: string, v: unknown) => addFilter((r) => (v === null ? isNull(r[c]) : r[c] === v)),
      gt: (c: string, v: string | number) => addFilter((r) => !isNull(r[c]) && (r[c] as string | number) > v),
      gte: (c: string, v: string | number) => addFilter((r) => !isNull(r[c]) && (r[c] as string | number) >= v),
      lt: (c: string, v: string | number) => addFilter((r) => !isNull(r[c]) && (r[c] as string | number) < v),
      lte: (c: string, v: string | number) => addFilter((r) => !isNull(r[c]) && (r[c] as string | number) <= v),
      or: (expr: string) => addFilter(parseOr(expr)),
      // Case-insensitive equality (no % wildcards in what the libs send).
      ilike: (c: string, v: string) =>
        addFilter((r) => !isNull(r[c]) && String(r[c]).toLowerCase() === String(v).toLowerCase()),
      order(column: string, opts?: { ascending?: boolean }) {
        state.orderBy.push({ column, ascending: opts?.ascending ?? true });
        return chain;
      },
      limit(n: number) {
        state.limit = n;
        return chain;
      },
      single() {
        state.single = "single";
        return chain;
      },
      maybeSingle() {
        state.single = "maybe";
        return chain;
      },
      then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) {
        // The request "reaches the server" now (effects apply in issue order);
        // the response lands one round trip later.
        stats.queries += 1;
        stats.calls.push(`${state.table}.${state.op ?? "select"}`);
        const depth = resumedDepth + 1;
        stats.depth = Math.max(stats.depth, depth);
        let response: { data: unknown; error: unknown };
        try {
          response = execute(state);
        } catch (err) {
          return Promise.reject(err).then(undefined, reject);
        }
        return new Promise<{ data: unknown; error: unknown }>((done) =>
          setTimeout(() => {
            resumedDepth = Math.max(resumedDepth, depth);
            done(response);
          }, 0),
        ).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    client: { from: builder } as unknown as SupabaseClient,
    tables,
    stats,
  };
}
