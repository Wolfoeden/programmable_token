import { useEffect, useState } from "react";
import { api } from "../api";
import { ada } from "../format";
import { t } from "../i18n";
import { browserWallets, type WalletOption } from "../wallet";

export interface WalletDialogProps {
  demo: boolean;
  onPick: (opt: WalletOption) => void;
  onClose: () => void;
}

export function WalletDialog({ demo, onPick, onClose }: WalletDialogProps) {
  const [browser] = useState(() => browserWallets());
  const [demoList, setDemoList] = useState<Array<{ name: string; lovelace: string }>>([]);
  useEffect(() => {
    if (demo) api.demoWallets().then((r) => setDemoList(r.wallets)).catch(() => undefined);
  }, [demo]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t.walletTitle} onClick={(e) => e.stopPropagation()}>
        <h2>{t.walletTitle}</h2>
        {demo && (
          <>
            <div className="section-title">{t.demoWallets}</div>
            {demoList.map((w) => (
              <button key={w.name} type="button" className="wallet-option" onClick={() => onPick({ id: `demo:${w.name}`, name: w.name, kind: "demo" })}>
                <span aria-hidden>🧪</span>
                <span>{w.name}</span>
                <span className="spacer" />
                <span className="num muted">{ada(w.lovelace, 0)}</span>
              </button>
            ))}
          </>
        )}
        <div className="section-title">{t.browserWallets}</div>
        {browser.length === 0 && <p>{t.noWallets}</p>}
        {browser.map((w) => (
          <button key={w.id} type="button" className="wallet-option" onClick={() => onPick(w)}>
            {w.icon && <img src={w.icon} alt="" />}
            <span>{w.name}</span>
          </button>
        ))}
        {demo && browser.length > 0 && <p className="note">Im Demo-Modus läuft die Blockchain simuliert im Server. Browser-Wallets funktionieren nur auf dem Testnetz.</p>}
        <button type="button" className="btn flat" onClick={onClose}>
          {t.close}
        </button>
      </div>
    </div>
  );
}
