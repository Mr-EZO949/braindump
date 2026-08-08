import Link from "next/link";

import { ForkButton } from "./fork-button";
import styles from "./reading-view.module.css";

// Sticky top bar on public reading views: brand → marketing site, the graph's
// name, and the single Fork action. Everything else on the page is read-only.
export function PublicBanner({
  slug,
  workspaceName,
}: {
  slug: string;
  workspaceName: string;
}) {
  return (
    <div className={styles.publicBanner}>
      <div className={styles.publicBannerInner}>
        <div className={styles.publicBannerLeft}>
          <Link href="/" className={styles.publicBannerBrand}>
            BrainDump
          </Link>
          <span className={styles.publicBannerDivider} aria-hidden="true">
            /
          </span>
          <span className={styles.publicBannerName}>{workspaceName}</span>
        </div>
        <ForkButton slug={slug} />
      </div>
    </div>
  );
}
