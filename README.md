# k8sview

A small desktop Kubernetes viewer built with Tauri v2, Next.js (static export), and Mantine.

- Switch kubeconfig contexts and namespaces
- List pods with kubectl-style status, readiness, restarts, and age (auto-refreshes every 5s)
- Restart a pod (delete it so its controller recreates it; warns when the pod has no owner) or delete it
- Inspect a pod: container images and versions, the effective environment, and every ConfigMap it references
- Browse ConfigMaps, with values shown in a read-only Monaco editor
- Pod logs in terminal-style viewers (xterm.js): live follow, search with highlighting, regex / case / filter-to-matches, timestamps, previous container; several at once in a bottom dock (tabs or split view) or popped out into their own windows
- Usage: cluster CPU and memory over time, node capacity (including pod slots), usage by namespace, and per-pod usage vs requests and limits with sparklines and near-limit warnings (needs metrics-server)
- Versions: a namespace × app matrix of image tags (with the digests actually running, so `latest` resolves to a real build), app versions and chart versions; highlights differences, filters by namespace, exports CSV
- Flux dashboard: health of every Flux object, failing releases, release health by namespace, Helm deploy activity, slowest Helm actions, and per-object detail (conditions, Helm history, inventory, events, manifest) with reconcile / suspend / resume
- Shells into containers (`exec -it`, bash or sh by default, or any command) and attaching to a container's main process (`attach -it`), in the same dock or their own windows
- Port-forward to pods (from a pod's menu or its declared container ports); manage active forwards in the Port Forwards view

The app reads `~/.kube/config` (or `$KUBECONFIG`) and talks to the cluster from Rust via the `kube` crate.
Secret values are never fetched.

## Prerequisites

- Node 24+ and pnpm
- Rust (stable) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
- A working kubeconfig

## Run

```sh
pnpm install
pnpm tauri dev      # dev window with hot reload
pnpm tauri build    # release bundle in src-tauri/target/release/bundle
```

`pnpm dev` / `pnpm build` alone only serve or export the frontend; it needs the Tauri backend to reach a cluster.
Both copy Monaco's assets into `public/monaco` first (`scripts/copy-monaco.mjs`) so the editor works offline.

## Layout

| Path | Purpose |
|---|---|
| `src/app/(main)/page.tsx` | App shell: context/namespace pickers, navigation, log dock |
| `src/app/logs/page.tsx` | Popped-out log window |
| `src/components/` | Pods table, pod detail drawer, ConfigMaps view, Monaco viewer |
| `src/lib/k8s.ts` | Typed `invoke()` wrappers for the Rust commands |
| `src-tauri/src/lib.rs` | Tauri commands and client state |
| `src-tauri/src/k8s.rs` | Kubernetes calls and the DTOs sent to the UI |
| `src-tauri/src/exec.rs` | Interactive exec / attach sessions over raw byte channels |
| `src-tauri/src/updates.rs` | Update check, version comparison, download and install |
| `src-tauri/src/logs.rs` | Log streaming over Tauri channels, batched |
| `src-tauri/src/metrics.rs` | metrics-server usage joined with requests, limits and node capacity |
| `src-tauri/src/versions.rs` | Workload image / chart / app versions and the digests pods are running |
| `src-tauri/src/flux.rs` | Flux objects via discovery, plus `flux reconcile` / `suspend` / `resume` equivalents |
| `src-tauri/src/portforward.rs` | Local TCP listeners that tunnel to pods over the port-forward API |

On macOS the app recovers your login shell's `PATH` at startup so kubeconfig `exec` auth plugins
(gcloud, aws, kubelogin) work when launched from Finder.

## Versions

Versions are `<year>.<month>.<day>.<random>`, e.g. `2026.10.9.5248`. Cargo, Tauri and the
updater need semver, so the files store it as `2026.10.9+5248` (build metadata); the app,
the Windows installer and macOS's `CFBundleVersion` show it as `2026.10.9.5248`.

```sh
pnpm version:new        # stamp a new version (today in UTC + a random 4-digit number)
```

The random part isn't ordered, so the updater doesn't use plain semver comparison: a release
from a later date is newer, and on the same date a *different* number counts as newer too
(`latest.json` always describes the newest published release). An older date is never offered.
Windows builds use the NSIS installer only: MSI caps the first version field at 255.

## Releases and updates

The app checks `https://github.com/<owner>/<repo>/releases/latest/download/latest.json` 15 seconds
after start and every 6 hours (or via **Updates** at the bottom of the sidebar). When a newer
release exists it offers to download it, verifies its signature against the public key built
into the app, installs it, and restarts.

To publish a release, run the **Release** workflow from the GitHub Actions tab. It stamps one
version, builds macOS (Apple Silicon), Windows and Linux in parallel, signs the update bundles,
uploads them with `latest.json` to a GitHub Release, and publishes it.

One-time setup:

1. Push this repo to GitHub. It must be public for the app to download updates without a token.
2. Add repository secrets (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/k8sview.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: only if the key has a password. The generated key
     doesn't, so skip it (GitHub won't store an empty secret; a missing one reads as empty).
3. Back up `~/.tauri/k8sview.key` somewhere safe. Installed apps only accept updates signed with
   it; if it's lost, people must reinstall manually after a new key is generated.

Local builds (`pnpm tauri dev`, or `pnpm tauri build` without `--endpoint` stamped in) have no
update URL, so **Updates** reports that updates aren't configured. Installing is disabled in dev.

The builds aren't code-signed by Apple or Microsoft, so the first install shows a Gatekeeper
("unidentified developer": right-click → Open) or SmartScreen warning. Updates installed by the
app afterwards don't. Apple signing/notarization can be added to the workflow with an Apple
Developer account (see the commented variables in `.github/workflows/release.yml`).
