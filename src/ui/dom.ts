// Tiny DOM helpers. Everything user-visible goes through textContent, never innerHTML:
// the data comes from files and must not be interpreted as markup.

export type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

function applyProps(el: Element, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.setAttribute("class", String(value));
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "value" && "value" in el) (el as HTMLInputElement).value = String(value);
    else if (key === "checked" && "checked" in el) (el as HTMLInputElement).checked = Boolean(value);
    else if (key === "disabled" && "disabled" in el) (el as HTMLButtonElement).disabled = Boolean(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "number" ? String(child) : child);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}
