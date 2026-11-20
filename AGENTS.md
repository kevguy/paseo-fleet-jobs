# Fleet Jobs

Portable Paseo plug-in. No private host names, addresses, paths, credentials or company data in source, examples or package. Runtime data stays outside this repository. Use React Native primitives and theme tokens; no DOM outside client/web.ts. Client/server/shared boundaries follow the Paseo scaffold.

Read-only job viewer: never launch/stop jobs, execute receipt strings, scan arbitrary directories, or infer successful evaluation from process exit. Validate all receipts and RPC output. Missing/unreadable/changed evidence must not be green. Keep reads bounded. External jobs/CLI own manual receipts; explicitly configured file observers may update only their own receipts and local monitor state.

No commits or pushes by subagents. Preserve others' work. No OS screenshots/input. No broad process kills. Tests use isolated directories under .validation/ or FLEET_JOBS_TEST_ROOT. On managed hosts, respect the local heavy-work scheduler. No Drive uploads needed; never upload company source or print credentials.
