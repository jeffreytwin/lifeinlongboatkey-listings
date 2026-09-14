# Sync harness

Runs the `backend/sync` modules under Node against in-memory stand-ins for
`wix-data`, `wix-fetch`, `wix-secrets-backend`, `wix-media-backend` and
`image-data-uri`. No Wix runtime is involved; this is the fastest way to
exercise classification, diffing, event logging, retention, the health
report and the photo drain end to end.

```
test/harness/build.sh && node test/harness/test.mjs
```

Takes a few minutes (the drain tests wait out real backoff timers). Every
scenario prints `ok` or `FAIL`; the run ends with a count.

`build.sh` copies each module to `build/*.mjs`, rewrites the Wix imports to
the mocks, and routes cross-module imports of `.jsw` files through a
generated `*.proxy.mjs` whose functions always return a Promise. That
imitates Wix's cross-module web-method wrapper, which is what turned the
rate-limit cooldown into NaN in production; a sync helper called across a
`.jsw` boundary fails here the same way it fails on Wix.

The scenarios double as the acceptance tests for porting these modules to
the central listings engine.
