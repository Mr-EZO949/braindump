// Weekly reflection unlocks on Sunday (JS Date.getDay() === 0). For dev/QA,
// localStorage flag `dev:unlock-weekly=1` overrides the check.
export function isWeeklyReflectionAvailable(now = new Date()): boolean {
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage.getItem("dev:unlock-weekly") === "1") return true;
    } catch {
      // ignore
    }
  }
  return now.getDay() === 0;
}
