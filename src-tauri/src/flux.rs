//! Flux (GitOps toolkit) objects, read generically through discovery so any
//! installed CRD version works, plus the same actions the `flux` CLI performs.

use std::collections::BTreeMap;

use anyhow::{Context as _, Result, anyhow};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Event;
use kube::Client;
use kube::api::{Api, DynamicObject, ListParams, Patch, PatchParams};
use kube::discovery::{self, ApiResource};
use serde::Serialize;
use serde_json::{Value, json};

/// Every Flux kind we know about, with its API group.
const KINDS: &[(&str, &str)] = &[
    ("GitRepository", "source.toolkit.fluxcd.io"),
    ("OCIRepository", "source.toolkit.fluxcd.io"),
    ("HelmRepository", "source.toolkit.fluxcd.io"),
    ("HelmChart", "source.toolkit.fluxcd.io"),
    ("Bucket", "source.toolkit.fluxcd.io"),
    ("Kustomization", "kustomize.toolkit.fluxcd.io"),
    ("HelmRelease", "helm.toolkit.fluxcd.io"),
    ("ImageRepository", "image.toolkit.fluxcd.io"),
    ("ImagePolicy", "image.toolkit.fluxcd.io"),
    ("ImageUpdateAutomation", "image.toolkit.fluxcd.io"),
    ("Alert", "notification.toolkit.fluxcd.io"),
    ("Provider", "notification.toolkit.fluxcd.io"),
    ("Receiver", "notification.toolkit.fluxcd.io"),
];

const RECONCILE_ANNOTATION: &str = "reconcile.fluxcd.io/requestedAt";
const FIELD_MANAGER: &str = "k8sview";

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FluxStatus {
    Ready,
    Failing,
    Progressing,
    Suspended,
    Unknown,
}

#[derive(Serialize, Clone)]
pub struct ObjectRef {
    pub kind: String,
    pub namespace: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct Condition {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_transition: Option<String>,
}

#[derive(Serialize)]
pub struct HelmHistoryEntry {
    pub version: Option<i64>,
    pub chart_version: Option<String>,
    pub app_version: Option<String>,
    pub status: Option<String>,
    pub first_deployed: Option<String>,
    pub last_deployed: Option<String>,
}

#[derive(Serialize)]
pub struct LastAction {
    pub action: String,
    pub duration_secs: f64,
}

#[derive(Serialize)]
pub struct FluxObject {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub status: FluxStatus,
    pub suspended: bool,
    /// Reason and message of the condition that decided `status`.
    pub reason: Option<String>,
    pub message: Option<String>,
    /// Artifact revision (sources), applied revision (Kustomization), or attempted chart version (HelmRelease).
    pub revision: Option<String>,
    pub source: Option<ObjectRef>,
    pub depends_on: Vec<ObjectRef>,
    pub interval: Option<String>,
    pub url: Option<String>,
    /// HelmRelease: `chart@version` currently released.
    pub chart: Option<String>,
    pub app_version: Option<String>,
    pub last_transition: Option<String>,
    pub created: Option<String>,
    pub last_action: Option<LastAction>,
    pub history: Vec<HelmHistoryEntry>,
    /// Kustomization: number of objects it manages.
    pub inventory: Option<usize>,
    pub conditions: Vec<Condition>,
}

#[derive(Serialize)]
pub struct Controller {
    pub name: String,
    pub namespace: String,
    pub version: Option<String>,
    pub ready: String,
    pub healthy: bool,
}

#[derive(Serialize)]
pub struct FluxSnapshot {
    /// Kinds whose CRDs are served by this cluster.
    pub kinds: Vec<String>,
    pub controllers: Vec<Controller>,
    pub objects: Vec<FluxObject>,
    /// Per-kind failures (typically RBAC) that didn't stop the rest.
    pub errors: Vec<String>,
}

#[derive(Serialize)]
pub struct EventRow {
    #[serde(rename = "type")]
    pub type_: Option<String>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub count: Option<i32>,
    pub last_seen: Option<String>,
}

#[derive(Serialize)]
pub struct KindCount {
    pub kind: String,
    pub count: usize,
}

#[derive(Serialize)]
pub struct FluxDetail {
    /// The full object minus `managedFields`; the UI renders it as YAML.
    pub object: Value,
    pub events: Vec<EventRow>,
    /// Kustomization: managed objects grouped by kind.
    pub inventory: Vec<KindCount>,
}

/// Served API resources for every installed Flux kind, keyed by kind.
async fn discover(client: &Client) -> BTreeMap<&'static str, ApiResource> {
    let mut groups: BTreeMap<&str, Option<discovery::ApiGroup>> = BTreeMap::new();
    for (_, group) in KINDS {
        if !groups.contains_key(group) {
            // A missing group (404) just means that part of Flux isn't installed.
            groups.insert(group, discovery::group(client, group).await.ok());
        }
    }
    KINDS
        .iter()
        .filter_map(|(kind, group)| {
            let (resource, _) = groups[group].as_ref()?.recommended_kind(kind)?;
            Some((*kind, resource))
        })
        .collect()
}

