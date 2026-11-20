# Observation and resource canary — 2026-11-20

Release candidate: Fleet Jobs 0.2.0. Final package SHA-256:
`82379607a75f52c1c8ae2c6ceeec32c9b4fb8948744486d08261a9cd0745efc6`.

Typecheck and all 40 tests passed on macOS. A later UI-only low-space label change passed typecheck/package build and the real-client checks below. Packaged runtime source matches the working source byte for byte; private host/path string scans returned no matches.

The observer/inbox implementation passed eight CLI runtime assertions on each of three worker installations (macOS and two Linux hosts): quiet baseline, two explicit terminal outcomes, verified pass, verified fail, deduplication across new CLI processes, changed-evidence transition, changed success becoming unknown, and deduplication of that unknown state. Each canary used an isolated data home and synthetic artifacts; production job runners and evidence were untouched. That package differed from the final candidate only in the later low-space UI label.

Reproduction: configure two explicit text observers and a real heartbeat in an isolated home, collect a baseline, write PASS and FAIL artifacts, and collect again. Expect two new alerts and verified corresponding states. Run another CLI process and collect: expect zero new alerts. Change the accepted PASS artifact and collect: expect one unknown-state alert, unverified evidence and no successful state. Collect again: expect no repeated alert. Retain the canary home for inspection.

The final installed package passed 13 real Paseo browser assertions against a macOS worker daemon: connection, fleet list, search filter, state filter, selected title, exact failed evidence, desktop capture, 390×844 capture, resource panel, background collector freshness, offline fleet/resource demotion, offline detail demotion and reconnect recovery. No RPC responses were mocked. Browser and server were closed in a finally block. Inspection confirmed readable resource cards and evidence at both widths.

Actual configured worker snapshots contain an explicit historical failed gate and two unassessed metric outputs. GPUs expose telemetry while reservation availability remains unknown. No active run is inferred from old PIDs or a diagnostic log. Monitor timestamps advanced in the daemon without an open Fleet Jobs client. The first baseline produced no historical alert flood.

Native iOS/Android behavior and physical coordinator sleep are not proven by these browser/CLI tests. They require a device check. No OS push service, public package publication or measured productivity savings is claimed.
