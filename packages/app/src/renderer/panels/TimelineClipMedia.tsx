import type { TimelineClipMediaState } from "./timeline-media.js";

function waveformPath(
  columns: TimelineClipMediaState["waveform"],
): string {
  return columns.map(({ minimum, maximum }, index) => {
    const top = 50 - maximum / 127 * 46;
    const bottom = 50 - minimum / 127 * 46;
    return `M${String(index + 0.5)} ${top.toFixed(3)}V${bottom.toFixed(3)}`;
  }).join("");
}

export function TimelineClipMedia({
  clipId,
  durationFrames,
  media,
}: {
  clipId: string;
  durationFrames: number;
  media: TimelineClipMediaState;
}): React.JSX.Element {
  return (
    <>
      {media.hasVideo ? (
        <span
          className="timeline-filmstrip"
          data-testid={`timeline-filmstrip-${clipId}`}
          aria-hidden="true"
        >
          {media.sourceFrames.map((sourceFrame, index) => {
            const url = media.frameUrls[index] ?? null;
            return url === null
              ? <i key={sourceFrame} />
              : <img key={sourceFrame} src={url} alt="" draggable={false} />;
          })}
        </span>
      ) : null}
      {media.hasVideo && media.hasAudio
        ? <span className="timeline-media-scrim" aria-hidden="true" />
        : null}
      {media.hasAudio ? (
        <svg
          className="timeline-waveform"
          data-state={media.waveform.length === 0 ? "baseline" : "ready"}
          data-testid={`timeline-waveform-${clipId}`}
          viewBox={`0 0 ${String(Math.max(1, media.waveform.length))} 100`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {media.waveform.length === 0
            ? <line x1="0" y1="50" x2="1" y2="50" />
            : <path d={waveformPath(media.waveform)} />}
        </svg>
      ) : null}
      <span className="timeline-clip-label">{clipId}</span>
      <small className="timeline-clip-duration">{durationFrames}f</small>
    </>
  );
}
