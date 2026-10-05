import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  ChartBarIcon,
  ChevronDownIcon,
  ListIcon,
  LockIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/ui/icons";
import type { Workspace } from "@/types/graph";

type TopCommandBarProps = {
  onToggleSystemPanel: () => void;
  onToggleRightPanel: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onToggleWorkspaceMenu: () => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onDeleteWorkspace: (workspaceId: string) => Promise<void>;
  selectedWorkspaceId: string | null;
  systemPanelOpen: boolean;
  workspaces: Workspace[];
  workspaceMenuOpen: boolean;
  workspaceName: string;
  onOpenWeeklyReflection: () => void;
  onOpenHistory: () => void;
  weeklyReflectionLocked: boolean;
};

const WEEKLY_LOCKED_NOTICE_MS = 3200;

function nextSundayLabel(now = new Date()): string {
  const today = now.getDay();
  const daysUntilSunday = (7 - today) % 7 || 7;
  const target = new Date(now);
  target.setDate(now.getDate() + daysUntilSunday);
  return target.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function TopCommandBar({
  onToggleSystemPanel,
  onToggleRightPanel,
  onSelectWorkspace,
  onToggleWorkspaceMenu,
  onCreateWorkspace,
  onDeleteWorkspace,
  selectedWorkspaceId,
  systemPanelOpen,
  workspaces,
  workspaceMenuOpen,
  workspaceName,
  onOpenWeeklyReflection,
  onOpenHistory,
  weeklyReflectionLocked,
}: TopCommandBarProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [lockedNotice, setLockedNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!lockedNotice) return;
    const t = setTimeout(() => setLockedNotice(null), WEEKLY_LOCKED_NOTICE_MS);
    return () => clearTimeout(t);
  }, [lockedNotice]);
  return (
    <header className="app-topbar bg-[var(--color-bg-shell)] shadow-[inset_0_-1px_0_var(--color-border-faint)]">
      <div className="top-bar-responsive flex h-16 items-center justify-between gap-6 px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            aria-expanded={systemPanelOpen}
            className="logo-trigger"
            data-open={systemPanelOpen}
            onClick={onToggleSystemPanel}
            type="button"
          >
            <Image src="/logo_icon.svg" alt="Menu" width={28} height={28} className="logo-trigger-icon" />
          </button>

          <div className="relative">
            <button
              aria-expanded={workspaceMenuOpen}
              className="workspace-trigger"
              data-tour="workspace-switcher"
              data-open={workspaceMenuOpen}
              onClick={onToggleWorkspaceMenu}
              type="button"
            >
              <span className="workspace-trigger-name truncate">{workspaceName}</span>
              <ChevronDownIcon
                className={`h-[12px] w-[12px] text-[var(--color-text-muted)] transition-transform duration-150 ease-out ${
                  workspaceMenuOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            <div
              className={`workspace-menu ${
                workspaceMenuOpen ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"
              }`}
            >
              <div className="workspace-menu-list">
                {workspaces.map((workspace) => {
                  const active = workspace.id === selectedWorkspaceId;
                  const confirmingDelete = confirmDeleteId === workspace.id;

                  return (
                    <div
                      className={`workspace-menu-entry ${confirmingDelete ? "workspace-menu-entry-confirming" : ""}`}
                      data-active={active ? "true" : "false"}
                      key={workspace.id}
                    >
                      <div className="workspace-menu-row">
                        <button
                          className={`workspace-menu-item workspace-menu-item-grow ${
                            active ? "workspace-menu-item-active" : ""
                          } ${confirmingDelete ? "workspace-menu-item-confirming" : ""}`}
                          onClick={() => {
                            setConfirmDeleteId(null);
                            onSelectWorkspace(workspace.id);
                          }}
                          type="button"
                        >
                          <span className="workspace-menu-item-name">{workspace.name}</span>
                        </button>

                        {workspaces.length > 1 ? (
                          confirmingDelete ? (
                            <div className="workspace-delete-actions workspace-delete-actions-inline">
                              <button
                                className="workspace-delete-cancel"
                                onClick={() => setConfirmDeleteId(null)}
                                type="button"
                              >
                                Cancel
                              </button>
                              <button
                                className="workspace-delete-ok"
                                disabled={deleting}
                                onClick={async () => {
                                  setDeleting(true);
                                  await onDeleteWorkspace(workspace.id);
                                  setConfirmDeleteId(null);
                                  setDeleting(false);
                                }}
                                type="button"
                              >
                                {deleting ? "Deleting…" : "Delete"}
                              </button>
                            </div>
                          ) : (
                            <button
                              className="workspace-delete-trigger"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(workspace.id);
                              }}
                              title="Delete workspace"
                              type="button"
                            >
                              <TrashIcon className="h-[13px] w-[13px]" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="workspace-menu-divider" />

              {creating ? (
                <form
                  className="workspace-new-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const name = newName.trim();
                    if (!name || submitting) return;
                    setSubmitting(true);
                    await onCreateWorkspace(name);
                    setNewName("");
                    setCreating(false);
                    setSubmitting(false);
                  }}
                >
                  <input
                    autoFocus
                    className="workspace-new-input"
                    disabled={submitting}
                    maxLength={80}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setCreating(false);
                        setNewName("");
                      }
                    }}
                    placeholder="Workspace name"
                    ref={inputRef}
                    type="text"
                    value={newName}
                  />
                  <button
                    className="workspace-new-submit"
                    disabled={submitting || newName.trim().length === 0}
                    type="submit"
                  >
                    {submitting ? "…" : "Create"}
                  </button>
                </form>
              ) : (
                <button
                  className="workspace-menu-item workspace-menu-item-new"
                  onClick={() => {
                    setCreating(true);
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                  type="button"
                >
                  <PlusIcon className="h-[13px] w-[13px]" />
                  <span>New workspace</span>
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1" />

        {/* Weekly Review and dump History sit top right (owner, 2026-10-05);
            the bottom dock keeps the views, Brain Dump and Focus. */}
        <div className="topbar-actions">
          <div className="relative">
            <button
              className="workspace-trigger topbar-action"
              data-locked={weeklyReflectionLocked}
              data-tour="weekly-reflection-btn"
              onClick={() => {
                if (weeklyReflectionLocked) {
                  setLockedNotice(`Unlocks Sunday — see you ${nextSundayLabel()}.`);
                  return;
                }
                onOpenWeeklyReflection();
              }}
              title={weeklyReflectionLocked ? "Available on Sunday" : "Open weekly review"}
              type="button"
            >
              {weeklyReflectionLocked ? (
                <LockIcon className="h-[11px] w-[11px]" />
              ) : (
                <ChartBarIcon className="h-[12px] w-[12px]" />
              )}
              <span className="topbar-action-label">Weekly Review</span>
            </button>
            {lockedNotice ? (
              <div className="mode-dock-notice topbar-notice" role="status">
                <span className="mode-dock-notice-lock" aria-hidden="true">⌛</span>
                {lockedNotice}
              </div>
            ) : null}
          </div>

          <button
            className="workspace-trigger topbar-action"
            data-tour="history-btn"
            onClick={onOpenHistory}
            title="View past brain dumps"
            type="button"
          >
            <ListIcon className="h-[12px] w-[12px]" />
            <span className="topbar-action-label">History</span>
          </button>
        </div>

        {/* Mobile-only panel toggle */}
        <button
          aria-label="Toggle panel"
          className="mobile-panel-toggle"
          onClick={onToggleRightPanel}
          type="button"
        >
          <svg className="h-[16px] w-[16px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>
      </div>
    </header>
  );
}
