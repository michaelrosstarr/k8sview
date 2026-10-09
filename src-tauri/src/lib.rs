mod exec;
mod flux;
mod k8s;
mod logs;
mod metrics;
mod portforward;
mod updates;
mod versions;

use flux::{FluxDetail, FluxSnapshot, ObjectRef};
use k8s::{ConfigMapRow, ContextList, PodDetail, PodRow, RestartResult};
use kube::Client;
use logs::{ContainerInfo, LogEvent, LogOptions, LogStreams};
use metrics::MetricsSnapshot;
use portforward::{PortForwardInfo, PortForwards};
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex;
use versions::WorkloadVersion;

/// The active context and its client. Built lazily from `current-context`
/// on first use and rebuilt whenever the user switches context.
#[derive(Default)]
struct AppState {
    client: Mutex<Option<(String, Client)>>,
    /// Port forwards outlive context switches; each keeps the client it started with.
    forwards: PortForwards,
    logs: LogStreams,
    exec: exec::ExecSessions,
    updates: updates::Updates,
}

impl AppState {
    async fn client(&self) -> anyhow::Result<Client> {
        Ok(self.current().await?.1)
    }

    /// A client for `context`: the shared one when it's the active context
    /// (popped-out log windows can outlive a context switch in the main window).
    async fn client_for(&self, context: &str) -> anyhow::Result<Client> {
        let (current, client) = self.current().await?;
        if current == context {
            return Ok(client);
        }
        k8s::build_client(context).await
    }

    /// The active context name and its client.
    async fn current(&self) -> anyhow::Result<(String, Client)> {
        let mut guard = self.client.lock().await;
        if let Some(current) = guard.as_ref() {
            return Ok(current.clone());
        }
        let context = k8s::default_context()?;
        let client = k8s::build_client(&context).await?;
        *guard = Some((context.clone(), client.clone()));
        Ok((context, client))
    }
}

/// Render an error with its full cause chain for display in the UI.
/// API server rejections show just their message, not kube's debug dump.
pub(crate) fn err(e: anyhow::Error) -> String {
    let api_message = e
        .chain()
        .find_map(|cause| match cause.downcast_ref::<kube::Error>() {
            Some(kube::Error::Api(status)) if !status.message.is_empty() => {
                Some(status.message.clone())
            }
            _ => None,
        });
    match api_message {
        // Keep any context we added ("port-forward to x failed: ...") in front of it.
        Some(message) => {
            let context: Vec<String> = e
                .chain()
                .take_while(|c| c.downcast_ref::<kube::Error>().is_none())
                .map(|c| c.to_string())
                .collect();
            if context.is_empty() {
                message
            } else {
                format!("{}: {message}", context.join(": "))
            }
        }
        None => format!("{e:#}"),
    }
}

#[tauri::command]
async fn list_contexts(state: State<'_, AppState>) -> Result<ContextList, String> {
    let selected = state
        .client
        .lock()
        .await
        .as_ref()
        .map(|(ctx, _)| ctx.clone());
    k8s::list_contexts(selected.as_deref()).map_err(err)
}

#[tauri::command]
async fn set_context(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let client = k8s::build_client(&name).await.map_err(err)?;
    // Store the selection before verifying so a broken context still "sticks"
    // and the UI reports its errors instead of silently using the old one.
    *state.client.lock().await = Some((name, client.clone()));
    k8s::verify(&client).await.map_err(err)
}

#[tauri::command]
async fn list_namespaces(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let client = state.client().await.map_err(err)?;
    k8s::list_namespaces(client).await.map_err(err)
}

#[tauri::command]
async fn list_pods(state: State<'_, AppState>, ns: String) -> Result<Vec<PodRow>, String> {
    let client = state.client().await.map_err(err)?;
    k8s::list_pods(client, &ns).await.map_err(err)
}

#[tauri::command]
async fn get_pod_detail(
    state: State<'_, AppState>,
    ns: String,
    name: String,
) -> Result<PodDetail, String> {
    let client = state.client().await.map_err(err)?;
    k8s::pod_detail(client, &ns, &name).await.map_err(err)
}

#[tauri::command]
async fn delete_pod(state: State<'_, AppState>, ns: String, name: String) -> Result<(), String> {
    let client = state.client().await.map_err(err)?;
    k8s::delete_pod(client, &ns, &name).await.map_err(err)
}

