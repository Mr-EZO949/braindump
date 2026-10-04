"use client";

// First-run overlays, in the order they can appear: the "about you" intake,
// the setup wizard, the welcome screen, the guided tour.

import { AboutYouIntake } from "@/components/ui/about-you-intake";
import { GuidedTour } from "@/components/ui/guided-tour";
import { WelcomeScreen } from "@/components/ui/onboarding-tutorial";
import { WorkspaceBootstrapWizard } from "@/components/ui/workspace-bootstrap-wizard";

import type { Onboarding } from "./use-onboarding";

export function ShellOnboarding({
  onboarding,
  signedIn,
  workspaceId,
  workspaceName,
}: {
  onboarding: Onboarding;
  signedIn: boolean;
  workspaceId: string | null;
  workspaceName: string;
}) {
  return (
    <>
      {/* User-level "about you" intake — the first-run sign-up moment. Shown
          once, before any workspace onboarding, and gated on profileIntakeState. */}
      {onboarding.profileIntakeState === "open" && signedIn && <AboutYouIntake onDone={onboarding.finishIntake} />}

      {/* Workspace bootstrap wizard — only shown for an in-progress creation flow */}
      {onboarding.bootstrapWorkspaceId && onboarding.bootstrapWorkspaceId === workspaceId && (
        <WorkspaceBootstrapWizard
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          isOnboarding={onboarding.isOnboardingFlow()}
          onComplete={onboarding.completeBootstrap}
          onSkip={onboarding.skipBootstrap}
        />
      )}

      {/* Welcome screen — guides new users into workspace setup */}
      {onboarding.showWelcome && signedIn && (
        <WelcomeScreen onGetStarted={onboarding.startFromWelcome} onSkip={onboarding.skipWelcome} />
      )}

      {/* Guided tour — walks user through UI features after onboarding */}
      {onboarding.showTour && <GuidedTour onDone={onboarding.endTour} />}
    </>
  );
}
