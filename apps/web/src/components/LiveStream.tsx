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

  const caption = (
    <div className="stream-caption">
      Live camera at {cam.name} ({icao}){cam.note ? `, ${cam.note}` : ""}. It shows the airport, not necessarily this aircraft.
    </div>
  );
  const sourceLink = (
    <a href={cam.url} target="_blank" rel="noopener noreferrer">
      Open the original stream on YouTube
    </a>
  );

  if (!info && !failed) return <div className="stream stream-fallback">Checking the live stream …</div>;
  if (failed || !info?.embeddable || !info.videoId) {
    return (
      <div className="stream">
        <div className="stream-fallback">
          <div>The stream can't be shown here. {info?.reason ?? "The check did not respond."}</div>
          {sourceLink}
        </div>
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
        <button type="button" className="stream-frame stream-load" onClick={() => {
            consented = true;
            setPlay(true);
          }}>
          <span className="stream-play" aria-hidden>
            ▶
          </span>
          <span>Load live stream</span>
          <small>Loads a YouTube player (Google) and sends your IP address to YouTube.</small>
        </button>
      )}
      {caption}
      <div className="stream-caption">
        If the broadcast is offline, YouTube shows that in the player. {sourceLink}
      </div>
    </div>
  );
}