#[tauri::command]
async fn restart_pod(
    state: State<'_, AppState>,
    ns: String,
    name: String,
) -> Result<RestartResult, String> {
    let client = state.client().await.map_err(err)?;
    k8s::restart_pod(client, &ns, &name).await.map_err(err)
}

#[tauri::command]
async fn list_configmaps(
    state: State<'_, AppState>,
    ns: String,
) -> Result<Vec<ConfigMapRow>, String> {
    let client = state.client().await.map_err(err)?;
    k8s::list_configmaps(client, &ns).await.map_err(err)
}

#[tauri::command]
async fn metrics_snapshot(state: State<'_, AppState>) -> Result<MetricsSnapshot, String> {
    let client = state.client().await.map_err(err)?;
    metrics::snapshot(client).await.map_err(err)
}

#[tauri::command]
async fn pod_containers(
    state: State<'_, AppState>,
    context: String,
    ns: String,
    pod: String,
) -> Result<Vec<ContainerInfo>, String> {
    let client = state.client_for(&context).await.map_err(err)?;
    logs::containers(client, &ns, &pod).await.map_err(err)
}

#[tauri::command]
async fn start_log_stream(
    state: State<'_, AppState>,
    context: String,
    ns: String,
    pod: String,
    options: LogOptions,
    on_event: Channel<LogEvent>,
) -> Result<u32, String> {
    let client = state.client_for(&context).await.map_err(err)?;
    Ok(state.logs.start(client, &ns, pod, options, on_event))
}

#[tauri::command]
fn stop_log_stream(state: State<'_, AppState>, id: u32) {
    state.logs.stop(id);
}

/// Open a log viewer or a shell in its own native window.
#[tauri::command]
async fn open_terminal_window(
    app: AppHandle,
    kind: String,
    context: String,
    ns: String,
    pod: String,
    container: Option<String>,
    mode: Option<String>,
) -> Result<(), String> {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let route = match kind.as_str() {
        "logs" => "logs",
        "shell" => "shell",
        other => return Err(format!("unknown terminal kind {other:?}")),
    };
    let mut url = Url::parse("http://localhost/").expect("static URL");
    url.query_pairs_mut()
        .append_pair("context", &context)
        .append_pair("ns", &ns)
        .append_pair("pod", &pod)
        .extend_pairs(container.iter().map(|c| ("container", c)))
        .extend_pairs(mode.iter().map(|m| ("mode", m)));
    let path = format!("{route}?{}", url.query().unwrap_or_default());
    // Labels must match the `term-*` pattern in capabilities/default.json.
    let label = format!("term-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let what = match (route, mode.as_deref()) {
        ("logs", _) => "logs",
        (_, Some("attach")) => "attach",
        _ => "shell",
    };
    let title = match &container {
        Some(c) => format!("{pod} / {c} · {what}"),
        None => format!("{pod} · {what}"),
    };
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(path.into()))
        .title(title)
        .inner_size(1100.0, 700.0)
        .min_inner_size(600.0, 300.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn exec_start(
    state: State<'_, AppState>,
    context: String,
    ns: String,
    pod: String,
    container: Option<String>,
    mode: exec::Mode,
    command: Option<Vec<String>>,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<exec::ExecEvent>,
) -> Result<u32, String> {
    let client = state.client_for(&context).await.map_err(err)?;
    state
        .exec
        .start(
            client, &ns, &pod, container, mode, command, on_output, on_event,
        )
        .await
        .map_err(err)
}

#[tauri::command]
fn exec_input(state: State<'_, AppState>, id: u32, data: String) -> Result<(), String> {
    state.exec.input(id, data.into_bytes()).map_err(err)
}

#[tauri::command]
async fn exec_resize(
    state: State<'_, AppState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.exec.resize(id, cols, rows).await.map_err(err)
}

#[tauri::command]
fn exec_stop(state: State<'_, AppState>, id: u32) {
    state.exec.stop(id);
}

#[derive(serde::Serialize)]
struct AppInfo {
    name: String,
    /// As shown to people: 2026.10.9.4821.
    version: String,
    /// Built locally ("k8sview - dev") rather than by the release workflow.
    dev: bool,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let info = app.package_info();
    AppInfo {
        dev: info.name != "k8sview",
        name: info.name.clone(),
        version: updates::display_version(&info.version.to_string()),
    }
}

#[tauri::command]
async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<updates::UpdateInfo>, String> {
    state.updates.check(&app).await.map_err(err)
}

#[tauri::command]
async fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    on_progress: Channel<updates::UpdateProgress>,
) -> Result<(), String> {
    state.updates.install(&app, on_progress).await.map_err(err)
}