async fn resource_for(client: &Client, kind: &str) -> Result<ApiResource> {
    let group = KINDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, g)| *g)
        .ok_or_else(|| anyhow!("{kind} is not a Flux kind"))?;
    discovery::group(client, group)
        .await
        .with_context(|| format!("Flux API group {group} is not installed"))?
        .recommended_kind(kind)
        .map(|(resource, _)| resource)
        .ok_or_else(|| anyhow!("{kind} is not served by this cluster"))
}

pub async fn snapshot(client: Client) -> Result<FluxSnapshot> {
    let resources = discover(&client).await;
    let mut objects = Vec::new();
    let mut errors = Vec::new();
    for (kind, resource) in &resources {
        let api: Api<DynamicObject> = Api::all_with(client.clone(), resource);
        match api.list(&ListParams::default()).await {
            Ok(list) => objects.extend(list.items.iter().map(|o| flux_object(kind, o))),
            Err(e) => errors.push(format!("{kind}: {e}")),
        }
    }
    objects.sort_by(|a, b| (&a.kind, &a.namespace, &a.name).cmp(&(&b.kind, &b.namespace, &b.name)));

    let controllers = match controllers(&client).await {
        Ok(c) => c,
        Err(e) => {
            errors.push(format!("controllers: {e:#}"));
            Vec::new()
        }
    };

    Ok(FluxSnapshot {
        kinds: resources.keys().map(|k| k.to_string()).collect(),
        controllers,
        objects,
        errors,
    })
}

async fn controllers(client: &Client) -> Result<Vec<Controller>> {
    let params = ListParams::default().labels("app.kubernetes.io/part-of=flux");
    let list = Api::<Deployment>::all(client.clone()).list(&params).await?;
    let mut controllers: Vec<Controller> = list
        .items
        .into_iter()
        .map(|d| {
            let want = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let ready = d
                .status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0);
            let image = d
                .spec
                .as_ref()
                .and_then(|s| s.template.spec.as_ref())
                .and_then(|s| s.containers.first())
                .and_then(|c| c.image.clone());
            Controller {
                name: d.metadata.name.unwrap_or_default(),
                namespace: d.metadata.namespace.unwrap_or_default(),
                version: image.and_then(|i| i.rsplit_once(':').map(|(_, tag)| tag.to_owned())),
                ready: format!("{ready}/{want}"),
                healthy: ready >= want,
            }
        })
        .collect();
    controllers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(controllers)
}

pub async fn detail(client: Client, kind: &str, ns: &str, name: &str) -> Result<FluxDetail> {
    let resource = resource_for(&client, kind).await?;
    let obj = Api::<DynamicObject>::namespaced_with(client.clone(), ns, &resource)
        .get(name)
        .await?;

    let inventory = {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for entry in obj.data["status"]["inventory"]["entries"]
            .as_array()
            .into_iter()
            .flatten()
        {
            // Inventory ids are `<namespace>_<name>_<group>_<kind>`.
            if let Some(kind) = entry["id"].as_str().and_then(|id| id.rsplit('_').next()) {
                *counts.entry(kind.to_owned()).or_default() += 1;
            }
        }
        let mut counts: Vec<KindCount> = counts
            .into_iter()
            .map(|(kind, count)| KindCount { kind, count })
            .collect();
        counts.sort_by(|a, b| b.count.cmp(&a.count).then(a.kind.cmp(&b.kind)));
        counts
    };

    let mut object = serde_json::to_value(&obj)?;
    if let Some(meta) = object.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
    }

    let params = ListParams::default().fields(&format!(
        "involvedObject.kind={kind},involvedObject.name={name}"
    ));
    let mut events: Vec<EventRow> = Api::<Event>::namespaced(client, ns)
        .list(&params)
        .await
        .map(|l| l.items)
        .unwrap_or_default()
        .into_iter()
        .map(|e| EventRow {
            last_seen: e
                .last_timestamp
                .as_ref()
                .or(e.first_timestamp.as_ref())
                .map(|t| t.0.to_string())
                .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string())),
            type_: e.type_,
            reason: e.reason,
            message: e.message,
            count: e.count,
        })
        .collect();
    events.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));

    Ok(FluxDetail {
        object,
        events,
        inventory,
    })
}

fn now() -> String {
    k8s_openapi::jiff::Timestamp::now().to_string()
}

