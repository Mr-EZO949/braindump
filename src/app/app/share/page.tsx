import { redirect } from "next/navigation";

import { WorkspaceShareControls } from "@/components/reading/workspace-share-controls";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import styles from "./share.module.css";

export const metadata = { title: "Share graphs — BrainDump" };

type WorkspaceRow = {
  id: string;
  name: string;
  is_public: boolean | null;
  public_slug: string | null;
};

export default async function SharePage() {
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
    .select("id, name, is_public, public_slug")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const workspaces = (workspacesData ?? []) as WorkspaceRow[];

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Share</p>
          <h1 className={styles.title}>Publish a graph</h1>
          <p className={styles.subtitle}>
            Make a graph public and anyone with the link can read it — no account, no login
            wall. It stays read-only, with a one-tap way to fork a copy into their own
            BrainDump. Turn it off any time; the link reactivates if you republish.
          </p>
        </header>

        {workspaces.length === 0 ? (
          <p className={styles.empty}>No workspaces yet.</p>
        ) : (
          <ul className={styles.list}>
            {workspaces.map((workspace) => (
              <li key={workspace.id} className={styles.row}>
                <WorkspaceShareControls
                  workspaceId={workspace.id}
                  name={workspace.name}
                  initialIsPublic={Boolean(workspace.is_public)}
                  initialSlug={workspace.public_slug}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
