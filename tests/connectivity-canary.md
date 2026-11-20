# Connectivity canary — 2026-11-20

Implementation tested: `2fb55a4e069576e41dc745fa46b95de75bcbb156`.
Package SHA-256: `93e7f1b31f301d07b64c4d3179f54d67d47a7eae2629812021149d5b815d35e1`.
Runtime: installed Paseo 0.15.0 on macOS, real daemon/plugin RPC, ephemeral Chromium browser context serving the installed Paseo client. No mocked RPC responses. This is browser verification, not physical iOS/Android or laptop-sleep verification.

## Reproduce

Use a trusted local receipt with failed status and a readable text evidence file. Keep the receipt and evidence outside the package. Open Fleet Jobs in a fresh paired browser context.

1. Load the job list and open its detail while connected; return to the list so both queries have cached data.
2. Set only the test browser context offline (`context.setOffline(true)`). Do not disable the computer network or stop the daemon.
3. Assert the unavailable banner appears, the cached card says `Unknown · cached`, and no card still confidently presents the old Failed status.
4. Open the preloaded detail. Assert its status is Unknown, its checksum is labeled unverified, the warning appears, and the evidence section remains readable.
5. Restore the context network. Wait for a fresh successful read. Assert the banner disappears, Last checked is visible, and the reported Failed status returns.
6. Close the ephemeral browser and its owned local server in a finally block.

## Observed result

All five connectivity assertions passed: connection, fleet screen, cached-card demotion, cached-detail demotion, and fresh-data recovery. Offline there was one Unknown cached card and zero confidently Failed cards. The cached detail showed Unknown, an unverified checksum, the unavailable warning, and retained evidence. Reconnect cleared the banner and restored the reported Failed status.

The same test failed before the correction: after 70 seconds offline, the old Failed card remained and there was no unavailable banner. The before/after observations are retained in the private deployment archive; no receipt contents or host credentials are included here.

A separate actual-client rehearsal passed eight checks on this package: connection, Fleet Jobs screen, search filtering, status filtering, job title, exact failed evidence, desktop 1280×900 capture, and 390×844 browser layout capture. Typecheck and all 19 receipt/CLI/fleet tests also passed.

## Limits and review corrections

Review also identified a pre-disconnect request completing later and cache reuse after remount. The implementation records the request start and whether it began connected, compares it with the disconnect boundary, and uses a new query key per screen instance. These race branches were code-reviewed; this browser canary did not deliberately delay a pre-disconnect response.

Paseo host status supplements browser reachability for native clients. A native client without the host observation API fails closed to Unknown. Native phone connectivity, actual laptop sleep, and rapid disconnect/reconnect races still require a device canary before a public release. No claim of native-device testing is made.
