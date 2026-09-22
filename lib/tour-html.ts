// Tour text is authored HTML, and hosted spaces can be built from customer uploads.
// Only simple formatting and web links survive; scripts, handlers and embeds are removed.
const keep = new Set(["P", "BR", "EM", "STRONG", "B", "I", "U", "SMALL", "SPAN", "UL", "OL", "LI", "A", "H3", "H4", "BLOCKQUOTE"]);
const drop = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "FRAME", "OBJECT", "EMBED", "SVG", "MATH", "NOSCRIPT", "TEXTAREA",
  "SELECT", "BUTTON", "INPUT", "FORM", "LINK", "META", "BASE", "IMG", "PICTURE", "VIDEO", "AUDIO", "SOURCE", "TITLE", "HEAD"]);

export function sanitizeTourHtml(html: string | null | undefined) {
  if (!html) return "";
  // Tour text is only rendered in the browser, after the scene configuration loads.
  if (typeof DOMParser === "undefined") return "";
  const source = new DOMParser().parseFromString(html, "text/html").body;
  const output = document.implementation.createHTMLDocument("").createElement("div");
  const target = output.ownerDocument;
  const copy = (from: Node, to: Node) => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) { to.appendChild(target.createTextNode(child.textContent ?? "")); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      // SVG and MathML content has lowercase names and its own parsing rules; none of it is kept.
      if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || drop.has(element.tagName)) continue;
      // Unknown containers such as DIV keep their text and allowed children.
      if (!keep.has(element.tagName)) { copy(element, to); continue; }
      const clean = target.createElement(element.tagName.toLowerCase());
      const className = element.getAttribute("class");
      if (className && /^[\w -]{1,100}$/.test(className)) clean.setAttribute("class", className);
      if (element.tagName === "A") {
        const href = element.getAttribute("href")?.trim() ?? "";
        if (/^(?:https?:|mailto:)/i.test(href) || /^\/(?!\/)/.test(href)) clean.setAttribute("href", href);
        clean.setAttribute("target", "_blank");
        clean.setAttribute("rel", "noopener noreferrer");
      }
      copy(element, clean);
      to.appendChild(clean);
    }
  };
  copy(source, output);
  return output.innerHTML;
}
