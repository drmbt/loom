/**
 * VN102 — THE SMALLEST XML READER A RESOLUME COMPOSITION NEEDS. No dependency (the brief:
 * none without asking), no DOM (this runs headless and in a worker).
 *
 * A `.avc` is machine-written XML: elements and attributes, no mixed text that matters, no
 * DTD, no namespaces in use. So this reads exactly that: a single pass over the text with one
 * sticky regular expression per tag, building elements with their attributes and children.
 * Text content, comments, processing instructions, CDATA and doctypes are skipped. Attribute
 * values are entity-decoded (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&#…;`), because a
 * media path can carry an ampersand. A malformed document (an unclosed or mismatched tag)
 * throws, naming the line.
 *
 * Measured on the 15 MB Tinashe composition (10 479 clips): well under a second in Node.
 */

export interface XmlElement {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
}

interface Building {
  tag: string;
  attributes: Record<string, string>;
  children: XmlElement[];
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decode(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

/** `/`, as a char code: a closing tag starts with it and an empty element ends with it. */
const SOLIDUS = 0x2f;

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

/** Parse a whole document; returns its root element. */
export function parseXml(text: string): XmlElement {
  const stack: Building[] = [];
  let root: XmlElement | null = null;
  let index = 0;
  const length = text.length;
  while (index < length) {
    const open = text.indexOf("<", index);
    if (open < 0) break;
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end < 0) throw new Error(`Unclosed comment at line ${lineOf(text, open)}.`);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      if (end < 0) throw new Error(`Unclosed CDATA at line ${lineOf(text, open)}.`);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<?", open) || text.startsWith("<!", open)) {
      const end = text.indexOf(">", open + 2);
      if (end < 0) throw new Error(`Unclosed declaration at line ${lineOf(text, open)}.`);
      index = end + 1;
      continue;
    }
    // Find the tag's end, skipping `>` inside quoted attribute values.
    let close = open + 1;
    let quote = "";
    for (; close < length; close++) {
      const char = text[close];
      if (quote !== "") {
        if (char === quote) quote = "";
      } else if (char === "\"" || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (close >= length) throw new Error(`Unclosed tag at line ${lineOf(text, open)}.`);
    const body = text.slice(open + 1, close);
    index = close + 1;
    if (body.charCodeAt(0) === SOLIDUS) {
      const tag = body.slice(1).trim();
      const top = stack.pop();
      if (top === undefined || top.tag !== tag) {
        throw new Error(`Mismatched </${tag}> at line ${lineOf(text, open)}${top === undefined ? "" : `; <${top.tag}> is open`}.`);
      }
      const element: XmlElement = top;
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
      continue;
    }
    const selfClosing = body.charCodeAt(body.length - 1) === SOLIDUS;
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s]/);
    const tag = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
    if (tag === "") throw new Error(`Empty tag at line ${lineOf(text, open)}.`);
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    if (nameEnd >= 0) {
      ATTRIBUTE.lastIndex = nameEnd;
      for (let match = ATTRIBUTE.exec(inner); match !== null; match = ATTRIBUTE.exec(inner)) {
        attributes[match[1] as string] = decode(match[2] ?? match[3] ?? "");
      }
    }
    const element: Building = { tag, attributes, children: [] };
    if (selfClosing) {
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
    } else {
      stack.push(element);
    }
  }
  if (stack.length > 0) throw new Error(`<${(stack[stack.length - 1] as Building).tag}> is never closed.`);
  if (root === null) throw new Error("No root element.");
  return root;
}

/** The first child with this tag, or undefined. */
export function child(element: XmlElement | undefined, tag: string): XmlElement | undefined {
  return element?.children.find((entry) => entry.tag === tag);
}

/** Every child with this tag. */
export function childrenOf(element: XmlElement | undefined, tag: string): XmlElement[] {
  return element === undefined ? [] : element.children.filter((entry) => entry.tag === tag);
}

/** The first child with this tag whose `name` attribute is `name`. */
export function named(element: XmlElement | undefined, tag: string | null, name: string): XmlElement | undefined {
  return element?.children.find((entry) => (tag === null || entry.tag === tag) && entry.attributes["name"] === name);
}

/** Walk a path of `tag` or `tag[name]` steps: `path(clip, "Transport", "Params", "ParamRange[Position]")`. */
export function path(element: XmlElement | undefined, ...steps: string[]): XmlElement | undefined {
  let at = element;
  for (const step of steps) {
    if (at === undefined) return undefined;
    const match = /^([^[]*)\[(.*)\]$/.exec(step);
    at = match === null ? child(at, step) : named(at, match[1] === "" || match[1] === "*" ? null : (match[1] as string), match[2] as string);
  }
  return at;
}

/** Depth-first: the first descendant (not the element itself) matching. */
export function find(element: XmlElement | undefined, test: (entry: XmlElement) => boolean): XmlElement | undefined {
  if (element === undefined) return undefined;
  const stack = [...element.children].reverse();
  while (stack.length > 0) {
    const next = stack.pop() as XmlElement;
    if (test(next)) return next;
    for (let i = next.children.length - 1; i >= 0; i--) stack.push(next.children[i] as XmlElement);
  }
  return undefined;
}
