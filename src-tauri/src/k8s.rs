//! Kubernetes access and the DTOs handed to the frontend.
//!
//! Everything here returns plain serde structs so the UI never has to understand
//! raw Kubernetes objects.

use std::collections::BTreeMap;

use anyhow::{Context as _, Result, anyhow};
use k8s_openapi::api::core::v1::{ConfigMap, Container, ContainerStatus, Namespace, Pod};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use kube::api::{Api, DeleteParams, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde::Serialize;

#[derive(Serialize)]
pub struct ContextInfo {
    pub name: String,
    /// Namespace configured on the kubeconfig context, if any.
    pub namespace: Option<String>,
}

#[derive(Serialize)]
pub struct ContextList {
    pub contexts: Vec<ContextInfo>,
    /// The context the app is using: its own selection, else `current-context`.
    pub current: Option<String>,
}

#[derive(Serialize)]
pub struct PodRow {
    pub name: String,
    pub status: String,
    pub ready: String,
    pub restarts: i32,
    /// RFC 3339 creation timestamp; the UI turns it into an age.
    pub created: Option<String>,
    pub node: Option<String>,
    /// Kind of the controlling owner (ReplicaSet, StatefulSet, ...). `None` means a bare pod.
    pub owner_kind: Option<String>,
}

#[derive(Serialize)]
pub struct RestartResult {
    pub had_controller: bool,
}

#[derive(Serialize)]
pub struct ConfigMapRow {
    pub name: String,
    pub keys: usize,
    pub created: Option<String>,
    pub data: BTreeMap<String, String>,
}

pub fn read_kubeconfig() -> Result<Kubeconfig> {
    Kubeconfig::read().context("failed to read kubeconfig (~/.kube/config or $KUBECONFIG)")
}

pub fn list_contexts(selected: Option<&str>) -> Result<ContextList> {
    let kc = read_kubeconfig()?;
    let contexts = kc
        .contexts
        .iter()
        .map(|c| ContextInfo {
            name: c.name.clone(),
            namespace: c.context.as_ref().and_then(|ctx| ctx.namespace.clone()),
        })
        .collect();
    let current = selected.map(str::to_owned).or(kc.current_context);
    Ok(ContextList { contexts, current })
}

/// The kubeconfig's `current-context`, used until the user picks one.
pub fn default_context() -> Result<String> {
    read_kubeconfig()?
        .current_context
        .filter(|c| !c.is_empty())
        .ok_or_else(|| anyhow!("kubeconfig has no current-context; pick a context"))
}

pub async fn build_client(context: &str) -> Result<Client> {
    let kc = read_kubeconfig()?;
    let opts = KubeConfigOptions {
        context: Some(context.to_owned()),
        ..Default::default()
    };
    let config = Config::from_custom_kubeconfig(kc, &opts)
        .await
        .with_context(|| format!("invalid kubeconfig context {context:?}"))?;
    Client::try_from(config).context("failed to create Kubernetes client")
}

/// Cheap round-trip used to confirm a freshly built client can reach the cluster.
pub async fn verify(client: &Client) -> Result<()> {
    client
        .apiserver_version()
        .await
        .context("could not reach the API server")?;
    Ok(())
}

pub async fn list_namespaces(client: Client) -> Result<Vec<String>> {
    let list = Api::<Namespace>::all(client)
        .list(&ListParams::default())
        .await?;
    let mut names: Vec<String> = list
        .items
        .into_iter()
        .filter_map(|n| n.metadata.name)
        .collect();
    names.sort();
    Ok(names)
}

pub async fn list_pods(client: Client, ns: &str) -> Result<Vec<PodRow>> {
    let list = Api::<Pod>::namespaced(client, ns)
        .list(&ListParams::default())
        .await?;
    let mut rows: Vec<PodRow> = list.items.iter().map(pod_row).collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(rows)
}

pub async fn delete_pod(client: Client, ns: &str, name: &str) -> Result<()> {
    Api::<Pod>::namespaced(client, ns)
        .delete(name, &DeleteParams::default())
        .await?;
    Ok(())
}

/// "Restart" = delete and let the controller recreate it. Reports whether a controller exists.
pub async fn restart_pod(client: Client, ns: &str, name: &str) -> Result<RestartResult> {
    let api = Api::<Pod>::namespaced(client, ns);
    let pod = api.get(name).await?;
    let had_controller = controller_kind(&pod).is_some();
    api.delete(name, &DeleteParams::default()).await?;
    Ok(RestartResult { had_controller })
}

pub async fn list_configmaps(client: Client, ns: &str) -> Result<Vec<ConfigMapRow>> {
    let list = Api::<ConfigMap>::namespaced(client, ns)
        .list(&ListParams::default())
        .await?;
    let mut rows: Vec<ConfigMapRow> = list
        .items
        .into_iter()
        .map(|cm| {
            let data = configmap_data(&cm);
            ConfigMapRow {
                name: cm.metadata.name.unwrap_or_default(),
                keys: data.len(),
                created: timestamp(cm.metadata.creation_timestamp.as_ref()),
                data,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(rows)
}

/// `data` plus a placeholder for each `binaryData` key.
fn configmap_data(cm: &ConfigMap) -> BTreeMap<String, String> {
    let mut data = cm.data.clone().unwrap_or_default();
    for (key, bytes) in cm.binary_data.iter().flatten() {
        data.insert(key.clone(), format!("<binary, {} bytes>", bytes.0.len()));
    }
    data
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvKind {
    Value,
    ConfigMap,
    Secret,
    Field,
    Resource,
}

#[derive(Serialize)]
pub struct EnvVarRow {
    /// `PREFIX*` stands for every key of a source that could not be expanded.
    pub name: String,
    /// `None` for Secrets (never fetched) and anything that could not be resolved.
    pub value: Option<String>,
    pub kind: EnvKind,
    pub source: String,
}

#[derive(Serialize)]
pub struct ContainerDetail {
    pub name: String,
    pub init: bool,
    pub image: String,
    /// Tag from the image reference (`latest` if none), or its digest.
    pub version: String,
    /// Image the runtime actually pulled, usually `repo@sha256:...`.
    pub image_id: Option<String>,
    pub ports: Vec<ContainerPortRow>,
    pub env: Vec<EnvVarRow>,
}

#[derive(Serialize)]
pub struct ContainerPortRow {
    pub name: Option<String>,
    pub port: i32,
    pub protocol: String,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkStatus {
    Found,
    Missing,
    Unreadable,
}

#[derive(Serialize)]
pub struct ConfigMapLink {
    pub name: String,
    /// How the pod uses it, e.g. "env LOG_LEVEL in web".
    pub usages: Vec<String>,
    pub status: LinkStatus,
    pub error: Option<String>,
    pub data: BTreeMap<String, String>,
}

#[derive(Serialize)]
pub struct PodDetail {
    pub name: String,
    pub containers: Vec<ContainerDetail>,
    pub configmaps: Vec<ConfigMapLink>,
}

/// Images, environment, and referenced ConfigMaps of one pod.
pub async fn pod_detail(client: Client, ns: &str, name: &str) -> Result<PodDetail> {
    let pod = Api::<Pod>::namespaced(client.clone(), ns).get(name).await?;
    let spec = pod.spec.clone().unwrap_or_default();
    let status = pod.status.clone().unwrap_or_default();
    let containers: Vec<(&Container, bool)> = spec
        .init_containers
        .iter()
        .flatten()
        .map(|c| (c, true))
        .chain(spec.containers.iter().map(|c| (c, false)))
        .collect();

    // Every place the pod references a ConfigMap, keyed by ConfigMap name.
    let mut usages: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut note = |cm: &str, usage: String| {
        let list = usages.entry(cm.to_owned()).or_default();
        if !list.contains(&usage) {
            list.push(usage);
        }
    };
    for volume in spec.volumes.iter().flatten() {
        let mut names: Vec<&str> = volume.config_map.iter().map(|c| c.name.as_str()).collect();
        if let Some(projected) = &volume.projected {
            for source in projected.sources.iter().flatten() {
                names.extend(source.config_map.iter().map(|c| c.name.as_str()));
            }
        }
        if names.is_empty() {
            continue;
        }
        let mounts: Vec<String> = containers
            .iter()
            .flat_map(|(c, _)| {
                c.volume_mounts
                    .iter()
                    .flatten()
                    .filter(|m| m.name == volume.name)
                    .map(|m| format!("mounted at {} in {}", m.mount_path, c.name))
            })
            .collect();
        for cm in names {
            if mounts.is_empty() {
                note(cm, format!("volume {} (not mounted)", volume.name));
            }
            for mount in &mounts {
                note(cm, mount.clone());
            }
        }
    }
    for (c, _) in &containers {
        for from in c.env_from.iter().flatten() {
            if let Some(r) = &from.config_map_ref {
                note(&r.name, format!("envFrom in {}", c.name));
            }
        }
        for e in c.env.iter().flatten() {
            if let Some(r) = e
                .value_from
                .as_ref()
                .and_then(|v| v.config_map_key_ref.as_ref())
            {
                note(&r.name, format!("env {} in {}", e.name, c.name));
            }
        }
    }

    let cm_api = Api::<ConfigMap>::namespaced(client, ns);
    let mut env_data: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let mut configmaps = Vec::new();
    for (cm_name, usages) in usages {
        let (status, error, data) = match cm_api.get_opt(&cm_name).await {
            Ok(Some(cm)) => {
                // Only `data` (not `binaryData`) feeds environment variables.
                env_data.insert(cm_name.clone(), cm.data.clone().unwrap_or_default());
                (LinkStatus::Found, None, configmap_data(&cm))
            }
            Ok(None) => (LinkStatus::Missing, None, BTreeMap::new()),
            Err(e) => (LinkStatus::Unreadable, Some(e.to_string()), BTreeMap::new()),
        };
        configmaps.push(ConfigMapLink {
            name: cm_name,
            usages,
            status,
            error,
            data,
        });
    }

    let container_details = containers
        .iter()
        .map(|(c, init)| {
            let statuses = if *init {
                &status.init_container_statuses
            } else {
                &status.container_statuses
            };
            let image = c.image.clone().unwrap_or_default();
            ContainerDetail {
                name: c.name.clone(),
                init: *init,
                version: image_version(&image),
                image,
                image_id: statuses
                    .iter()
                    .flatten()
                    .find(|s: &&ContainerStatus| s.name == c.name)
                    .map(|s| s.image_id.clone())
                    .filter(|id| !id.is_empty()),
                ports: c
                    .ports
                    .iter()
                    .flatten()
                    .map(|p| ContainerPortRow {
                        name: p.name.clone(),
                        port: p.container_port,
                        protocol: p.protocol.clone().unwrap_or_else(|| "TCP".into()),
                    })
                    .collect(),
                env: container_env(&pod, c, &env_data),
            }
        })
        .collect();

    Ok(PodDetail {
        name: name.to_owned(),
        containers: container_details,
        configmaps,
    })
}

/// The tag of an image reference, falling back to its digest or the implied `latest`.
pub(crate) fn image_version(image: &str) -> String {
    let (reference, digest) = match image.split_once('@') {
        Some((r, d)) => (r, Some(d)),
        None => (image, None),
    };
    // A ':' before the last '/' is a registry port, not a tag.
    let last_segment = reference.rsplit('/').next().unwrap_or(reference);
    match (last_segment.rsplit_once(':'), digest) {
        (Some((_, tag)), _) => tag.to_owned(),
        (None, Some(d)) => d.to_owned(),
        (None, None) => "latest".to_owned(),
    }
}

/// Effective environment of a container: `envFrom` first, then `env`, later entries winning.
fn container_env(
    pod: &Pod,
    c: &Container,
    configmaps: &BTreeMap<String, BTreeMap<String, String>>,
) -> Vec<EnvVarRow> {
    let mut env: Vec<EnvVarRow> = Vec::new();
    let mut push = |row: EnvVarRow| {
        env.retain(|r| r.name != row.name);
        env.push(row);
    };

    for from in c.env_from.iter().flatten() {
        let prefix = from.prefix.as_deref().unwrap_or_default();
        if let Some(r) = &from.config_map_ref {
            match configmaps.get(&r.name) {
                Some(data) => {
                    for (key, value) in data {
                        push(EnvVarRow {
                            name: format!("{prefix}{key}"),
                            value: Some(value.clone()),
                            kind: EnvKind::ConfigMap,
                            source: format!("ConfigMap {} (envFrom)", r.name),
                        });
                    }
                }
                None => push(EnvVarRow {
                    name: format!("{prefix}*"),
                    value: None,
                    kind: EnvKind::ConfigMap,
                    source: format!("all keys of ConfigMap {} (unavailable)", r.name),
                }),
            }
        }
        if let Some(r) = &from.secret_ref {
            push(EnvVarRow {
                name: format!("{prefix}*"),
                value: None,
                kind: EnvKind::Secret,
                source: format!("all keys of Secret {}", r.name),
            });
        }
    }

    for e in c.env.iter().flatten() {
        let (value, kind, source) = match &e.value_from {
            None => (
                Some(e.value.clone().unwrap_or_default()),
                EnvKind::Value,
                "value".to_owned(),
            ),
            Some(from) => {
                if let Some(r) = &from.config_map_key_ref {
                    (
                        configmaps.get(&r.name).and_then(|d| d.get(&r.key)).cloned(),
                        EnvKind::ConfigMap,
                        format!("ConfigMap {} key {}", r.name, r.key),
                    )
                } else if let Some(r) = &from.secret_key_ref {
                    (
                        None,
                        EnvKind::Secret,
                        format!("Secret {} key {}", r.name, r.key),
                    )
                } else if let Some(r) = &from.field_ref {
                    (
                        field_value(pod, &r.field_path),
                        EnvKind::Field,
                        format!("field {}", r.field_path),
                    )
                } else if let Some(r) = &from.resource_field_ref {
                    let target = r.container_name.as_deref().unwrap_or(&c.name);
                    (
                        None,
                        EnvKind::Resource,
                        format!("resource {} of {target}", r.resource),
                    )
                } else {
                    (None, EnvKind::Field, "unsupported source".to_owned())
                }
            }
        };
        push(EnvVarRow {
            name: e.name.clone(),
            value,
            kind,
            source,
        });
    }
    env
}

/// Resolve the downward-API field paths that `fieldRef` supports.
fn field_value(pod: &Pod, path: &str) -> Option<String> {
    let meta = &pod.metadata;
    let map_entry = |map: &Option<BTreeMap<String, String>>, prefix: &str| {
        let key = path.strip_prefix(prefix)?.strip_suffix("']")?;
        map.as_ref()?.get(key).cloned()
    };
    match path {
        "metadata.name" => meta.name.clone(),
        "metadata.namespace" => meta.namespace.clone(),
        "metadata.uid" => meta.uid.clone(),
        "spec.nodeName" => pod.spec.as_ref()?.node_name.clone(),
        "spec.serviceAccountName" => pod.spec.as_ref()?.service_account_name.clone(),
        "status.podIP" => pod.status.as_ref()?.pod_ip.clone(),
        "status.hostIP" => pod.status.as_ref()?.host_ip.clone(),
        p if p.starts_with("metadata.labels['") => map_entry(&meta.labels, "metadata.labels['"),
        p if p.starts_with("metadata.annotations['") => {
            map_entry(&meta.annotations, "metadata.annotations['")
        }
        _ => None,
    }
}

fn timestamp(t: Option<&Time>) -> Option<String> {
    t.and_then(|t| serde_json::to_value(t).ok())
        .and_then(|v| v.as_str().map(str::to_owned))
}

fn controller_kind(pod: &Pod) -> Option<String> {
    pod.metadata
        .owner_references
        .as_ref()?
        .iter()
        .find(|o| o.controller == Some(true))
        .map(|o| o.kind.clone())
}

fn pod_row(pod: &Pod) -> PodRow {
    let spec = pod.spec.as_ref();
    let status = pod.status.as_ref();
    let container_statuses = status
        .and_then(|s| s.container_statuses.as_deref())
        .unwrap_or_default();

    let total = spec.map_or(0, |s| s.containers.len());
    let ready = container_statuses.iter().filter(|c| c.ready).count();
    let restarts = container_statuses.iter().map(|c| c.restart_count).sum();

    PodRow {
        name: pod.metadata.name.clone().unwrap_or_default(),
        status: pod_status(pod),
        ready: format!("{ready}/{total}"),
        restarts,
        created: timestamp(pod.metadata.creation_timestamp.as_ref()),
        node: spec.and_then(|s| s.node_name.clone()),
        owner_kind: controller_kind(pod),
    }
}

/// Status string following kubectl's `get pods` STATUS column logic.
fn pod_status(pod: &Pod) -> String {
    let status = pod.status.as_ref();
    let mut reason = status
        .and_then(|s| s.reason.clone().or_else(|| s.phase.clone()))
        .unwrap_or_else(|| "Unknown".into());

    // Init containers: a failing or still-running init step takes precedence.
    let init_statuses = status
        .and_then(|s| s.init_container_statuses.as_deref())
        .unwrap_or_default();
    let init_total = pod
        .spec
        .as_ref()
        .and_then(|s| s.init_containers.as_ref())
        .map_or(0, Vec::len);
    let mut initializing = false;
    for (i, c) in init_statuses.iter().enumerate() {
        let state = c.state.as_ref();
        if let Some(t) = state.and_then(|s| s.terminated.as_ref()) {
            if t.exit_code == 0 {
                continue;
            }
            reason = match (&t.reason, t.signal) {
                (Some(r), _) if !r.is_empty() => format!("Init:{r}"),
                (_, Some(sig)) if sig != 0 => format!("Init:Signal:{sig}"),
                _ => format!("Init:ExitCode:{}", t.exit_code),
            };
        } else if let Some(r) = state
            .and_then(|s| s.waiting.as_ref())
            .and_then(|w| w.reason.as_ref())
            .filter(|r| !r.is_empty() && r.as_str() != "PodInitializing")
        {
            reason = format!("Init:{r}");
        } else {
            reason = format!("Init:{i}/{init_total}");
        }
        initializing = true;
        break;
    }

    if !initializing {
        let containers = status
            .and_then(|s| s.container_statuses.as_deref())
            .unwrap_or_default();
        let mut has_running = false;
        for c in containers.iter().rev() {
            let Some(state) = c.state.as_ref() else {
                continue;
            };
            if let Some(r) = state
                .waiting
                .as_ref()
                .and_then(|w| w.reason.as_ref())
                .filter(|r| !r.is_empty())
            {
                reason = r.clone();
            } else if let Some(t) = state.terminated.as_ref() {
                reason = match (&t.reason, t.signal) {
                    (Some(r), _) if !r.is_empty() => r.clone(),
                    (_, Some(sig)) if sig != 0 => format!("Signal:{sig}"),
                    _ => format!("ExitCode:{}", t.exit_code),
                };
            } else if state.running.is_some() && c.ready {
                has_running = true;
            }
        }
        if reason == "Completed" && has_running {
            reason = "Running".into();
        }
    }

    if pod.metadata.deletion_timestamp.is_some() {
        reason = if status.and_then(|s| s.reason.as_deref()) == Some("NodeLost") {
            "Unknown".into()
        } else {
            "Terminating".into()
        };
    }
    reason
}
