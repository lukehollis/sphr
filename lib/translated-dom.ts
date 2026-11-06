/**
 * A page a browser translates (Chrome's Google Translate, Safari's Translate) has its text nodes swapped for the
 * translator's own. When React later removes or inserts next to one of the originals, the browser throws
 * NotFoundError ("Failed to execute 'removeChild' on 'Node'" in Chrome, "The object can not be found here." in
 * Safari), the error page replaces the whole page and uploads carry on unseen. Two visitors moving off Matterport hit
 * it on the account page (2026-10-28 Safari in Portuguese, 2026-11-06 Chrome in Spanish), right as their uploads
 * changed state: one never saw the upload stop, the other never saw processing start.
 *
 * So removing a node that is no longer there is skipped, and inserting before one appends instead, which is what
 * React's own maintainers suggest (facebook/react#11538). Translated text may then stay as it was, but the page
 * keeps working. The first repair on a page is reported once, so how often it happens shows up in analytics.
 * Plain ES5: it runs in <head> before anything else.
 */
export function translatedDomScript(report: boolean) {
  return `(function(){if(typeof Node!=="function"||!Node.prototype||Node.prototype.__sphrTranslated)return;`
    + `var proto=Node.prototype,remove=proto.removeChild,insert=proto.insertBefore,told=false;proto.__sphrTranslated=true;`
    + `function tell(op){if(told||!${report}||/^\\/admin(\\/|$)/.test(location.pathname))return;told=true;try{`
    + `var html=document.documentElement,lang=(html.getAttribute("lang")||"")+(/translated/.test(html.className)?" translated":"");`
    + `navigator.sendBeacon("/api/steps",JSON.stringify({events:[{name:"client_error",path:location.host+location.pathname,`
    + `props:{kind:"translated",message:"Repaired "+op+" on a node the page no longer holds",source:lang}}],referrer:document.referrer||null,url:location.origin+location.pathname}))}catch(x){}}`
    + `proto.removeChild=function(child){if(child&&child.parentNode!==this){tell("removeChild");return child}return remove.apply(this,arguments)};`
    + `proto.insertBefore=function(node,before){if(before&&before.parentNode!==this){tell("insertBefore");return insert.call(this,node,null)}return insert.apply(this,arguments)}})();`;
}
