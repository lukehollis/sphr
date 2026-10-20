/**
 * A script or stylesheet of the page that never arrived, usually because a phone's connection
 * dropped mid-download. The bundler keeps that failure until the page loads again, so the viewer
 * either waits at 0% forever (when the script failed before React asked for it) or the error page
 * shows. Both reload the page once instead. A second failure within a minute is left alone, so a
 * dead connection doesn't loop.
 *
 * Some networks refuse a part every time: on 2026-10-20 a school district's Zscaler proxy refused the
 * framework chunk to nearly every student who opened the Great Pyramid tour inside mused.com. So a
 * second failure asks for the part again to learn what the network answers (sent as `detail`), tells
 * a framing page (`spacery:failed`), and shows the visitor a way on: the framing tour's classic
 * version on mused.com, or another try.
 */
export const reloadedAt = "sphr-reloaded-for-missing-part";
/** Where the visitor came from, kept across the reload (in a frame the reloaded page loses its referrer). */
export const cameFrom = "sphr-missing-part-referrer";
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
 * failure to the site's analytics in the shape components/Analytics.tsx uses. Plain ES5: it runs
 * before anything else on the page, in any browser.
 */
export function missingPartScript(report: boolean) {
  return `(function(){var key=${JSON.stringify(reloadedAt)},from=${JSON.stringify(cameFrom)};`
    + `function framed(){try{return top!==self}catch(x){return true}}`
    + `function send(src,reload,detail,referrer){if(!${report}||/^\\/admin(\\/|$)/.test(location.pathname))return;try{`
    + `var props={kind:"load",message:"ChunkLoadError: Failed to load "+src.replace(location.origin,"").split("?")[0],source:reload?"reloaded the page":"still failing after a reload"};`
    + `if(detail)props.detail=detail;var body={events:[{name:"client_error",path:location.host+location.pathname,props:props}],referrer:referrer||null,url:location.origin+location.pathname};`
    + `if(framed())body.framed=true;navigator.sendBeacon("/api/steps",JSON.stringify(body))}catch(x){}}`
    // What the network answers for the part: a proxy's block page, a status, or no answer at all.
    + `function probe(src,done){var over=false,end=function(text){if(!over){over=true;done(String(text).slice(0,200))}};setTimeout(function(){end("no answer in 8 s")},8000);`
    + `try{fetch(src,{cache:"no-store",credentials:"omit"}).then(function(r){return r.text().then(function(t){`
    + `end("HTTP "+r.status+" "+(r.headers.get("content-type")||"no type")+(r.headers.get("cf-ray")?"":", not from Cloudflare")+(r.headers.get("server")?", server "+r.headers.get("server"):"")+": "+t.replace(/\\s+/g," ").slice(0,90))})})`
    + `.catch(function(e){end("fetch failed: "+(e&&e.message||e))})}catch(x){end("fetch unavailable")}}`
    // A tour framed on mused.com has a classic version there; anywhere else, another try.
    + `function classic(referrer){try{var u=new URL(referrer);if(!/(^|\\.)mused\\.com$/.test(u.hostname))return null;u.searchParams.set("version","classic");return u.href}catch(x){return null}}`
    + `function notice(referrer){var link=classic(referrer),show=function(){if(document.getElementById("sphr-missing-part"))return;`
    + `var box=document.createElement("div"),inner=document.createElement("div"),title=document.createElement("p"),text=document.createElement("p"),go=document.createElement("a");`
    + `box.id="sphr-missing-part";box.setAttribute("role","alert");`
    + `box.style.cssText="position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:#0b0b0c;color:#f4f4f4;font:16px/1.5 system-ui,-apple-system,sans-serif;text-align:center";`
    + `inner.style.maxWidth="420px";title.style.cssText="margin:0 0 8px;font-size:20px;font-weight:600";text.style.cssText="margin:0 0 20px;color:#c8c8c8";`
    + `go.style.cssText="display:inline-block;padding:12px 22px;border-radius:999px;background:#e03c31;color:#fff;text-decoration:none;font-weight:600";`
    + `title.textContent="This tour could not load here";text.textContent="Your network blocked part of it, as some school and work networks do.";`
    + `if(link){go.href=link;go.target="_top";go.textContent="Open the classic tour"}else{go.href=location.href;go.textContent="Try again"}`
    + `inner.appendChild(title);inner.appendChild(text);inner.appendChild(go);box.appendChild(inner);document.body.appendChild(box)};`
    + `if(document.body)show();else addEventListener("DOMContentLoaded",show)}`
    + `addEventListener("error",function(e){var t=e.target,src=t&&(t.src||t.href)||"",reload=false,referrer=document.referrer||"";`
    + `if(window.__sphrMissingPart||document.readyState==="complete"||!(t&&(t.tagName==="SCRIPT"||t.tagName==="LINK"&&t.rel==="stylesheet"))||src.indexOf("/_next/static/")<0)return;`
    + `try{reload=Date.now()-Number(sessionStorage.getItem(key)||0)>=${quietFor};`
    + `if(reload){sessionStorage.setItem(key,String(Date.now()));if(referrer)sessionStorage.setItem(from,referrer)}else if(!referrer)referrer=sessionStorage.getItem(from)||""}catch(x){}`
    + `window.__sphrMissingPart=reload?"reloading":"reported";`
    + `if(reload){send(src,true,"",referrer);location.reload();return}`
    + `try{if(framed())parent.postMessage({type:"spacery:failed",reason:"missing-part"},"*")}catch(x){}`
    + `notice(referrer);probe(src,function(detail){send(src,false,detail,referrer)})},true)})();`;
}
