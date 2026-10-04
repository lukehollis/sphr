/**
 * A script or stylesheet of the page that never arrived, usually because a phone's connection
 * dropped mid-download. The bundler keeps that failure until the page loads again, so the viewer
 * either waits at 0% forever (when the script failed before React asked for it) or the error page
 * shows. Both reload the page once instead. A second failure within a minute is left alone, so a
 * dead connection doesn't loop.
 */
export const reloadedAt = "sphr-reloaded-for-missing-part";
const quietFor = 60_000;

declare global { interface Window { __sphrMissingPart?: "reloading" | "reported" } }

export const isMissingPart = (error: Error) => error.name === "ChunkLoadError" || /Failed to load chunk/.test(error.message);

/** Reloads the page unless that already happened in the last minute. */
export function reloadOnce() {
  let reload = false;
  try {
    reload = Date.now() - Number(sessionStorage.getItem(reloadedAt) || 0) >= quietFor;
    if (reload) sessionStorage.setItem(reloadedAt, String(Date.now()));
  } catch { /* without storage a reload could loop */ }
  window.__sphrMissingPart = reload ? "reloading" : "reported";
  if (reload) window.location.reload();
  return reload;
}

/**
 * Runs in <head> before the page's own scripts can fail, and catches them while the page is still
 * loading. Later failures (a part loaded on demand) reach app/error.tsx instead. `report` sends the
 * failure to the site's analytics in the shape components/Analytics.tsx uses.
 */
export function missingPartScript(report: boolean) {
  const send = `if(!/^\\/admin(\\/|$)/.test(location.pathname))try{navigator.sendBeacon("/api/steps",JSON.stringify({events:[{name:"client_error",path:location.host+location.pathname,props:{kind:"load",message:"ChunkLoadError: Failed to load "+src.replace(location.origin,"").split("?")[0],source:reload?"reloaded the page":"still failing after a reload"}}],referrer:document.referrer||null,url:location.origin+location.pathname}))}catch(x){}`;
  return `(function(){addEventListener("error",function(e){var t=e.target,src=t&&(t.src||t.href)||"",reload=false;`
    + `if(window.__sphrMissingPart||document.readyState==="complete"||!(t&&(t.tagName==="SCRIPT"||t.tagName==="LINK"&&t.rel==="stylesheet"))||src.indexOf("/_next/static/")<0)return;`
    + `try{reload=Date.now()-Number(sessionStorage.getItem(${JSON.stringify(reloadedAt)})||0)>=${quietFor};if(reload)sessionStorage.setItem(${JSON.stringify(reloadedAt)},String(Date.now()))}catch(x){}`
    + `window.__sphrMissingPart=reload?"reloading":"reported";${report ? send : ""}if(reload)location.reload()},true)})();`;
}
