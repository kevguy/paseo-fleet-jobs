# Screenshot provenance

The listing and README images show the actual `FleetScreen` and `HostHealth` components rendered through React Native Web. A separate capture harness supplies fictional RPC responses and host connections; it never reads a job store, contacts an SSH source or connects to a real Paseo daemon.

- `fleet-desktop.png`: fictional job overview, resource readings and recent changes.
- `evidence-mobile.png`: fictional backup result, report, checksum and log at a narrow browser viewport.

All names, paths, jobs, resource values and report contents are invented. The checksum in the detail fixture is calculated from its fictional report. These images illustrate the interface; they are not evidence of real jobs or native phone testing.

To refresh them, render the current components with synthetic `useRpc` and `useHosts` providers and a fresh React Query client. Use an isolated browser profile with a fixed clock and locale, capture only the preview page at its layout viewport size, and inspect every image for clipping and accidental private data before replacing these files. Keep the image paths aligned with `paseo-plugin.json` and the README. Do not capture an installed plugin connected to personal or production data for public images.
