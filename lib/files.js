// An agent is passed around as a file map: { "agent.md": contents, "tools/x.md": contents, … }.
// Paths are relative and use forward slashes. Contents are a string, or bytes (a Uint8Array) for
// files that may not be text. This is what a folder on disk, a browser editor and a database row
// all have in common, so nothing else in lib/ needs to know where the files came from.

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();

export const textOf = (contents) => (typeof contents === "string" ? contents : decoder.decode(contents));
export const bytesOf = (contents) => (typeof contents === "string" ? encoder.encode(contents) : contents);

// Hidden files and installed packages are never part of an agent.
export const isIgnoredPath = (path) => path.split("/").some((part) => part.startsWith(".") || part === "node_modules");

// The same order as walking a folder with each level sorted by name.
export function comparePaths(a, b) {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

// The paths under `folder`, sorted, leaving out ignored ones.
export function pathsUnder(files, folder) {
  return Object.keys(files)
    .filter((path) => path.startsWith(`${folder}/`) && !isIgnoredPath(path))
    .sort(comparePaths);
}
