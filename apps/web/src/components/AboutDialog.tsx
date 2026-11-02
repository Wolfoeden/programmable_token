import { useEffect } from "react";
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
          Klick ein Flugzeug an und wette darauf, wann es landet, ob es sich verspätet oder welches von mehreren Flugzeugen zuerst landet. Über
          Flughäfen gibt es Märkte auf Ausfälle.
        </p>
        <p>
          <strong>Quoten aus dem Pool.</strong> Jeder Ausgang hat einen Topf. Die Wahrscheinlichkeit ist der Anteil des Topfs am Gesamteinsatz. Wer
          richtig liegt, teilt sich am Ende alle Töpfe anteilig. Deshalb verschieben neue Wetten die Quote.
        </p>
        <p>
          <strong>Startquote.</strong> Jeder Markt startet mit einem kleinen Einsatz des Betreibers, verteilt nach dem Status quo: geschätzte
          Ankunftszeit aus Position und Geschwindigkeit, veröffentlichte Pünktlichkeits- und Ausfallquoten.
        </p>
        <p>
          <strong>Programmierbare Token.</strong> Jeder Einsatz prägt Positions-Token nach CIP-68, ein Token pro Lovelace. Nach der Entscheidung
          werden die Gewinner-Token verbrannt und gegen ADA eingelöst. Der Vertrag prüft jede Auszahlung.
        </p>
        <p>
          <strong>Gebühr.</strong> 3 % vom Verliererpool. Gewinner bekommen nie weniger als ihren Einsatz zurück.
        </p>
        <p>
          <strong>Annullierung.</strong> Landet ein Flug woanders als geplant oder fehlen Daten, wird der Markt annulliert und alle Einsätze werden
          erstattet. Wetten auf Abstürze, Umleitungen oder Notfälle gibt es bewusst nicht: Niemand soll daran verdienen, dass etwas schiefgeht.
        </p>
        <p className="note">{t.attribution}</p>
        <button type="button" className="btn flat" onClick={onClose}>
          {t.close}
        </button>
      </div>
    </div>
  );
}
