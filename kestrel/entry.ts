/**
 * The one module through which this repo reaches Kestrel's code: the pinned, patched tree in
 * vendor/kestrel, plus the demo-image index the build writes beside it. Bundling resolves
 * the `kestrel` specifier here (wrangler.jsonc `alias`, vitest.config.ts `resolve.alias`);
 * type-checking resolves it to src/types/kestrel.d.ts instead (tsconfig `paths`), so this
 * repo's tsc never type-checks Kestrel's source, which Kestrel's own typecheck covers.
 * Keep the two in step: an export added here is declared there.
 */

export { demoImages, demoLogo, migrations } from "../vendor/demo-assets";
export { seedDatabase } from "../vendor/kestrel/src/dev/seed";
export { getConfig } from "../vendor/kestrel/src/env";
export { BUILD_INFO } from "../vendor/kestrel/src/generated/version";
export { default } from "../vendor/kestrel/src/index";
export { HttpError } from "../vendor/kestrel/src/lib/errors";
// For the tests of patches/0002-fake-outbox-bound.patch.
export { FakeNotifier, fakeNotifications } from "../vendor/kestrel/src/notify/fake";
export { deliverToOutbox, fakeOutbox } from "../vendor/kestrel/src/providers/fake";
