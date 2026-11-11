import { useEffect } from "react";
import { WEBCAMS } from "@flightradar/core/webcams";

export type InfoPage = "imprint" | "privacy" | "terms" | "support";

export const INFO_PAGES: Array<{ id: InfoPage; label: string }> = [
  { id: "imprint", label: "Imprint" },
  { id: "privacy", label: "Privacy" },
  { id: "terms", label: "Terms & demo rules" },
  { id: "support", label: "Support" },
];

/** Links to the info pages; repeated inside panels where the footer is covered (mobile). */
export function LegalLinks({ className = "legal-links" }: { className?: string }) {
  return (
    <nav className={className} aria-label="Site information">
      {INFO_PAGES.map((p) => (
        <a key={p.id} href={`#${p.id}`}>
          {p.label}
        </a>
      ))}
    </nav>
  );
}

function Missing({ items }: { items: string[] }) {
  return (
    <div className="missing">
      <strong>Not provided yet.</strong> This page is incomplete and is not a finished legal text. Still missing:
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Imprint() {
  return (
    <>
      <h2>Imprint / operator</h2>
      <Missing items={["Name or company of the operator", "Postal address", "Contact e-mail (and phone, if required)", "Responsible person for content", "Register and VAT details, if applicable"]} />
    </>
  );
}

function Privacy() {
  return (
    <>
      <h2>Privacy</h2>
      <Missing items={["Controller (name, address, contact)", "Legal bases for each processing", "Retention of hosting logs at Render", "Retention period of the bet log (model evaluation)", "Data processing agreement with the host", "How to exercise data-subject rights"]} />
      <h3>What this site actually does with data</h3>
      <p>This is a technical description of the data flows in the current code, not a complete privacy policy.</p>
      <ul>
        <li>
          <strong>Hosting.</strong> The site and its API are served by Render (region Frankfurt), which receives your IP address and request
          data when you load the site; its own logging applies.
        </li>
        <li>
          <strong>Map.</strong> Your browser loads map tiles, fonts and icons directly from OpenFreeMap (tiles.openfreemap.org), which receives your IP
          address.
        </li>
        <li>
          <strong>Live streams.</strong> No YouTube content loads until you click “Load live stream”. Then a player from youtube-nocookie.com (Google)
          loads and receives your IP address. Links to the original streams open YouTube in a new tab.
        </li>
        <li>
          <strong>Our server.</strong> When you create a prediction, your IP address is kept in memory for up to one hour to limit requests. When you
          bet, claim or cancel, your wallet address and the list of your wallet's unspent outputs are sent to build the transaction. Signed
          transactions are submitted to the blockchain; in demo mode that blockchain is simulated in the server's memory, on the testnet it is public.
          To evaluate the prediction model, the server logs each bet: time, prediction, side, stake, the odds shown, the model estimate at that time
          and a salted hash of the wallet address (not the address itself). It also logs the model's estimates and the observed landing for every
          listed flight; these contain no visitor data.
        </li>
        <li>
          <strong>Your browser.</strong> The app stores the name of the last wallet you chose in local storage (key <code>frf.wallet</code>). It sets
          no cookies and uses no analytics.
        </li>
        <li>
          <strong>Flight data.</strong> The server fetches aircraft positions from adsb.lol and adsb.fi and routes from adsbdb.com. No visitor data is
          sent to them. It stores market records and the position data behind each result; these contain no visitor data.
        </li>
        <li>
          <strong>Wallet extensions.</strong> Browser wallets such as Lace or Eternl run under their own terms.
        </li>
      </ul>
    </>
  );
}

function Terms() {
  return (
    <>
      <h2>Terms &amp; demo rules</h2>
      <Missing items={["Terms of use", "Operator details (see Imprint)", "Legal review of the demo and of any future real-money function"]} />
      <h3>Facts about this demo</h3>
      <ul>
        <li>
          This is a test. Stakes have no monetary value: in demo mode they are play money on a simulated blockchain, on the Cardano Preprod testnet
          they are test ADA from the public faucet. There is no real-money function.
        </li>
        <li>It has not been legally reviewed or approved.</li>
        <li>In demo mode, balances and positions are lost when the server restarts. The server may be unavailable at times.</li>
        <li>Predictions close at least 20 minutes before the estimated landing. Bets are logged to evaluate the model (see Privacy).</li>
        <li>
          Only flights of up to about five hours (departure airport within 3,800 km) that land within the next hour at one of these airports can get a prediction:{" "}
          {WEBCAMS.map((w) => w.name).join(", ")}.
        </li>
        <li>The exact settlement rules of each prediction are under “Rules &amp; settlement” on its card.</li>
      </ul>
    </>
  );
}

function Support() {
  return (
    <>
      <h2>Support / contact</h2>
      <Missing items={["A support or contact address", "Expected response channel and times"]} />
    </>
  );
}

export function InfoDialog({ page, onClose }: { page: InfoPage; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog info" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <nav className="info-nav">
          {INFO_PAGES.map((p) => (
            <a key={p.id} href={`#${p.id}`} className={p.id === page ? "active" : ""}>
              {p.label}
            </a>
          ))}
        </nav>
        {page === "imprint" && <Imprint />}
        {page === "privacy" && <Privacy />}
        {page === "terms" && <Terms />}
        {page === "support" && <Support />}
        <button type="button" className="btn flat" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
