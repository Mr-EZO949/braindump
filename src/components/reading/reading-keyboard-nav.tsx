"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Left/Right arrows walk the reading path. Ignores keystrokes while the user is
// typing in a field so it never hijacks an editor or search box.
export function ReadingKeyboardNav({
  prevHref,
  nextHref,
}: {
  prevHref: string | null;
  nextHref: string | null;
}) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Presenter mode owns the arrow keys while it's active.
      if (document.body.hasAttribute("data-presenting")) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }

      if (event.key === "ArrowLeft" && prevHref) {
        router.push(prevHref);
      } else if (event.key === "ArrowRight" && nextHref) {
        router.push(nextHref);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prevHref, nextHref, router]);

  return null;
}
