import { useEffect, useRef, useState } from "react";
import type { AppWallet } from "../wallet";
import { INFO_PAGES } from "./InfoPages";

export interface SiteMenuProps {
  wallet: AppWallet | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onMyBets: () => void;
  onAbout: () => void;
}

/**
 * One button for everything that is not the map: wallet, bet history, how
 * it works and the site information pages. Click to open, click again (or
 * outside, or Escape) to close.
 */
export function SiteMenu(p: SiteMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="site-menu" ref={ref}>
      <button type="button" className={`btn menu-btn${open ? " active" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" aria-label="Menu">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {p.wallet ? (
            <>
              <div className="menu-wallet">
                {p.wallet.icon && <img src={p.wallet.icon} alt="" />}
                <span>{p.wallet.name}</span>
              </div>
              <button type="button" role="menuitem" onClick={pick(p.onMyBets)}>
                My bets
              </button>
              <button type="button" role="menuitem" onClick={pick(p.onDisconnect)}>
                Disconnect wallet
              </button>
            </>
          ) : (
            <button type="button" role="menuitem" onClick={pick(p.onConnect)}>
              Connect wallet
            </button>
          )}
          <hr />
          <button type="button" role="menuitem" onClick={pick(p.onAbout)}>
            How it works
          </button>
          {INFO_PAGES.map((page) => (
            <a key={page.id} role="menuitem" href={`#${page.id}`} onClick={() => setOpen(false)}>
              {page.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
