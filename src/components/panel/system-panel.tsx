import Image from "next/image";

type SystemPanelProps = {
  onSignOut: () => void;
  onClose: () => void;
  open: boolean;
  signingOut: boolean;
  userEmail: string | null;
};

export function SystemPanel({
  onClose,
  onSignOut,
  open,
  signingOut,
  userEmail,
}: SystemPanelProps) {
  return (
    <aside
      aria-hidden={!open}
      className={`system-panel absolute left-0 top-0 z-20 h-full w-[300px] ${
        open ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0"
      }`}
    >
      <div className="flex h-full flex-col">
        {/* Header with logo */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <Image src="/logo_withtext.svg" alt="BrainDump" width={180} height={36} style={{ height: 32, width: "auto" }} />
          <button
            aria-label="Close"
            className="sp-close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="sp-divider" />

        {/* Account */}
        <div className="px-5 py-4">
          <p className="sp-section-label">Account</p>
          <p className="sp-email">{userEmail ?? "Not signed in"}</p>
        </div>

        <div className="sp-divider" />

        {/* Account actions */}
        <div className="px-5 py-4 flex flex-col gap-1">
          <button className="sp-menu-btn" type="button" disabled>
            Manage subscription
          </button>
          <button className="sp-menu-btn sp-menu-btn--danger" type="button" disabled>
            Delete account
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sign out + footer */}
        <div className="px-5 pb-5">
          <button
            className="sp-signout-btn"
            disabled={!userEmail || signingOut}
            onClick={onSignOut}
            type="button"
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>

          <div className="sp-divider mt-4" />
          <div className="sp-footer">
            <a href="mailto:support@braindump.app" className="sp-footer-link">Support</a>
            <span className="sp-footer-dot">·</span>
            <a href="#" className="sp-footer-link">Terms</a>
            <span className="sp-footer-dot">·</span>
            <a href="#" className="sp-footer-link">Privacy</a>
          </div>
        </div>
      </div>
    </aside>
  );
}
