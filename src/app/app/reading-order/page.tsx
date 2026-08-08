import { redirect } from "next/navigation";

import { ReadingOrderEditor } from "@/components/reading/reading-order-editor";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import styles from "./reading-order.module.css";

export const metadata = { title: "Reading order — BrainDump" };

type WorkspaceRow = { id: string; name: string };
type NodeRow = {
  id: string;
  title: string;
  node_type: string;
  reading_order: number | null;
};

export default async function ReadingOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    redirect("/login");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: workspacesData } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const workspaces = (workspacesData ?? []) as WorkspaceRow[];
  const { w } = await searchParams;
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === w) ?? workspaces[0] ?? null;

  let nodes: NodeRow[] = [];
  if (selectedWorkspace) {
    const { data: nodesData } = await supabase
      .from("nodes")
      .select("id, title, node_type, reading_order")
      .eq("user_id", user.id)
      .eq("workspace_id", selectedWorkspace.id)
      .order("reading_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    nodes = (nodesData ?? []) as NodeRow[];
  }

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Reading order</p>
          <h1 className={styles.title}>Arrange this graph as a document</h1>
          <p className={styles.subtitle}>
            Drag nodes into the order you&apos;d read them start to finish. The reading
            view&apos;s Prev / Next follows this sequence. Nodes you leave out fall back to
            their strongest connection. This never changes your graph&apos;s edges.
          </p>
        </header>

        {workspaces.length > 1 ? (
          <nav className={styles.workspaceTabs} aria-label="Workspace">
            {workspaces.map((workspace) => (
              <a
                key={workspace.id}
                href={`/app/reading-order?w=${workspace.id}`}
                className={`${styles.workspaceTab} ${
                  workspace.id === selectedWorkspace?.id ? styles.workspaceTabActive : ""
                }`}
              >
                {workspace.name}
              </a>
            ))}
          </nav>
        ) : null}

        {selectedWorkspace ? (
          <ReadingOrderEditor workspaceId={selectedWorkspace.id} initialNodes={nodes} />
        ) : (
          <p className={styles.empty}>No workspaces yet.</p>
        )}
      </div>
    </main>
  );
}
