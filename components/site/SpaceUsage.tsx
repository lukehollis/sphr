/**
 * How many spaces the account has against what its plan covers, in large type ("24 / 30"), so a plan
 * too small is plain before anyone picks it. `limit` is null on pay as you go or without a plan.
 */
export default function SpaceUsage({ used, limit, plan }: { used: number; limit: number | null; plan?: string | null }) {
  const full = limit !== null && used >= limit;
  const noun = (limit ?? used) === 1 ? "space" : "spaces";
  const detail = limit === null
    ? plan ? "Billed for each space you host." : used ? `Plans that cover fewer than ${used} ${used === 1 ? "space" : "spaces"} can't be chosen.` : "Your first capture is a free preview."
    : used > limit ? "More than your plan covers. Choose a larger plan below."
    : full ? "Your plan is full. A larger plan adds room." : `Room for ${limit - used} more.`;
  return <section className={`space-usage${full ? " space-usage-full" : ""}`} aria-label="Spaces on your account">
    <p className="space-usage-count"><b>{used}</b>{limit !== null && <span>/ {limit}</span>}</p>
    <div className="space-usage-text">
      <strong>{noun} {limit !== null ? `in use on ${plan ?? "your plan"}` : plan ? `on ${plan}` : "on your account"}</strong>
      <span>{detail}</span>
      {limit !== null && limit > 0 && <i aria-hidden="true"><em style={{ width: `${Math.min(100, used / limit * 100)}%` }} /></i>}
    </div>
  </section>;
}