async fn patch(
    client: &Client,
    kind: &str,
    ns: &str,
    name: &str,
    body: Value,
) -> Result<DynamicObject> {
    let resource = resource_for(client, kind).await?;
    let params = PatchParams {
        field_manager: Some(FIELD_MANAGER.into()),
        ..Default::default()
    };
    Api::<DynamicObject>::namespaced_with(client.clone(), ns, &resource)
        .patch(name, &params, &Patch::Merge(body))
        .await
        .with_context(|| format!("failed to patch {kind} {ns}/{name}"))
}

fn reconcile_body() -> Value {
    json!({ "metadata": { "annotations": { RECONCILE_ANNOTATION: now() } } })
}

/// Ask the controller to reconcile now, like `flux reconcile`. With `with_source`,
/// the object's source (and a HelmRelease's HelmChart) is refreshed first.
/// Returns the objects that were annotated.
pub async fn reconcile(
    client: Client,
    kind: &str,
    ns: &str,
    name: &str,
    with_source: bool,
) -> Result<Vec<ObjectRef>> {
    let mut requested = Vec::new();
    if with_source {
        let resource = resource_for(&client, kind).await?;
        let obj = Api::<DynamicObject>::namespaced_with(client.clone(), ns, &resource)
            .get(name)
            .await?;
        let mut sources: Vec<ObjectRef> = source_ref(kind, ns, &obj.data).into_iter().collect();
        if kind == "HelmRelease"
            && let Some((chart_ns, chart)) = obj.data["status"]["helmChart"]
                .as_str()
                .and_then(|c| c.split_once('/'))
        {
            sources.push(ObjectRef {
                kind: "HelmChart".into(),
                namespace: chart_ns.into(),
                name: chart.into(),
            });
        }
        for source in sources {
            patch(
                &client,
                &source.kind,
                &source.namespace,
                &source.name,
                reconcile_body(),
            )
            .await?;
            requested.push(source);
        }
    }
    patch(&client, kind, ns, name, reconcile_body()).await?;
    requested.push(ObjectRef {
        kind: kind.into(),
        namespace: ns.into(),
        name: name.into(),
    });
    Ok(requested)
}

