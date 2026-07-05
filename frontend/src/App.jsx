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
  getAccountHistory,
  streamAccountHistory,
  operationLabel,
} from "./stellar";
import { CONTRACTS, OPERATORS, STATIONS } from "./config";
import "./App.css";

export const STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  SUCCESS: "success",
  ERROR: "error",
};

const NAV = [
  { id: "book", label: "Book trip", icon: IconTicket },
  { id: "card", label: "Tap card", icon: IconCard },
  { id: "wallet", label: "Wallet", icon: IconWallet },
  { id: "activity", label: "Activity", icon: IconActivity },
  { id: "history", label: "Chain history", icon: IconHistory },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("book");

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
  const [activityLog, setActivityLog] = useState([]);

  const [balance, setBalance] = useState(null);
  const [faucetStatus, setFaucetStatus] = useState(STATUS.IDLE);
  const [faucetError, setFaucetError] = useState(null);
  const [faucetClaimed, setFaucetClaimed] = useState(false);

  // Real, on-chain transaction history for the connected wallet (via
  // Horizon), plus a live SSE subscription so new operations appear
  // the moment they confirm - not just the ones made in this session.
  const [chainHistory, setChainHistory] = useState([]);
  const [historyStatus, setHistoryStatus] = useState(STATUS.IDLE);
  const [historyError, setHistoryError] = useState(null);
  const [historyLive, setHistoryLive] = useState(false);

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

  // Loads real on-chain history for the connected wallet from Horizon,
  // then opens a live SSE stream so newly-confirmed operations (taps,
  // faucet claims, anything) appear in real time without polling.
  // Torn down on disconnect/unmount so we never leak an open stream.
  useEffect(() => {
    if (!publicKey) {
      setChainHistory([]);
      setHistoryStatus(STATUS.IDLE);
      setHistoryError(null);
      setHistoryLive(false);
      return;
    }

    let cancelled = false;
    let unsubscribe = null;

    (async () => {
      setHistoryStatus(STATUS.LOADING);
      setHistoryError(null);
      try {
        const initial = await getAccountHistory(publicKey, 20);
        if (cancelled) return;
        setChainHistory(initial);
        setHistoryStatus(STATUS.SUCCESS);
      } catch (err) {
        if (cancelled) return;
        setHistoryError(err.message);
        setHistoryStatus(STATUS.ERROR);
      }

      if (cancelled) return;
      unsubscribe = streamAccountHistory(publicKey, {
        onOperation: (op) => {
          setHistoryLive(true);
          setChainHistory((prev) =>
            prev.some((p) => p.id === op.id) ? prev : [op, ...prev]
          );
        },
        onError: () => setHistoryLive(false),
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [publicKey]);

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
      setActivityLog((prev) => [
        { type: "tap_in", hash, station: entryStation, operatorId, time: new Date() },
        ...prev,
      ]);
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
      setActivityLog((prev) => [
        { type: "tap_out", hash, station: exitStation, operatorId, time: new Date() },
        ...prev,
      ]);
      await syncTripState(publicKey);
      await syncBalanceState(publicKey);
    } catch (err) {
      setTapError(err.message);
      setTapStatus(STATUS.ERROR);
      await syncTripState(publicKey);
    }
  }, [publicKey, exitStation, operatorId, syncTripState, syncBalanceState]);

  const operatorLabel = OPERATORS.find((op) => op.id === operatorId)?.label || operatorId;
  const monogram = initials(operatorLabel);

  const tapInDisabled = !publicKey || tripOpen || tapStatus === STATUS.LOADING || tripSyncing;
  const tapOutDisabled = !publicKey || !tripOpen || tapStatus === STATUS.LOADING || tripSyncing;
  const primaryTapDisabled = tripOpen ? tapOutDisabled : tapInDisabled;
  const handlePrimaryTap = tripOpen ? handleTapOut : handleTapIn;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <RouteMark />
          <div>
            <p className="brand__name">Stellar Transit</p>
            <p className="brand__tag">One token. Every ride.</p>
          </div>
        </div>

        <nav className="sidebar__nav" aria-label="Sections">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                data-tab={item.id}
                className={"nav-item" + (activeTab === item.id ? " nav-item--active" : "")}
                onClick={() => setActiveTab(item.id)}
              >
                <Icon />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <span className="network-pill">Stellar · Testnet</span>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="topbar__titlewrap">
            <p className="topbar__eyebrow">Stellar Transit Unified</p>
            <h1 className="topbar__title">
              <img
                className="stellar-logo"
                src="/stellar-logo.png"
                alt="Stellar"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
            </h1>
          </div>

          <button
            type="button"
            className={"wallet-chip" + (publicKey ? " wallet-chip--on" : "")}
            onClick={() => setActiveTab("wallet")}
          >
            {publicKey ? (
              <>
                <span className="wallet-chip__addr">{shorten(publicKey)}</span>
                <span className="wallet-chip__bal">
                  {balance === null ? "…" : `${balance} FARE`}
                </span>
              </>
            ) : (
              "Connect wallet"
            )}
          </button>
        </header>

        <div className="section-accent" data-tab={activeTab} />

        <nav className="mobile-nav" aria-label="Sections (compact)">
          {NAV.map((item) => (
            <button
              key={item.id}
              data-tab={item.id}
              className={"mobile-nav__item" + (activeTab === item.id ? " mobile-nav__item--active" : "")}
              onClick={() => setActiveTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <main className="page">
          {activeTab === "card" && (
            <div className="grid-2">
              <section className="card-panel">
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
                          <span
                            className={
                              "status-pill" + (tripOpen ? " status-pill--open" : " status-pill--ready")
                            }
                          >
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
                      {tapStatus === STATUS.LOADING
                        ? tripOpen ? "Tapping out…" : "Tapping in…"
                        : tripOpen ? `Tap out at ${exitStation}` : `Tap in at ${entryStation}`}
                    </button>

                    {tripSyncing && <p className="hint">Checking your trip status on-chain…</p>}
                    {tapStatus === STATUS.ERROR && <p className="error" role="alert">{tapError}</p>}
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
                      Riding somewhere else?{" "}
                      <button type="button" className="link-btn" onClick={() => setActiveTab("book")}>
                        Book a trip
                      </button>
                    </p>
                  </>
                )}
              </section>

              <aside className="stat-column">
                <div className="stat-card">
                  <span className="stat-card__label">Balance</span>
                  <span className="stat-card__value stat-card__value--go">
                    {balance === null ? "—" : balance}
                  </span>
                  <span className="stat-card__unit">FARE</span>
                </div>

                <div className="stat-card">
                  <span className="stat-card__label">Trip status</span>
                  <span
                    className={"status-pill" + (tripOpen ? " status-pill--open" : " status-pill--ready")}
                  >
                    {tripSyncing ? "Syncing…" : tripOpen ? "Open" : "Closed"}
                  </span>
                  {tripOpen && <span className="stat-card__hint">on {operatorLabel}</span>}
                </div>

                <div className="stat-card">
                  <span className="stat-card__label">Last transaction</span>
                  {lastTxHash ? (
                    <a
                      className="stat-card__link"
                      href={"https://stellar.expert/explorer/testnet/tx/" + lastTxHash}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shorten(lastTxHash)}
                    </a>
                  ) : (
                    <span className="stat-card__hint">No taps yet this session</span>
                  )}
                </div>
              </aside>
            </div>
          )}

          {activeTab === "book" && (
            <div className="grid-2">
              <section className="card-panel">
                <h2 className="panel__title">Book trip</h2>
                <p className="panel__subtitle">
                  Choose an operator and stations. This sets what your card taps in and out with.
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
                  Use this route
                </button>
              </section>

              <aside className="route-panel">
                <h3 className="route-panel__title">{operatorLabel} route</h3>
                <ol className="route-line">
                  {STATIONS[operatorId].map((station) => {
                    const isEntry = station === entryStation;
                    const isExit = station === exitStation;
                    return (
                      <li
                        key={station}
                        className={
                          "route-line__stop" +
                          (isEntry ? " route-line__stop--entry" : "") +
                          (isExit ? " route-line__stop--exit" : "")
                        }
                      >
                        <span className="route-line__dot" />
                        <span className="route-line__name">{station}</span>
                        {isEntry && <span className="route-line__tag route-line__tag--entry">Entry</span>}
                        {isExit && <span className="route-line__tag route-line__tag--exit">Exit</span>}
                      </li>
                    );
                  })}
                </ol>
              </aside>
            </div>
          )}

          {activeTab === "wallet" && (
            <div className="grid-3">
              <section className="card-panel">
                <h2 className="panel__title">Connection</h2>

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
                  </div>
                )}

                {walletStatus === STATUS.ERROR && <p className="error" role="alert">{walletError}</p>}
              </section>

              <section className="card-panel">
                <h2 className="panel__title">Balance</h2>
                <div className="big-number">
                  {balance === null ? "…" : balance}
                  <span className="big-number__unit">FARE</span>
                </div>
                <p className="panel__note">Available for your next tap-in hold.</p>
              </section>

              <section className="card-panel">
                <h2 className="panel__title">Starter faucet</h2>
                {faucetStatus === STATUS.LOADING && <p className="hint">Claiming your starter FARE balance…</p>}
                {faucetStatus === STATUS.SUCCESS && (
                  <p className="success">You received 500 FARE to get started.</p>
                )}
                {faucetStatus === STATUS.ERROR && faucetError && (
                  <p className="error" role="alert">Faucet claim failed: {faucetError}</p>
                )}
                {faucetClaimed && faucetStatus === STATUS.IDLE && (
                  <p className="panel__note">Already claimed on this address.</p>
                )}
                {!publicKey && <p className="panel__note">Connect a wallet to check faucet status.</p>}
              </section>
            </div>
          )}

          {activeTab === "activity" && (
            <div className="grid-2">
              <section className="card-panel">
                <h2 className="panel__title">Trip status</h2>
                {!publicKey ? (
                  <ConnectPrompt onGoToWallet={() => setActiveTab("wallet")} />
                ) : (
                  <div className="wallet-detail">
                    <div className="wallet-detail__row">
                      <span className="wallet-detail__label">Status</span>
                      <span
                        className={
                          "status-pill" + (tripOpen ? " status-pill--open" : " status-pill--ready")
                        }
                      >
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
                    {tapStatus === STATUS.ERROR && <p className="error" role="alert">{tapError}</p>}
                  </div>
                )}
              </section>

              <section className="card-panel">
                <h2 className="panel__title">Session timeline</h2>
                {activityLog.length === 0 ? (
                  <p className="panel__note">Taps you make in this session will show up here.</p>
                ) : (
                  <ul className="timeline">
                    {activityLog.map((entry, i) => (
                      <li key={entry.hash + i} className="timeline__item">
                        <div className="timeline__body">
                          <p className="timeline__title">
                            {entry.type === "tap_in" ? "Tapped in" : "Tapped out"} at {entry.station}
                          </p>
                          <p className="timeline__meta">
                            {entry.time.toLocaleTimeString()} ·{" "}
                            <a
                              href={"https://stellar.expert/explorer/testnet/tx/" + entry.hash}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {shorten(entry.hash)}
                            </a>
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}

          {activeTab === "history" && (
            <div className="grid-2">
              <section className="card-panel history-panel">
                <div className="history-panel__heading">
                  <h2 className="panel__title">On-chain history</h2>
                  {historyLive && (
                    <span className="live-badge">
                      <span className="live-badge__dot" aria-hidden="true" />
                      Live
                    </span>
                  )}
                </div>

                {!publicKey ? (
                  <ConnectPrompt onGoToWallet={() => setActiveTab("wallet")} />
                ) : (
                  <>
                    <p className="panel__subtitle">
                      Every operation on this address, read directly from Horizon and
                      updated in real time as new transactions confirm.
                    </p>

                    {historyStatus === STATUS.LOADING && (
                      <p className="hint">Loading transaction history…</p>
                    )}
                    {historyStatus === STATUS.ERROR && (
                      <p className="error" role="alert">{historyError}</p>
                    )}
                    {historyStatus === STATUS.SUCCESS && chainHistory.length === 0 && (
                      <p className="panel__note">No on-chain activity yet for this address.</p>
                    )}

                    {chainHistory.length > 0 && (
                      <ul className="timeline">
                        {chainHistory.map((op) => (
                          <li key={op.id} className="timeline__item">
                            <div className="timeline__body">
                              <p className="timeline__title">
                                {operationLabel(op.type)}
                                {!op.successful && (
                                  <span className="op-pill op-pill--failed">failed</span>
                                )}
                              </p>
                              <p className="timeline__meta">
                                {new Date(op.createdAt).toLocaleString()} ·{" "}
                                <a
                                  href={"https://stellar.expert/explorer/testnet/tx/" + op.txHash}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {shorten(op.txHash)}
                                </a>
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>

              <aside className="stat-column">
                <div className="stat-card">
                  <span className="stat-card__label">Source</span>
                  <span className="stat-card__value" style={{ fontSize: "1rem" }}>
                    Horizon
                  </span>
                  <span className="stat-card__unit">testnet operations feed</span>
                </div>

                <div className="stat-card">
                  <span className="stat-card__label">Stream status</span>
                  <span
                    className={
                      "status-pill" + (historyLive ? " status-pill--ready" : " status-pill--open")
                    }
                  >
                    {historyLive ? "Connected" : "Not streaming"}
                  </span>
                  <span className="stat-card__hint">
                    {publicKey ? "New taps appear here automatically" : "Connect a wallet to start"}
                  </span>
                </div>

                <div className="stat-card">
                  <span className="stat-card__label">Operations loaded</span>
                  <span className="stat-card__value stat-card__value--go">
                    {chainHistory.length}
                  </span>
                  <span className="stat-card__unit">most recent shown first</span>
                </div>
              </aside>
            </div>
          )}
        </main>
      </div>
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
    <svg className="route-mark" width="28" height="28" viewBox="0 0 30 30" aria-hidden="true">
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

function IconCard() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.5" cy="11" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <line x1="4" y1="7" x2="8.5" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconTicket() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2 6.5A1.5 1.5 0 0 1 3.5 5h11A1.5 1.5 0 0 1 16 6.5v1a1.3 1.3 0 0 0 0 2.6v1A1.5 1.5 0 0 1 14.5 13h-11A1.5 1.5 0 0 1 2 11.5v-1a1.3 1.3 0 0 0 0-2.6z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <line x1="10.5" y1="5.5" x2="10.5" y2="12.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.6" />
    </svg>
  );
}

function IconWallet() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2" y="5" width="14" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 7.5h14" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.5" cy="10.8" r="1" fill="currentColor" />
    </svg>
  );
}

function IconActivity() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2 9.5h3l2-5 3 9 2-7 1.5 3H16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconHistory() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9.5" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9 6v3.5l2.5 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4.5 4.5 3 3M13.5 4.5 15 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
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