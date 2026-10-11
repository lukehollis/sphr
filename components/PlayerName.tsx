"use client";

import { useState } from "react";

/**
 * Before a shared tour or scavenger hunt starts, the player's name for its owner's class
 * results (lib/server/tour-plays.ts). Playing without a name is always an option.
 */
export default function PlayerName({ kind, onDone }: { kind: "tour" | "hunt"; onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  return <div className="player-name" role="dialog" aria-modal="true" aria-labelledby="player-name-title">
    <form className="player-name-panel" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onDone(name.trim()); }}>
      <h2 id="player-name-title">What&apos;s your name?</h2>
      <p>Your teacher sees it with how far you get in the {kind === "hunt" ? "hunt" : "tour"}.</p>
      <label htmlFor="player-name-input" className="sr-only">Your name</label>
      <input id="player-name-input" value={name} maxLength={40} autoComplete="off" autoFocus spellCheck={false}
        placeholder="First name and last initial" onChange={(event) => setName(event.target.value)} />
      <button type="submit" className="player-name-start" disabled={!name.trim()}>Start</button>
      <button type="button" className="player-name-skip" onClick={() => onDone("")}>Play without a name</button>
    </form>
  </div>;
}
