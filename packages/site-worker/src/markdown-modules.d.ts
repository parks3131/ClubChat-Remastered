/**
 * What a `.md` import is, to TypeScript.
 *
 * `wrangler.jsonc` carries `{ "type": "Text", "globs": ["**\/*.md"] }`, so the bundler turns a
 * markdown import into a string module at build time. TypeScript knows nothing about that rule -
 * it would report `Cannot find module './x.md'` - and this declaration is what closes the gap.
 *
 * **It deliberately does not add the markdown files to the TypeScript program.** An ambient wildcard
 * module declaration matches by specifier rather than by resolving a file, so `docs/legal/*.md`
 * being outside this package's `rootDir` is a non-question. Pointing `include` at them instead, or
 * relaxing `rootDir`, would be the version of this that breaks the day somebody adds a `.md` file
 * with a code fence in it.
 *
 * The cost, stated rather than hidden: this declaration is a promise, not a check. A typo in an
 * import path is a bundler error at `wrangler deploy` and at `vitest run`, not a type error here.
 * Both of those run before anything ships, which is why the promise is acceptable.
 */
declare module '*.md' {
  const content: string;
  export default content;
}
