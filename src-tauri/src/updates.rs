//! In-app updates via the Tauri updater: GitHub Releases publish a signed
//! `latest.json`; the app checks it, downloads, verifies, installs and restarts.

use std::sync::Mutex;

use anyhow::{Result, anyhow};
use serde::Serialize;
use tauri::AppHandle;
use tauri::ipc::Channel;
use tauri_plugin_updater::{Update, UpdaterExt};

/// Versions are stored as semver `2026.10.9+4821` and shown as `2026.10.9.4821`.
pub fn display_version(semver: &str) -> String {
    semver.replacen('+', ".", 1)
}

/// Whether `release` should replace `current`. The random build number isn't
/// ordered, so semver's "greater than" can't decide. latest.json always describes
/// the newest release, so: a later date is newer, the same date with a different
/// build is too, and an older date never is.
fn is_newer(current: &semver::Version, release: &semver::Version) -> bool {
    let date = |v: &semver::Version| (v.major, v.minor, v.patch);
    date(release) > date(current)
        || (date(release) == date(current) && release.build != current.build)
}

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UpdateProgress {
    Progress { downloaded: u64, total: Option<u64> },
    Installing,
}

#[derive(Default)]
pub struct Updates {
    /// The update found by the last check, kept so install doesn't re-fetch it.
    pending: Mutex<Option<Update>>,
}

impl Updates {
    pub async fn check(&self, app: &AppHandle) -> Result<Option<UpdateInfo>> {
        let updater = app
            .updater_builder()
            .version_comparator(|current, release| is_newer(&current, &release.version))
            .build()
            .map_err(|e| match e {
                tauri_plugin_updater::Error::EmptyEndpoints => anyhow!(
                    "Updates aren't configured in this build. Builds from the GitHub release workflow include the update URL."
                ),
                e => anyhow!(e),
            })?;
        let update = updater.check().await?;
        let info = update.as_ref().map(|u| UpdateInfo {
            version: display_version(&u.version),
            current: display_version(&u.current_version),
            notes: u.body.clone().filter(|b| !b.trim().is_empty()),
            date: u.date.map(|d| d.to_string()),
        });
        *self.pending.lock().unwrap() = update;
        Ok(info)
    }

    /// Download, verify and install the pending update, then restart into it.
    pub async fn install(&self, app: &AppHandle, progress: Channel<UpdateProgress>) -> Result<()> {
        if cfg!(debug_assertions) {
            return Err(anyhow!(
                "Updates can only be installed from a release build, not `tauri dev`."
            ));
        }
        let update = self
            .pending
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| anyhow!("No update to install; check for updates first."))?;
        let mut downloaded = 0u64;
        update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = progress.send(UpdateProgress::Progress { downloaded, total });
                },
                || {
                    let _ = progress.send(UpdateProgress::Installing);
                },
            )
            .await?;
        app.restart();
    }
}

#[cfg(test)]
mod tests {
    use super::{display_version, is_newer};
    use semver::Version;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn newer() {
        assert!(is_newer(&v("2026.10.9+4821"), &v("2026.10.10+1000")));
        assert!(is_newer(&v("2026.10.9+4821"), &v("2026.11.1+1000")));
        // Same day, different build: the published one wins even if its number is lower.
        assert!(is_newer(&v("2026.10.9+4821"), &v("2026.10.9+1234")));
        assert!(!is_newer(&v("2026.10.9+4821"), &v("2026.10.9+4821")));
        assert!(!is_newer(&v("2026.10.9+4821"), &v("2026.10.8+9999")));
        assert!(!is_newer(&v("2026.10.9+4821"), &v("2025.12.31+9999")));
    }

    #[test]
    fn display() {
        assert_eq!(display_version("2026.10.9+4821"), "2026.10.9.4821");
    }
}
