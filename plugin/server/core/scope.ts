export const SERIAL_ONLY = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "go.sum",
  "**/migrations/**",
  "**/db/migrate/**",
  "ProjectSettings/**",
  "Packages/manifest.json",
  "**/*.unity",
  "**/*.prefab",
  "**/*.asset",
  "**/*.uasset",
  "**/*.umap",
  "**/*.pbxproj",
  "**/*.csproj",
  "**/*.sln",
];

export function normalize(pattern: string): string {
  return pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "/");
}

/** `{js,ts}` is either one, as a seat writes a choice of extensions: spelled out before anything reads the glob. */
function alternatives(pattern: string): string[] {
  const brace = /\{([^{}]*)\}/.exec(pattern);
  if (!brace) return [pattern];
  const before = pattern.slice(0, brace.index);
  const after = pattern.slice(brace.index + brace[0].length);
  return brace[1]!.split(",").flatMap((choice) => alternatives(`${before}${choice}${after}`));
}

export function globToRegex(pattern: string): RegExp {
  return new RegExp(`^(?:${alternatives(normalize(pattern)).map(regexBody).join("|")})$`);
}

function regexBody(clean: string): string {
  let out = "";
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index]!;
    if (char === "*") {
      if (clean[index + 1] === "*") {
        index++;
        // `**/` means whole segments or none; as `.*` it let `**/migrations/**` match `server/db_migrations/`.
        if (clean[index + 1] === "/") {
          out += "(?:.*/)?";
          index++;
        } else out += ".*";
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  if (clean.endsWith("/")) out += ".*";
  return out;
}

/** Walks both segment globs together: sampling one against the other misses `*.ts` vs `app.*`. */
function segmentsMeet(a: string, b: string): boolean {
  if (a === b || a === "*" || b === "*") return true;
  const seen = new Set<number>();
  const stars = (rest: string) => [...rest].every((char) => char === "*");
  const walk = (i: number, j: number): boolean => {
    const state = i * (b.length + 1) + j;
    if (seen.has(state)) return false;
    seen.add(state);
    if (i === a.length) return stars(b.slice(j));
    if (j === b.length) return stars(a.slice(i));
    const left = a[i]!;
    const right = b[j]!;
    if (left === "*") return walk(i + 1, j) || walk(i, j + 1);
    if (right === "*") return walk(i, j + 1) || walk(i + 1, j);
    if (left === "?" || right === "?") return walk(i + 1, j + 1);
    return left === right && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/** Walked by segment, since sampling misses overlaps where both sides hold wildcards; lanes share a copy on this answer. */
function meet(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    // Leftovers match nothing only if each is "**" or a trailing "" (a directory pattern: everything under it).
    const rest = a.length === 0 ? b : a;
    return rest.every((segment) => segment === "**" || segment === "");
  }
  const [ax, ...at] = a;
  const [bx, ...bt] = b;
  if (ax === "" || bx === "") return true;
  // "**" spans any number of segments, including none, on either side.
  if (ax === "**") return meet(at, b) || meet(a, bt) || meet(at, bt);
  if (bx === "**") return meet(a, bt) || meet(at, b) || meet(at, bt);
  return segmentsMeet(ax!, bx!) && meet(at, bt);
}

export function patternsOverlap(a: string, b: string): boolean {
  return alternatives(normalize(a)).some((left) => alternatives(normalize(b)).some((right) => meet(left.split("/"), right.split("/"))));
}

export function firstOverlap(left: string[], right: string[]): string | undefined {
  for (const a of left) for (const b of right) if (patternsOverlap(a, b)) return a === b ? a : `${a} and ${b}`;
  return undefined;
}

/** Resolves serial-only globs against real files, since glob-vs-glob can only say "might"; a reserved directory yields itself. */
export function serialPaths(tracked: string[], serialOnly: string[]): string[] {
  const found = new Set<string>();
  for (const rule of serialOnly) {
    const matches = globToRegex(rule);
    const reservesDir = normalize(rule).endsWith("**");
    for (const file of tracked) {
      if (!matches.test(file)) continue;
      const cut = file.lastIndexOf("/");
      found.add(reservesDir && cut > 0 ? file.slice(0, cut + 1) : file);
    }
  }
  return [...found].sort();
}

/** Which of those paths a write set could reach, to compare one lane's reach against another's. */
export function serialReach(writeSet: string[], serial: string[]): string[] {
  return serial.filter((path) => writeSet.some((pattern) => patternsOverlap(pattern, path)));
}

/** Which of the write set's own patterns land on one, so a refusal can quote the seat's own words. */
export function serialHits(writeSet: string[], serial: string[]): string[] {
  return writeSet.filter((pattern) => serial.some((path) => patternsOverlap(pattern, path)));
}
