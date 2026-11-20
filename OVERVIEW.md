# Fleet Jobs

Fleet Jobs gives Paseo a read-only view of work reported by job scripts across the current host and explicitly configured SSH hosts. It brings progress, waiting states, failures, heartbeat age, and saved result evidence into one place.

The viewer reads strict, bounded receipt files from its data directory. Job publishers create and update those files; Fleet Jobs does not launch, stop, or discover jobs, and it does not replace a task database. An active receipt becomes stale when its heartbeat is older than its configured threshold. A stale state is a signal to inspect the publisher or host, not a claim that a job stopped.

For a reported success, Fleet Jobs checks that the referenced evidence is a readable regular file and that its SHA-256 matches the receipt. Missing, unreadable, or changed evidence makes the effective result unknown. A matching checksum shows that the saved bytes have not changed since publication; it does not prove that the result is correct or that the publisher's claim is truthful.

Remote hosts are opt-in and use only fixed read-only snapshot and detail requests over SSH. Receipt metadata and selected evidence and log text are shared with Paseo clients paired to the host. Trust the configured hosts, publishers, and their artifacts accordingly.

Optional explicit file observers keep receipts current without editing runners. Disk, NVIDIA and work-claim readings add resource context while preserving uncertainty about reservations. Each host collects independently every minute and retains a deduplicated local change inbox across reloads; no external notification service is used.
