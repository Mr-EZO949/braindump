import Image from "next/image";
import { useRef, useState } from "react";
import {
  ChevronDownIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/ui/icons";
import type { Workspace } from "@/types/graph";

type TopCommandBarProps = {
  onToggleSystemPanel: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onToggleWorkspaceMenu: () => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onDeleteWorkspace: (workspaceId: string) => Promise<void>;
  selectedWorkspaceId: string | null;
  systemPanelOpen: boolean;
  workspaces: Workspace[];
  workspaceMenuOpen: boolean;
  workspaceName: string;
};

export function TopCommandBar({
  onToggleSystemPanel,
  onSelectWorkspace,
  onToggleWorkspaceMenu,
  onCreateWorkspace,
  onDeleteWorkspace,
  selectedWorkspaceId,
  systemPanelOpen,
  workspaces,
  workspaceMenuOpen,
  workspaceName,
}: TopCommandBarProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <header className="h-16 bg-[var(--color-bg-shell)] shadow-[inset_0_-1px_0_var(--color-border-faint)]">
      <div className="flex h-full items-center justify-between gap-6 px-6">
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
      </div>
    </header>
  );
}
