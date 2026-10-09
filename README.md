# k8sview

A small desktop Kubernetes viewer built with Tauri v2, Next.js (static export), and Mantine.

- Switch kubeconfig contexts and namespaces
- Command palette (**⌘K** / **Ctrl+K**, or the search box in the header): jump to any view, open logs / a shell / attach / port forward for any running pod in any namespace, switch namespace or context, manage port forwards and terminals, toggle the theme, check for updates
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

## Install

Download the latest build for your platform from the
**[Releases page](https://github.com/michaelrosstarr/k8sview/releases/latest)**.

| Platform | File | Requirements |
|---|---|---|
| macOS (Apple Silicon) | `k8sview_<version>_aarch64.dmg` | M1 or later, macOS 11+. Intel Macs aren't supported. |
| Windows | `k8sview_<version>_x64-setup.exe` | Windows 10 or 11, 64-bit |
| Linux | `k8sview_<version>_amd64.AppImage` (or `.deb`) | x86_64 |

You also need a kubeconfig (`~/.kube/config`, or set `KUBECONFIG`) and, if your clusters use them,
the auth plugins it calls (`gcloud`, `aws`, `kubelogin`, ...) installed as they would be for `kubectl`.

The builds aren't signed by Apple or Microsoft, so each platform asks you to confirm the first
launch. You only do this once: updates the app installs afterwards open without asking.

### macOS

1. Open the `.dmg` and drag **k8sview** into **Applications**.
2. Open k8sview. macOS says *Apple could not verify "k8sview" is free of malware*. Click **Done**
   (not *Move to Trash*).
3. Open **System Settings → Privacy & Security**, scroll to **Security**, and next to
   *"k8sview" was blocked to protect your Mac* click **Open Anyway**. Confirm with your password or
   Touch ID, then click **Open Anyway** once more.

On macOS 14 (Sonoma) and earlier you can instead right-click k8sview in Applications and choose
**Open**.

Or do it from Terminal, which removes the "downloaded from the internet" flag from k8sview only:

```sh
xattr -dr com.apple.quarantine /Applications/k8sview.app
```

If macOS says k8sview *"is damaged and can't be opened"*, you have the first release
(`2026.10.9.1887`), whose bundle signature was incomplete. Install a newer release, or run the
`xattr` command above.

### Windows

1. Run `k8sview_<version>_x64-setup.exe`.
2. If SmartScreen shows *Windows protected your PC*, click **More info → Run anyway**.
3. The installer adds k8sview to the Start menu. It installs for your user only, so it doesn't
   need administrator rights.

### Linux

**AppImage** (recommended; it updates itself):

```sh
chmod +x k8sview_*_amd64.AppImage
./k8sview_*_amd64.AppImage
```

**Debian / Ubuntu package** (doesn't update itself; install each new `.deb` the same way):

```sh
sudo apt install ./k8sview_*_amd64.deb
```

### Updates

k8sview checks for a new release 15 seconds after it starts and every 6 hours after that. You can
also click **Updates** at the bottom of the sidebar. When there's a new version, **Update available**
appears: click it to see what's new, then **Install & restart**. The download is checked against
the app's signing key before it's installed. Open port forwards and terminals close when the app
restarts.

### Uninstall

- **macOS:** drag `/Applications/k8sview.app` to the Trash.
- **Windows:** Settings → Apps → k8sview → Uninstall.
- **Linux:** delete the AppImage, or `sudo apt remove k8sview`.

## Development

### Prerequisites

- Node 24+ and pnpm
- Rust (stable) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
- A working kubeconfig

### Run

```sh
pnpm install
pnpm tauri dev      # dev window with hot reload
pnpm tauri build    # release bundle in src-tauri/target/release/bundle
```

`pnpm dev` / `pnpm build` alone only serve or export the frontend; it needs the Tauri backend to reach a cluster.
Both copy Monaco's assets into `public/monaco` first (`scripts/copy-monaco.mjs`) so the editor works offline.

Local builds are named **k8sview - dev** (with their own app ID, `dev.k8sview.app.dev`) and show
a **dev** badge, so they never get mixed up with an installed release. Only the release workflow
builds plain **k8sview**.

### Layout

| Path | Purpose |
|---|---|
| `src/app/(main)/page.tsx` | App shell: context/namespace pickers, navigation, log dock |
| `src/app/logs/page.tsx`, `src/app/shell/page.tsx` | Popped-out log / shell windows |
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

The builds aren't code-signed by Apple or Microsoft, so the first launch asks people to confirm
(see [Install](#install)). macOS bundles are ad-hoc signed (`bundle.macOS.signingIdentity: "-"`),
which is what turns macOS's unfixable *"is damaged"* error into the normal *"could not verify"*
prompt. Updates installed by the app afterwards don't ask again. Signing and notarizing with an
Apple Developer account removes the macOS prompt entirely; see the commented variables in
`.github/workflows/release.yml`.
