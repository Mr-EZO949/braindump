import {
  ChevronDownIcon,
  WorkspaceIcon,
} from "@/components/ui/icons";
import type { Workspace } from "@/types/graph";

type TopCommandBarProps = {
  onToggleSystemPanel: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onToggleWorkspaceMenu: () => void;
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
  selectedWorkspaceId,
  systemPanelOpen,
  workspaces,
  workspaceMenuOpen,
  workspaceName,
}: TopCommandBarProps) {
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
            TR
          </button>

          <div className="relative">
            <button
              aria-expanded={workspaceMenuOpen}
              className="workspace-trigger"
              data-open={workspaceMenuOpen}
              onClick={onToggleWorkspaceMenu}
              type="button"
            >
              <WorkspaceIcon className="h-[13px] w-[13px] text-[var(--color-text-tertiary)]" />
              <span className="truncate">{workspaceName}</span>
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
              {workspaces.map((workspace) => {
                const active = workspace.id === selectedWorkspaceId;

                return (
                  <button
                    className={`workspace-menu-item ${active ? "workspace-menu-item-active" : ""}`}
                    key={workspace.id}
                    onClick={() => onSelectWorkspace(workspace.id)}
                    type="button"
                  >
                    <span>{workspace.name}</span>
                    {active ? (
                      <span className="text-[11px] text-[var(--color-text-muted)]">Current</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex-1" />
      </div>
    </header>
  );
}
