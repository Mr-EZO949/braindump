"use client";

// Who is signed in, their workspaces and the selected one — and leaving
// (sign out, delete account).

import { useEffect, useMemo, useState } from "react";
import type { useRouter } from "next/navigation";

import { loadWorkspaces, persistLocalSelectedWorkspaceId, readLocalSelectedWorkspaceId } from "@/lib/graph/data";
import type { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Workspace } from "@/types/graph";

export type AuthUserState = {
  email: string | null;
  id: string;
};

type BrowserSupabase = ReturnType<typeof getSupabaseBrowserClient>;
type AppRouter = ReturnType<typeof useRouter>;

export function useSession({
  initialUser,
  supabase,
  router,
  closeSystemPanel,
}: {
  initialUser: AuthUserState;
  supabase: BrowserSupabase;
  router: AppRouter;
  closeSystemPanel: () => void;
}) {
  const [authUser, setAuthUser] = useState<AuthUserState | null>(initialUser);
  const [signingOut, setSigningOut] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const workspaceName = selectedWorkspace?.name ?? "General";

  useEffect(() => {
    let active = true;

    void loadWorkspaces(authUser?.id ?? null).then((nextWorkspaces) => {
      if (!active) {
        return;
      }

      setWorkspaces(nextWorkspaces);
      setSelectedWorkspaceId((currentWorkspaceId) => {
        const storedWorkspaceId = readLocalSelectedWorkspaceId(authUser?.id ?? null);

        if (currentWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === currentWorkspaceId)) {
          return currentWorkspaceId;
        }

        if (storedWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === storedWorkspaceId)) {
          return storedWorkspaceId;
        }

        return nextWorkspaces.find((workspace) => workspace.name === "General")?.id ?? nextWorkspaces[0]?.id ?? null;
      });
    });

    return () => {
      active = false;
    };
  }, [authUser?.id]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active || error) {
        return;
      }

      const sessionUserId = data.session?.user?.id ?? null;
      setAuthUser(
        data.session?.user
          ? {
              email: data.session.user.email ?? null,
              id: data.session.user.id,
            }
          : null,
      );

      // Perf: seed the selected workspace from localStorage the moment auth
      // resolves so the graph fetch can start IN PARALLEL with loadWorkspaces,
      // instead of waiting a full round-trip for the workspace list first.
      // loadWorkspaces still validates/corrects this once it lands (it keeps a
      // valid current selection), so a stale stored id just self-heals.
      if (sessionUserId) {
        const storedWorkspaceId = readLocalSelectedWorkspaceId(sessionUserId);
        if (storedWorkspaceId) {
          setSelectedWorkspaceId((prev) => prev ?? storedWorkspaceId);
        }
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (event === "TOKEN_REFRESHED" && !session)) {
        // Redirect to login when session is lost (e.g. invalid refresh token)
        router.push("/login");
        return;
      }

      setAuthUser(
        session?.user
          ? {
              email: session.user.email ?? null,
              id: session.user.id,
            }
          : null,
      );
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
    // The router is stable for the page's life; subscribing once per client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  useEffect(() => {
    if (workspaces.length === 0) {
      return;
    }

    persistLocalSelectedWorkspaceId(authUser?.id ?? null, selectedWorkspaceId);
  }, [authUser?.id, selectedWorkspaceId, workspaces.length]);

  const signOut = async () => {
    if (!supabase || signingOut) {
      return;
    }

    setSigningOut(true);

    const { error } = await supabase.auth.signOut();

    setSigningOut(false);

    if (error) {
      return;
    }

    closeSystemPanel();
    router.replace("/login");
  };

  const deleteAccount = async () => {
    if (deletingAccount) {
      return;
    }

    setDeletingAccount(true);

    try {
      const res = await fetch("/api/account/delete", { method: "POST" });

      if (!res.ok) {
        setDeletingAccount(false);
        return false;
      }

      // Clear the local session, then leave. The server already removed
      // every row this user owned via FK cascade.
      if (supabase) {
        await supabase.auth.signOut();
      }

      closeSystemPanel();
      router.replace("/login");
      return true;
    } catch {
      setDeletingAccount(false);
      return false;
    }
  };

  return {
    supabase,
    authUser,
    userId: authUser?.id ?? null,
    workspaces,
    setWorkspaces,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedWorkspace,
    workspaceName,
    signingOut,
    deletingAccount,
    signOut,
    deleteAccount,
  };
}

export type ShellSession = ReturnType<typeof useSession>;
