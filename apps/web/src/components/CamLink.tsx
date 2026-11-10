import { webcamFor } from "@flightradar/core/webcams";
import { t } from "../i18n";

export function CamLink({ icao }: { icao: string | undefined }) {
  const cam = webcamFor(icao);
  if (!cam) return null;
  return (
    <a className="cam-link" href={cam.url} target="_blank" rel="noopener noreferrer">
      <span aria-hidden>📹</span>
      <span>
        {cam.kind === "video" ? t.webcam : t.webcamStill} <small>{[icao, cam.note].filter(Boolean).join(" · ")}</small>
      </span>
    </a>
  );
}
