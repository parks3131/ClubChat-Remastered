/**
 * What the edge is handed at runtime, and the only place a binding is named in TypeScript.
 *
 * Every name below has to match `wrangler.jsonc` character for character, because nothing checks
 * the two files against each other. A binding renamed here and not there typechecks cleanly, ships
 * cleanly, and is `undefined` at the edge - which for an R2 binding is a `TypeError` on the first
 * real photo and for a secret is a signature that can never match. The two files are commented as
 * a pair for that reason; change one and read the other.
 *
 * ## Why this is a declaration merge into `Cloudflare.Env` rather than a plain exported interface
 *
 * `@cloudflare/workers-types` declares `namespace Cloudflare { interface Env {} }` empty, and every
 * way of reaching the environment resolves to it: the `env` argument of the `fetch` handler through
 * `ExportedHandler<Env>`, `import { env } from 'cloudflare:workers'` in the Worker, and
 * `import { env } from 'cloudflare:test'` in a test. Declaring the bindings ONCE here, by merging,
 * makes all three the same type. A separate interface that the tests then cast to would be a second
 * copy of the binding list, which is failure mode 16 with a `Headers` instead of an API response.
 *
 * **Not `declare module 'cloudflare:test' { interface ProvidedEnv ... }`**, which is what a previous
 * major of `@cloudflare/vitest-pool-workers` needed and what most of the material about this
 * package still says. In 0.22 `cloudflare:test` types `env` as `Cloudflare.Env` and `ProvidedEnv`
 * does not exist at all, so that declaration compiles, merges into nothing, and leaves `env.CONTENT`
 * a type error whose only fix looks like a cast. It was written that way here first, and it took a
 * throwaway file that actually read `env.CONTENT` to notice - which is AGENTS.md failure mode 37:
 * a check whose expected outcome is also what happens when it does nothing.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      /**
       * `clubchat-identity`. Avatars, and nothing else.
       *
       * Separate from `CONTENT` because identity media is a different privacy class: see
       * `SPEC/TECH/07-media-pipeline.md`. The Worker does not care about the difference; it cares
       * that `bucketRoleForObjectKey` is the only thing that decides which of the two is read, so
       * an unrecognised key prefix can never fall through into the bucket holding private content.
       */
      IDENTITY: R2Bucket;

      /** `clubchat-content`. Chat photos, news photos and documents. */
      CONTENT: R2Bucket;

      /**
       * The key the api is signing with right now. A `wrangler secret`, never a `var`.
       *
       * Anyone holding this can mint a URL for any object key in either bucket, so it is the one
       * value in this project that must never appear in `wrangler.jsonc`, in a log line, or in a
       * commit. `README.md` has the `secret put` command and the reason `echo -n` is not optional.
       */
      MEDIA_SIGNING_SECRET: string;

      /**
       * The key the api WAS signing with, set only while a rotation is in flight.
       *
       * Typed `string | undefined` and not merely `?:` because `exactOptionalPropertyTypes` is on
       * repo-wide, and this really is a property that is absent from the runtime object most of the
       * time: the steady state is that no rotation is happening and the binding does not exist.
       * Read it through a helper that treats an empty string as absent too, because
       * `wrangler secret put` handed empty stdin stores one, and an empty string is a perfectly
       * valid HMAC key that nothing in the world signs with.
       *
       * It lives here and NOT in `packages/server/src/config.ts` on purpose. The api signs and
       * never verifies, so a previous key on a Fly app would be an environment variable nothing
       * reads, and an unread secret reads as drift the next time somebody runs `fly secrets list`.
       */
      MEDIA_SIGNING_SECRET_PREVIOUS?: string | undefined;

      /**
       * Which build is answering, for `GET /__parity`.
       *
       * Cloudflare fills this in; there is nothing to set beyond declaring the binding in
       * `wrangler.jsonc`. It is the Worker's counterpart to `SENTRY_RELEASE` on the api.
       */
      CF_VERSION_METADATA: WorkerVersionMetadata;
    }
  }
}

/** The bindings above, under the name the rest of this package refers to them by. */
export type Env = Cloudflare.Env;
