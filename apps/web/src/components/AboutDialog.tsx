import { useEffect } from "react";
import { WEBCAMS } from "@flightradar/core/webcams";
import { t } from "../i18n";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t.aboutTitle} onClick={(e) => e.stopPropagation()}>
        <h2>{t.aboutTitle}</h2>
        <p>
          The map shows flights that will land within the next hour at airports with a live stream: {WEBCAMS.map((w) => w.name).join(", ")}. Click one,
          bet on when it touches down or which of several flights lands first, then watch it land on the stream.
        </p>
        <p>
          <strong>Odds from the pool.</strong> Every outcome has a pool. Its probability is its share of all stakes. Winners split all pools pro
          rata, so every new bet moves the odds.
        </p>
        <p>
          <strong>Starting odds.</strong> Each market starts with a small stake from the operator, split by the status quo: the arrival estimate
          from position and speed.
        </p>
        <p>
          <strong>Programmable tokens.</strong> Every stake mints CIP-68 position tokens, one per lovelace. After the result, winning tokens are
          burned and redeemed for ADA. The contract checks every payout.
        </p>
        <p>
          <strong>Fee.</strong> 3 % of the losing pool. Winners never get back less than their stake.
        </p>
        <p>
          <strong>Voiding.</strong> If a flight lands elsewhere or no landing is observed, the market is voided and all stakes are refunded. There
          are deliberately no markets on crashes, diversions or emergencies: nobody should profit from something going wrong.
        </p>
        <p className="note">{t.attribution}</p>
        <button type="button" className="btn flat" onClick={onClose}>
          {t.close}
        </button>
      </div>
    </div>
  );
}
