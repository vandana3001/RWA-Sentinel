import { useState, useCallback, useEffect } from "react";
import {
  connectWallet,
  invokeContract,
  isFreighterAvailable,
  getOpenTrip,
  getBalance,
  hasClaimedFaucet,
  claimFaucet,
  scSymbol,
  scAddress,
} from "./stellar";
import { CONTRACTS, OPERATORS, STATIONS } from "./config";
import "./App.css";

export const STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  SUCCESS: "success",
  ERROR: "error",
};

const TABS = [
  { id: "card", label: "Tap card" },
  { id: "book", label: "Book trip" },
  { id: "wallet", label: "Wallet" },
  { id: "activity", label: "Activity" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("card");

  const [publicKey, setPublicKey] = useState(null);
  const [walletStatus, setWalletStatus] = useState(STATUS.IDLE);
  const [walletError, setWalletError] = useState(null);
  const [freighterReady, setFreighterReady] = useState(false);
  const [freighterChecking, setFreighterChecking] = useState(true);

  const [operatorId, setOperatorId] = useState(OPERATORS[0].id);
  const [entryStation, setEntryStation] = useState(STATIONS[OPERATORS[0].id][0]);
  const [exitStation, setExitStation] = useState(STATIONS[OPERATORS[0].id][1]);

  const [tapStatus, setTapStatus] = useState(STATUS.IDLE);
  const [tapError, setTapError] = useState(null);
  const [lastTxHash, setLastTxHash] = useState(null);
  const [tripOpen, setTripOpen] = useState(false);
  const [tripSyncing, setTripSyncing] = useState(false);

  const [balance, setBalance] = useState(null);
  const [faucetStatus, setFaucetStatus] = useState(STATUS.IDLE);
  const [faucetError, setFaucetError] = useState(null);
  const [faucetClaimed, setFaucetClaimed] = useState(false);

  // isFreighterAvailable() round-trips a real message to the extension
  // (via @stellar/freighter-api) instead of just checking for an
  // injected object, so it's async. Poll briefly on mount since the
  // extension's content script can attach slightly after our first render.
  useEffect(() => {
    let attempts = 0;
    let cancelled = false;

    const check = async () => {
      if (cancelled) return;
      const available = await isFreighterAvailable();
      if (cancelled) return;

      if (available) {
        setFreighterReady(true);
        setFreighterChecking(false);
        return;
      }

      if (attempts < 10) {
        attempts += 1;
        setTimeout(check, 300);
      } else {
        setFreighterChecking(false);
      }
    };

    check();

    return () => {
      cancelled = true;
    };
  }, []);

  // Pulls the rider's real on-chain trip state and syncs local UI
  // state to match it. Used right after connecting, and again after
  // every tap, so the buttons never lie about what's actually on chain.
  const syncTripState = useCallback(async (key) => {
    setTripSyncing(true);
    try {
      const openTrip = await getOpenTrip(key);
      if (openTrip) {
        setTripOpen(true);
        setOperatorId(openTrip.operatorId);
        setEntryStation(openTrip.entryStation);
      } else {
        setTripOpen(false);
      }
    } catch {
      // Sync failure shouldn't block the UI - fall back to whatever
      // local state currently says, user can still act manually.
    } finally {
      setTripSyncing(false);
    }
  }, []);

  // Pulls the rider's real FARE balance and faucet-claim status.
  const syncBalanceState = useCallback(async (key) => {
    try {
      const [bal, claimed] = await Promise.all([
        getBalance(key),
        hasClaimedFaucet(key),
      ]);
      setBalance(bal);
      setFaucetClaimed(claimed);
    } catch {
      // leave previous values as-is on failure
    }
  }, []);

  const handleConnect = useCallback(async () => {
    setWalletStatus(STATUS.LOADING);
    setWalletError(null);
    try {
      const key = await connectWallet();
      setPublicKey(key);
      setWalletStatus(STATUS.SUCCESS);
      await syncTripState(key);
      await syncBalanceState(key);
    } catch (err) {
      setWalletError(err.message);
      setWalletStatus(STATUS.ERROR);
    }
  }, [syncTripState, syncBalanceState]);

  // Auto-claim the faucet the first time a new, unfunded wallet
  // connects - so a brand new user never has to know a faucet exists
  // or ask anyone to fund them. Only fires once balance/claim status
  // has actually loaded, and only if genuinely unclaimed.
  useEffect(() => {
    if (!publicKey) return;
    if (balance === null) return; // still loading
    if (faucetClaimed) return;
    if (balance > 0) return; // already has funds some other way
    if (faucetStatus === STATUS.LOADING || faucetStatus === STATUS.SUCCESS) return;

    (async () => {
      setFaucetStatus(STATUS.LOADING);
      setFaucetError(null);
      try {
        await claimFaucet(publicKey);
        setFaucetStatus(STATUS.SUCCESS);
        await syncBalanceState(publicKey);
      } catch (err) {
        setFaucetError(err.message);
        setFaucetStatus(STATUS.ERROR);
      }
    })();
  }, [publicKey, balance, faucetClaimed, faucetStatus, syncBalanceState]);

  const handleTapIn = useCallback(async () => {
    if (!publicKey) return;
    setTapStatus(STATUS.LOADING);
    setTapError(null);
    try {
      const { hash } = await invokeContract({
        contractId: CONTRACTS.transitController,
        method: "tap_in",
        args: [scAddress(publicKey), scSymbol(operatorId), scSymbol(entryStation)],
        sourcePublicKey: publicKey,
      });
      setLastTxHash(hash);
      setTapStatus(STATUS.SUCCESS);
      await syncTripState(publicKey);
      await syncBalanceState(publicKey);
    } catch (err) {
      setTapError(err.message);
      setTapStatus(STATUS.ERROR);
      await syncTripState(publicKey);
    }
  }, [publicKey, operatorId, entryStation, syncTripState, syncBalanceState]);

  const handleTapOut = useCallback(async () => {
    if (!publicKey) return;
    setTapStatus(STATUS.LOADING);
    setTapError(null);
    try {
      const { hash } = await invokeContract({
        contractId: CONTRACTS.transitController,
        method: "tap_out",
        args: [scAddress(publicKey), scSymbol(exitStation)],
        sourcePublicKey: publicKey,
      });
      setLastTxHash(hash);
      setTapStatus(STATUS.SUCCESS);
      await syncTripState(publicKey);
      await syncBalanceState(publicKey);
    } catch (err) {
      setTapError(err.message);
      setTapStatus(STATUS.ERROR);
      await syncTripState(publicKey);
    }
  }, [publicKey, exitStation, syncTripState, syncBalanceState]);

  const operatorLabel =
    OPERATORS.find((op) => op.id === operatorId)?.label || operatorId;
  const monogram = initials(operatorLabel);

  const tapInDisabled =
    !publicKey || tripOpen || tapStatus === STATUS.LOADING || tripSyncing;
  const tapOutDisabled =
    !publicKey || !tripOpen || tapStatus === STATUS.LOADING || tripSyncing;
  const primaryTapDisabled = tripOpen ? tapOutDisabled : tapInDisabled;
  const handlePrimaryTap = tripOpen ? handleTapOut : handleTapIn;

  return (
    <div className="app">
      <header className="app__header">
        <div className="brand">
          <RouteMark />
          <div>
            <p className="brand__name">Stellar One-Tap Transit Unified</p>
            <p className="brand__tag">One token. Every ride.</p>
          </div>
        </div>

        <button
          type="button"
          className={"wallet-chip" + (publicKey ? " wallet-chip--on" : "")}
          onClick={() => setActiveTab("wallet")}
        >
          {publicKey ? (
            <>
              <span className="wallet-chip__dot" />
              <span className="wallet-chip__addr">{shorten(publicKey)}</span>
              <span className="wallet-chip__bal">
                {balance === null ? "…" : `${balance} FARE`}
              </span>
            </>
          ) : (
            "Not connected"
          )}
        </button>
      </header>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={"tabs__item" + (activeTab === tab.id ? " tabs__item--active" : "")}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main className="app__main">
        {activeTab === "card" && (
          <section className="panel">
            {!publicKey ? (
              <ConnectPrompt onGoToWallet={() => setActiveTab("wallet")} />
            ) : (
              <>
                <div className={"transit-card" + (tripOpen ? " transit-card--open" : "")}>
                  <div className="transit-card__pattern" aria-hidden="true" />

                  <div className="transit-card__row">
                    <span className="transit-card__monogram">{monogram}</span>
                    <div className="transit-card__operator">
                      <span className="transit-card__operator-label">{operatorLabel}</span>
                      <span className={"status-pill" + (tripOpen ? " status-pill--open" : " status-pill--ready")}>
                        {tripOpen ? "Trip open" : "Ready to tap in"}
                      </span>
                    </div>
                  </div>

                  <div className="transit-card__stations">
                    <div className="transit-card__station">
                      <span className="transit-card__station-label">Entry</span>
                      <span className="transit-card__station-name">{entryStation}</span>
                    </div>
                    <span className="transit-card__arrow" aria-hidden="true">→</span>
                    <div className="transit-card__station">
                      <span className="transit-card__station-label">Exit</span>
                      <span className="transit-card__station-name">{exitStation}</span>
                    </div>
                  </div>

                  <div className="transit-card__footer">
                    <span className="transit-card__addr">{shorten(publicKey)}</span>
                    <span className="transit-card__bal">
                      {balance === null ? "loading…" : `${balance} FARE`}
                    </span>
                  </div>
                </div>

                <button
                  className={"btn btn--tap " + (tripOpen ? "btn--tap-out" : "btn--tap-in")}
                  onClick={handlePrimaryTap}
                  disabled={primaryTapDisabled}
                >
                  <TapIcon pulsing={tapStatus === STATUS.LOADING} />
                  {tapStatus === STATUS.LOADING
                    ? tripOpen ? "Tapping out…" : "Tapping in…"
                    : tripOpen ? `Tap out at ${exitStation}` : `Tap in at ${entryStation}`}
                </button>

                {tripSyncing && <p className="hint">Checking your trip status on-chain…</p>}
                {tapStatus === STATUS.ERROR && (
                  <p className="error" role="alert">{tapError}</p>
                )}
                {tapStatus === STATUS.SUCCESS && lastTxHash && (
                  <p className="success">
                    Confirmed. Tx:{" "}
                    <a
                      href={"https://stellar.expert/explorer/testnet/tx/" + lastTxHash}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shorten(lastTxHash)}
                    </a>
                  </p>
                )}

                <p className="panel__note">
                  Need a different operator or station?{" "}
                  <button type="button" className="link-btn" onClick={() => setActiveTab("book")}>
                    Book a trip
                  </button>
                </p>
              </>
            )}
          </section>
        )}

        {activeTab === "book" && (
          <section className="panel">
            <h2 className="panel__title">Book trip</h2>
            <p className="panel__subtitle">
              Choose where you're riding. This sets what your card will tap in and out with.
            </p>

            {tripOpen && (
              <p className="hint">
                You have an open trip on {operatorLabel} from {entryStation}. Tap out
                before changing operator or entry station.
              </p>
            )}

            <label className="field">
              <span className="field__label">Operator</span>
              <select
                value={operatorId}
                disabled={tripOpen}
                onChange={(e) => {
                  setOperatorId(e.target.value);
                  setEntryStation(STATIONS[e.target.value][0]);
                  setExitStation(STATIONS[e.target.value][1] || STATIONS[e.target.value][0]);
                }}
              >
                {OPERATORS.map((op) => (
                  <option key={op.id} value={op.id}>
                    {op.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="field-row">
              <label className="field">
                <span className="field__label">Entry station</span>
                <select
                  value={entryStation}
                  disabled={tripOpen}
                  onChange={(e) => setEntryStation(e.target.value)}
                >
                  {STATIONS[operatorId].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field__label">Exit station</span>
                <select value={exitStation} onChange={(e) => setExitStation(e.target.value)}>
                  {STATIONS[operatorId].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <button type="button" className="btn btn--primary" onClick={() => setActiveTab("card")}>
              Back to card
            </button>
          </section>
        )}

        {activeTab === "wallet" && (
          <section className="panel">
            <h2 className="panel__title">Wallet</h2>

            {!freighterChecking && !freighterReady && (
              <p className="hint">
                Freighter extension not detected. Install it from{" "}
                <a href="https://freighter.app" target="_blank" rel="noreferrer">
                  freighter.app
                </a>{" "}
                to continue.
              </p>
            )}

            {!publicKey ? (
              <button
                className="btn btn--primary"
                onClick={handleConnect}
                disabled={walletStatus === STATUS.LOADING}
              >
                {walletStatus === STATUS.LOADING ? "Connecting…" : "Connect Freighter"}
              </button>
            ) : (
              <div className="wallet-detail">
                <div className="wallet-detail__row">
                  <span className="wallet-detail__label">Address</span>
                  <code>{publicKey}</code>
                </div>
                <div className="wallet-detail__row">
                  <span className="wallet-detail__label">Balance</span>
                  <span>{balance === null ? "loading…" : `${balance} FARE`}</span>
                </div>

                {faucetStatus === STATUS.LOADING && (
                  <p className="hint">Claiming your starter FARE balance…</p>
                )}
                {faucetStatus === STATUS.SUCCESS && (
                  <p className="success">You received 500 FARE to get started.</p>
                )}
                {faucetStatus === STATUS.ERROR && faucetError && (
                  <p className="error" role="alert">Faucet claim failed: {faucetError}</p>
                )}
                {faucetClaimed && faucetStatus === STATUS.IDLE && (
                  <p className="panel__note">Starter faucet already claimed on this address.</p>
                )}
              </div>
            )}

            {walletStatus === STATUS.ERROR && (
              <p className="error" role="alert">{walletError}</p>
            )}
          </section>
        )}

        {activeTab === "activity" && (
          <section className="panel">
            <h2 className="panel__title">Activity</h2>

            {!publicKey ? (
              <ConnectPrompt onGoToWallet={() => setActiveTab("wallet")} />
            ) : (
              <>
                <div className="wallet-detail">
                  <div className="wallet-detail__row">
                    <span className="wallet-detail__label">Trip status</span>
                    <span className={"status-pill" + (tripOpen ? " status-pill--open" : " status-pill--ready")}>
                      {tripSyncing ? "Syncing…" : tripOpen ? "Open" : "Closed"}
                    </span>
                  </div>
                  {tripOpen && (
                    <>
                      <div className="wallet-detail__row">
                        <span className="wallet-detail__label">Operator</span>
                        <span>{operatorLabel}</span>
                      </div>
                      <div className="wallet-detail__row">
                        <span className="wallet-detail__label">Entry station</span>
                        <code>{entryStation}</code>
                      </div>
                    </>
                  )}
                  <div className="wallet-detail__row">
                    <span className="wallet-detail__label">Last transaction</span>
                    {lastTxHash ? (
                      <a
                        href={"https://stellar.expert/explorer/testnet/tx/" + lastTxHash}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shorten(lastTxHash)}
                      </a>
                    ) : (
                      <span className="panel__note">No taps yet this session</span>
                    )}
                  </div>
                </div>

                {tapStatus === STATUS.ERROR && (
                  <p className="error" role="alert">{tapError}</p>
                )}
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function ConnectPrompt({ onGoToWallet }) {
  return (
    <div className="connect-prompt">
      <p>Connect your wallet to see this.</p>
      <button type="button" className="btn btn--primary" onClick={onGoToWallet}>
        Go to Wallet
      </button>
    </div>
  );
}

function RouteMark() {
  return (
    <svg className="route-mark" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      <path
        d="M4 22c4 0 4-14 8-14s4 14 8 14 4-14 6-14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="4" cy="22" r="2.4" fill="currentColor" />
      <circle cx="26" cy="8" r="2.4" fill="currentColor" />
    </svg>
  );
}

function TapIcon({ pulsing }) {
  return (
    <svg
      className={"tap-icon" + (pulsing ? " tap-icon--pulsing" : "")}
      width="18"
      height="18"
      viewBox="0 0 18 18"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="3" fill="currentColor" />
      <circle cx="9" cy="9" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <circle cx="9" cy="9" r="8.4" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.3" />
    </svg>
  );
}

function initials(label) {
  if (!label) return "?";
  return label
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function shorten(value) {
  if (!value) return "";
  return value.slice(0, 6) + "..." + value.slice(-6);
}