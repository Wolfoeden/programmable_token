import { useEffect, useState } from "react";
import { webcamFor } from "@flightradar/core/webcams";
import { api } from "../api";
import type { StreamInfo } from "../types";

/**
 * The airport's live stream. Loads the YouTube player only after a click
 * (privacy-friendly youtube-nocookie domain) and falls back to a link to
 * the original source when the video cannot be embedded.
 */
/** Once the viewer has loaded a player in this tab, later streams load directly. */
let consented = false;

export function LiveStream({ icao }: { icao: string }) {
  const cam = webcamFor(icao);
  const [info, setInfo] = useState<StreamInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [play, setPlay] = useState(consented);
  useEffect(() => {
    setInfo(null);
    setFailed(false);
    setPlay(consented);
    let alive = true;
    api
      .stream(icao)
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [icao]);
  if (!cam) return null;

  const caption = <div className="stream-caption">The camera shows the airport and may not show this aircraft.</div>;
  const external = (
    <a className="watch-ext" href={cam.url} target="_blank" rel="noopener noreferrer" aria-label="Open the camera on YouTube" onClick={(e) => e.stopPropagation()}>
      ↗
    </a>
  );

  if (!info && !failed) return <div className="watch-card muted">Checking the airport camera …</div>;
  if (failed || !info?.embeddable || !info.videoId) {
    // Not embeddable: the card opens the original stream instead.
    return (
      <div className="stream">
        <a className="watch-card" href={cam.url} target="_blank" rel="noopener noreferrer">
          <span className="watch-play" aria-hidden>
            ▶
          </span>
          <span className="watch-text">
            <strong>Watch the approach</strong>
            <small>{cam.name} airport camera · opens YouTube</small>
          </span>
          <span className="watch-ext">↗</span>
        </a>
        {caption}
      </div>
    );
  }
  return (
    <div className="stream">
      {play ? (
        <iframe
          className="stream-frame"
          src={`https://www.youtube-nocookie.com/embed/${info.videoId}?autoplay=1&mute=1&playsinline=1`}
          title={`Live stream ${cam.name}`}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          className="watch-card"
          title="Loads a YouTube player (Google), which receives your IP address."
          onClick={() => {
            consented = true;
            setPlay(true);
          }}
        >
          <span className="watch-play" aria-hidden>
            ▶
          </span>
          <span className="watch-text">
            <strong>Watch the approach</strong>
            <small>{cam.name} airport camera</small>
          </span>
          {external}
        </button>
      )}
      {caption}
      {!play && <div className="stream-caption small">Playing loads YouTube (Google), which receives your IP address.</div>}
    </div>
  );
}
