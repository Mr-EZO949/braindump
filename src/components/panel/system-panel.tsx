type SystemPanelProps = {
  onClose: () => void;
  open: boolean;
};

export function SystemPanel({ onClose, open }: SystemPanelProps) {
  return (
    <aside
      aria-hidden={!open}
      className={`system-panel absolute left-0 top-0 z-20 h-full w-[320px] ${
        open ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0"
      }`}
    >
      <div className="flex h-full flex-col px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--color-text-muted)]">
              System
            </p>
            <h2 className="mt-3 text-[18px] font-semibold tracking-[-0.04em] text-[var(--color-text-primary)]">
              Account
            </h2>
          </div>

          <button
            aria-label="Close system panel"
            className="shell-button shell-icon-button"
            onClick={onClose}
            type="button"
          >
            <span className="text-[16px] leading-none text-[var(--color-text-secondary)]">×</span>
          </button>
        </div>

        <div className="mt-8 h-px w-full bg-[var(--color-border-faint)]" />

        <div className="mt-8 space-y-7">
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              Account
            </p>
            <button className="system-row system-row-active mt-3" type="button">
              <span>Profile</span>
              <span className="text-[11px] tracking-[0.02em] text-[var(--color-text-muted)]">
                Active
              </span>
            </button>
            <button className="system-row mt-2" type="button">
              <span>Notifications</span>
            </button>
          </section>

          <section>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              Settings
            </p>
            <button className="system-row mt-3" type="button">
              <span>Preferences</span>
            </button>
            <button className="system-row mt-2" type="button">
              <span>Appearance</span>
            </button>
          </section>

          <section>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              System
            </p>
            <button className="system-row mt-3" type="button">
              <span>Keyboard shortcuts</span>
            </button>
            <button className="system-row mt-2" type="button">
              <span>Billing</span>
            </button>
            <button className="system-row mt-2" type="button">
              <span>Support</span>
            </button>
          </section>
        </div>
      </div>
    </aside>
  );
}