/// `flux suspend` / `flux resume`. Resuming also requests a reconcile, as the CLI does.
pub async fn set_suspended(
    client: Client,
    kind: &str,
    ns: &str,
    name: &str,
    suspend: bool,
) -> Result<()> {
    let mut body = json!({ "spec": { "suspend": suspend } });
    if !suspend {
        body["metadata"] = reconcile_body()["metadata"].take();
    }
    patch(&client, kind, ns, name, body).await?;
    Ok(())
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn source_ref(kind: &str, ns: &str, data: &Value) -> Option<ObjectRef> {
    let spec = &data["spec"];
    let r = match kind {
        "HelmRelease" if spec["chartRef"].is_object() => &spec["chartRef"],
        "HelmRelease" => &spec["chart"]["spec"]["sourceRef"],
        "Kustomization" | "HelmChart" => &spec["sourceRef"],
        _ => return None,
    };
    Some(ObjectRef {
        kind: str_of(&r["kind"])?,
        namespace: str_of(&r["namespace"]).unwrap_or_else(|| ns.to_owned()),
        name: str_of(&r["name"])?,
    })
}

fn flux_object(kind: &str, obj: &DynamicObject) -> FluxObject {
    let data = &obj.data;
    let (spec, status) = (&data["spec"], &data["status"]);
    let namespace = obj.metadata.namespace.clone().unwrap_or_default();

    let conditions: Vec<Condition> = status["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| Condition {
            type_: str_of(&c["type"]).unwrap_or_default(),
            status: str_of(&c["status"]).unwrap_or_else(|| "Unknown".into()),
            reason: str_of(&c["reason"]),
            message: str_of(&c["message"]),
            last_transition: str_of(&c["lastTransitionTime"]),
        })
        .collect();
    let cond = |t: &str| conditions.iter().find(|c| c.type_ == t);
    let suspended = spec["suspend"].as_bool().unwrap_or(false);

    // Same precedence `flux get` effectively shows: stalled beats everything,
    // then Ready, with Reconciling covering in-flight work.
    let (mut state, deciding) = match (cond("Stalled"), cond("Ready"), cond("Reconciling")) {
        (Some(s), _, _) if s.status == "True" => (FluxStatus::Failing, Some(s)),
        (_, Some(r), _) if r.status == "True" => (FluxStatus::Ready, Some(r)),
        (_, Some(r), _) if r.status == "False" => (FluxStatus::Failing, Some(r)),
        (_, r, Some(rc)) if rc.status == "True" => (FluxStatus::Progressing, r.or(Some(rc))),
        (_, Some(r), _) => (FluxStatus::Progressing, Some(r)),
        _ => (FluxStatus::Unknown, None),
    };
    // A Stalled condition's reason ("RetriesExceeded") is less useful than Ready's message.
    let deciding = match (state, cond("Ready")) {
        (FluxStatus::Failing, Some(r)) if r.status == "False" => Some(r),
        _ => deciding,
    };
    let mut reason = deciding.and_then(|c| c.reason.clone());
    let mut message = deciding.and_then(|c| c.message.clone());
    // OCI HelmRepositories are static: source-controller never reconciles them,
    // so they have no conditions. That is healthy, not unknown.
    if kind == "HelmRepository" && spec["type"].as_str() == Some("oci") && conditions.is_empty() {
        state = FluxStatus::Ready;
        reason = Some("Static".into());
        message = Some("OCI Helm repository: not reconciled by source-controller; each HelmChart pulls from it directly".into());
    }
    if suspended {
        state = FluxStatus::Suspended;
    }

    // Only HelmRelease history is Helm releases; Kustomizations (kustomize-controller
    // v1.7+) keep a differently shaped reconcile history under the same field.
    let history: Vec<HelmHistoryEntry> = status["history"]
        .as_array()
        .filter(|_| kind == "HelmRelease")
        .into_iter()
        .flatten()
        .map(|h| HelmHistoryEntry {
            version: h["version"].as_i64(),
            chart_version: str_of(&h["chartVersion"]),
            app_version: str_of(&h["appVersion"]),
            status: str_of(&h["status"]),
            first_deployed: str_of(&h["firstDeployed"]),
            last_deployed: str_of(&h["lastDeployed"]),
        })
        .collect();
    let current = status["history"].get(0).filter(|_| kind == "HelmRelease");

    let revision = match kind {
        "Kustomization" => str_of(&status["lastAppliedRevision"])
            .or_else(|| str_of(&status["lastAttemptedRevision"])),
        "HelmRelease" => str_of(&status["lastAttemptedRevision"]),
        _ => str_of(&status["artifact"]["revision"]),
    };

    FluxObject {
        kind: kind.to_owned(),
        name: obj.metadata.name.clone().unwrap_or_default(),
        status: state,
        suspended,
        reason,
        message,
        revision,
        source: source_ref(kind, &namespace, data),
        depends_on: spec["dependsOn"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| {
                Some(ObjectRef {
                    kind: kind.to_owned(),
                    namespace: str_of(&d["namespace"]).unwrap_or_else(|| namespace.clone()),
                    name: str_of(&d["name"])?,
                })
            })
            .collect(),
        interval: str_of(&spec["interval"]),
        url: str_of(&spec["url"]),
        chart: current.and_then(|h| {
            Some(format!(
                "{}@{}",
                str_of(&h["chartName"])?,
                str_of(&h["chartVersion"])?
            ))
        }),
        app_version: current.and_then(|h| str_of(&h["appVersion"])),
        last_transition: cond("Ready").and_then(|c| c.last_transition.clone()),
        created: obj
            .metadata
            .creation_timestamp
            .as_ref()
            .map(|t| t.0.to_string()),
        last_action: str_of(&status["lastAttemptedReleaseAction"])
            .zip(
                status["lastAttemptedReleaseActionDuration"]
                    .as_str()
                    .and_then(parse_go_duration),
            )
            .map(|(action, duration_secs)| LastAction {
                action,
                duration_secs,
            }),
        history,
        inventory: status["inventory"]["entries"].as_array().map(Vec::len),
        namespace,
        conditions,
    }
}

/// Parse a Go `time.Duration` string such as "22.598s", "1m30s" or "1h2m3.5s".
fn parse_go_duration(s: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut rest = s.trim();
    if rest.is_empty() {
        return None;
    }
    while !rest.is_empty() {
        let num_len = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
        let value: f64 = rest[..num_len].parse().ok()?;
        rest = &rest[num_len..];
        let unit_len = rest
            .find(|c: char| c.is_ascii_digit() || c == '.')
            .unwrap_or(rest.len());
        let scale = match &rest[..unit_len] {
            "h" => 3600.0,
            "m" => 60.0,
            "s" => 1.0,
            "ms" => 1e-3,
            "us" | "µs" => 1e-6,
            "ns" => 1e-9,
            _ => return None,
        };
        total += value * scale;
        rest = &rest[unit_len..];
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::parse_go_duration;

    #[test]
    fn go_durations() {
        assert_eq!(parse_go_duration("22.5s"), Some(22.5));
        assert_eq!(parse_go_duration("1m30s"), Some(90.0));
        assert_eq!(parse_go_duration("1h2m3s"), Some(3723.0));
        assert_eq!(parse_go_duration("250ms"), Some(0.25));
        assert_eq!(parse_go_duration("abc"), None);
        assert_eq!(parse_go_duration(""), None);
    }
}