#[tauri::command]
async fn list_workload_versions(
    state: State<'_, AppState>,
) -> Result<Vec<WorkloadVersion>, String> {
    let client = state.client().await.map_err(err)?;
    versions::list(client).await.map_err(err)
}

#[tauri::command]
async fn flux_snapshot(state: State<'_, AppState>) -> Result<FluxSnapshot, String> {
    let client = state.client().await.map_err(err)?;
    flux::snapshot(client).await.map_err(err)
}

#[tauri::command]
async fn flux_detail(
    state: State<'_, AppState>,
    kind: String,
    ns: String,
    name: String,
) -> Result<FluxDetail, String> {
    let client = state.client().await.map_err(err)?;
    flux::detail(client, &kind, &ns, &name).await.map_err(err)
}

#[tauri::command]
async fn flux_reconcile(
    state: State<'_, AppState>,
    kind: String,
    ns: String,
    name: String,
    with_source: bool,
) -> Result<Vec<ObjectRef>, String> {
    let client = state.client().await.map_err(err)?;
    flux::reconcile(client, &kind, &ns, &name, with_source)
        .await
        .map_err(err)
}

#[tauri::command]
async fn flux_set_suspended(
    state: State<'_, AppState>,
    kind: String,
    ns: String,
    name: String,
    suspend: bool,
) -> Result<(), String> {
    let client = state.client().await.map_err(err)?;
    flux::set_suspended(client, &kind, &ns, &name, suspend)
        .await
        .map_err(err)
}

#[tauri::command]
async fn start_port_forward(
    state: State<'_, AppState>,
    ns: String,
    pod: String,
    port: u16,
    local_port: Option<u16>,
) -> Result<PortForwardInfo, String> {
    let (context, client) = state.current().await.map_err(err)?;
    state
        .forwards
        .start(client, context, ns, pod, port, local_port.unwrap_or(0))
        .await
        .map_err(err)
}

#[tauri::command]
fn stop_port_forward(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    state.forwards.stop(id).map_err(err)
}

#[tauri::command]
fn list_port_forwards(state: State<'_, AppState>) -> Vec<PortForwardInfo> {
    state.forwards.list()
}

/// GUI apps launched from Finder get a minimal PATH, which breaks kubeconfig
/// `exec` auth plugins (gcloud, aws, kubelogin). Recover the login shell's PATH,
/// and make sure the usual Homebrew locations are present either way.
#[cfg(target_os = "macos")]
fn fix_path_env() {
    use std::process::{Command, Stdio};

    const MARK: &str = "__K8SVIEW_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let shell_path = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        // rc files may print noise, so pull the value out from between the markers.
        .and_then(|out| out.split(MARK).nth(1).map(str::to_owned))
        .filter(|p| !p.is_empty());

    let mut path = shell_path.unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    for dir in ["/usr/local/bin", "/opt/homebrew/bin"] {
        if !path.split(':').any(|p| p == dir) {
            path = format!("{dir}:{path}");
        }
    }
    // SAFETY: called at the very start of `run`, before Tauri or Tokio spawn any threads.
    unsafe { std::env::set_var("PATH", path) };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    fix_path_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            set_context,
            list_namespaces,
            list_pods,
            get_pod_detail,
            delete_pod,
            restart_pod,
            list_configmaps,
            start_port_forward,
            stop_port_forward,
            list_port_forwards,
            metrics_snapshot,
            pod_containers,
            start_log_stream,
            stop_log_stream,
            open_terminal_window,
            exec_start,
            exec_input,
            exec_resize,
            exec_stop,
            app_info,
            check_for_update,
            install_update,
            list_workload_versions,
            flux_snapshot,
            flux_detail,
            flux_reconcile,
            flux_set_suspended,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
