import {
  ArrowUpIcon,
  AttachmentIcon,
  MicIcon,
  SearchIcon,
} from "@/components/ui/icons";

type MainStageProps = {
  composerPlaceholder: string;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onComposerSubmit: () => void;
  submitting: boolean;
};

export function MainStage({
  composerPlaceholder,
  composerValue,
  onComposerChange,
  onComposerSubmit,
  submitting,
}: MainStageProps) {
  return (
    <main className="relative min-w-0 flex-1 overflow-hidden bg-[var(--color-bg-base)]">
      <div className="main-stage-material pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,transparent_62%,rgba(0,0,0,0.16)_100%)]" />

      <div className="absolute left-6 top-6 z-10">
        <label className="graph-search-control">
          <SearchIcon className="h-[13px] w-[13px] shrink-0 text-[var(--color-text-muted)]" />
          <span className="sr-only">Graph search</span>
          <input className="graph-search-input" placeholder="Find node" type="search" />
        </label>
      </div>

      <div className="relative flex h-full items-center justify-center px-8 py-10">
        <div className="origin-marker pointer-events-none" aria-hidden="true">
          <div className="origin-field" />
          <div className="origin-aura" />
          <div className="origin-ring" />
          <div className="origin-core" />
          <div className="origin-dot" />
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-6 z-10 flex justify-center px-6">
        <div className="stage-composer" role="group" aria-label="Thought composer">
          <button
            aria-label="Add attachment"
            className="composer-utility-button"
            type="button"
          >
            <AttachmentIcon className="h-[15px] w-[15px]" />
          </button>

          <textarea
            className="stage-composer-textarea"
            onChange={(event) => onComposerChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onComposerSubmit();
              }
            }}
            placeholder={composerPlaceholder}
            rows={1}
            value={composerValue}
          />

          <button
            aria-label="Start voice input"
            className="composer-utility-button"
            type="button"
          >
            <MicIcon className="h-[15px] w-[15px]" />
          </button>

          <button
            aria-label="Send thought"
            className="composer-send-button"
            disabled={submitting || composerValue.trim().length === 0}
            onClick={onComposerSubmit}
            type="button"
          >
            <ArrowUpIcon className="h-[15px] w-[15px]" />
          </button>
        </div>
      </div>
    </main>
  );
}
