interface WelcomeSurfaceProps {
  onCreateProject: () => Promise<void>;
  onOpenProject: () => Promise<void>;
  onSkip: () => void;
  onTakeTour: () => void;
}

export function WelcomeSurface({
  onCreateProject,
  onOpenProject,
  onSkip,
  onTakeTour,
}: WelcomeSurfaceProps): React.JSX.Element {
  return (
    <section className="welcome-surface" data-testid="welcome-surface" aria-labelledby="welcome-title">
      <div className="welcome-frame">
        <div className="welcome-mark" aria-hidden="true">
          <span>G</span>
          <i />
        </div>
        <div className="welcome-copy">
          <span className="eyebrow">Your edit starts here</span>
          <h1 id="welcome-title">Make the story clear.<br />Keep every decision yours.</h1>
          <p>
            Guyditor is a local-first video editor where transcript, timeline, graphics,
            review, and publishing live in one workspace—and every agent change arrives
            as a proposal for you to accept or reject.
          </p>
        </div>
        <div className="welcome-project-actions">
          <button
            type="button"
            className="primary-action welcome-create"
            data-testid="welcome-create-project"
            onClick={() => void onCreateProject()}
          >
            <span>Create project</span>
            <small>Start an empty episode</small>
          </button>
          <button
            type="button"
            data-testid="welcome-open-project"
            onClick={() => void onOpenProject()}
          >
            <span>Open project</span>
            <small>Continue from disk</small>
          </button>
        </div>
        <footer>
          <button
            type="button"
            className="welcome-tour"
            data-testid="welcome-tour"
            onClick={onTakeTour}
          >Take the tour <span aria-hidden="true">→</span></button>
          <button type="button" data-testid="welcome-skip" onClick={onSkip}>Skip</button>
        </footer>
      </div>
    </section>
  );
}
