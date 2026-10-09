//! What version of everything is deployed, across all namespaces.
//!
//! Each workload reports three kinds of version: container image tags (plus the
//! digests its pods are actually running), and the Helm chart / app version
//! from the standard `helm.sh/chart` and `app.kubernetes.io/version` labels.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::CronJob;
use k8s_openapi::api::core::v1::{Pod, PodSpec};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::Client;
use kube::api::{Api, ListParams};
use serde::Serialize;

use crate::k8s::image_version;

#[derive(Serialize)]
pub struct ContainerVersion {
    pub name: String,
    pub image: String,
    /// Tag from the image reference (`latest` when there is none), or its digest.
    pub version: String,
    /// Distinct image digests (`sha256:...`) this container's pods are running.
    pub running: Vec<String>,
}

#[derive(Serialize)]
pub struct WorkloadVersion {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub containers: Vec<ContainerVersion>,
    /// `helm.sh/chart` label, e.g. "dams-0.2.11".
    pub chart: Option<String>,
    pub chart_version: Option<String>,
    /// `app.kubernetes.io/version` label.
    pub app_version: Option<String>,
    /// Flux HelmRelease that manages it, as "namespace/name".
    pub helm_release: Option<String>,
    /// "ready/desired" pods; `None` for CronJobs.
    pub ready: Option<String>,
}

/// (namespace, workload kind, workload name, container) -> running digests.
type RunningDigests = BTreeMap<(String, String, String, String), BTreeSet<String>>;

pub async fn list(client: Client) -> Result<Vec<WorkloadVersion>> {
    let params = ListParams::default();
    let running = running_digests(&Api::<Pod>::all(client.clone()).list(&params).await?.items);
    let mut out = Vec::new();

    for d in Api::<Deployment>::all(client.clone())
        .list(&params)
        .await?
        .items
    {
        let ready = d
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        let want = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let pod = d.spec.as_ref().and_then(|s| s.template.spec.as_ref());
        out.push(workload(
            "Deployment",
            &d.metadata,
            pod,
            Some(format!("{ready}/{want}")),
            &running,
        ));
    }
    for s in Api::<StatefulSet>::all(client.clone())
        .list(&params)
        .await?
        .items
    {
        let ready = s
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        let want = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let pod = s.spec.as_ref().and_then(|s| s.template.spec.as_ref());
        out.push(workload(
            "StatefulSet",
            &s.metadata,
            pod,
            Some(format!("{ready}/{want}")),
            &running,
        ));
    }
    for d in Api::<DaemonSet>::all(client.clone())
        .list(&params)
        .await?
        .items
    {
        let status = d.status.as_ref();
        let ready = status.map_or(0, |s| s.number_ready);
        let want = status.map_or(0, |s| s.desired_number_scheduled);
        let pod = d.spec.as_ref().and_then(|s| s.template.spec.as_ref());
        out.push(workload(
            "DaemonSet",
            &d.metadata,
            pod,
            Some(format!("{ready}/{want}")),
            &running,
        ));
    }
    for c in Api::<CronJob>::all(client).list(&params).await?.items {
        let pod = c
            .spec
            .job_template
            .spec
            .as_ref()
            .and_then(|j| j.template.spec.as_ref());
        out.push(workload("CronJob", &c.metadata, pod, None, &running));
    }

    out.sort_by(|a, b| (&a.name, &a.namespace, &a.kind).cmp(&(&b.name, &b.namespace, &b.kind)));
    Ok(out)
}

fn workload(
    kind: &str,
    meta: &ObjectMeta,
    pod: Option<&PodSpec>,
    ready: Option<String>,
    running: &RunningDigests,
) -> WorkloadVersion {
    let namespace = meta.namespace.clone().unwrap_or_default();
    let name = meta.name.clone().unwrap_or_default();
    let label = |k: &str| {
        meta.labels
            .as_ref()
            .and_then(|l| l.get(k))
            .filter(|v| !v.is_empty())
            .cloned()
    };
    let chart = label("helm.sh/chart");

    let containers = pod
        .map(|p| p.containers.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|c| {
            let image = c.image.clone().unwrap_or_default();
            let key = (
                namespace.clone(),
                kind.to_owned(),
                name.clone(),
                c.name.clone(),
            );
            ContainerVersion {
                name: c.name.clone(),
                version: image_version(&image),
                image,
                running: running
                    .get(&key)
                    .map(|s| s.iter().cloned().collect())
                    .unwrap_or_default(),
            }
        })
        .collect();

    WorkloadVersion {
        kind: kind.to_owned(),
        chart_version: chart.as_deref().and_then(chart_version),
        chart,
        app_version: label("app.kubernetes.io/version"),
        helm_release: label("helm.toolkit.fluxcd.io/name").map(|n| {
            format!(
                "{}/{n}",
                label("helm.toolkit.fluxcd.io/namespace").unwrap_or_else(|| namespace.clone())
            )
        }),
        ready,
        containers,
        namespace,
        name,
    }
}

/// "registry-api-legacy-0.1.14" -> "0.1.14": the version starts at the first "-<digit>".
fn chart_version(chart: &str) -> Option<String> {
    let bytes = chart.as_bytes();
    (1..bytes.len())
        .find(|&i| bytes[i - 1] == b'-' && bytes[i].is_ascii_digit())
        .map(|i| chart[i..].to_owned())
}

/// Map each pod back to its workload and collect the image digests it runs.
fn running_digests(pods: &[Pod]) -> RunningDigests {
    let mut out = RunningDigests::new();
    for pod in pods {
        let Some(owner) = pod
            .metadata
            .owner_references
            .as_ref()
            .and_then(|o| o.iter().find(|o| o.controller == Some(true)))
        else {
            continue;
        };
        // Deployment pods are owned by a ReplicaSet named "<deployment>-<pod-template-hash>".
        let (kind, name) = match owner.kind.as_str() {
            "ReplicaSet" => {
                let hash = pod
                    .metadata
                    .labels
                    .as_ref()
                    .and_then(|l| l.get("pod-template-hash"));
                match hash.and_then(|h| owner.name.strip_suffix(&format!("-{h}"))) {
                    Some(deployment) => ("Deployment", deployment.to_owned()),
                    None => continue,
                }
            }
            "StatefulSet" | "DaemonSet" => (owner.kind.as_str(), owner.name.clone()),
            _ => continue,
        };
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        for status in pod
            .status
            .iter()
            .flat_map(|s| s.container_statuses.iter().flatten())
        {
            if let Some((_, digest)) = status.image_id.split_once('@') {
                out.entry((
                    namespace.clone(),
                    kind.to_owned(),
                    name.clone(),
                    status.name.clone(),
                ))
                .or_default()
                .insert(digest.to_owned());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::chart_version;

    #[test]
    fn chart_versions() {
        assert_eq!(chart_version("dams-0.2.11").as_deref(), Some("0.2.11"));
        assert_eq!(
            chart_version("registry-api-legacy-0.1.14").as_deref(),
            Some("0.1.14")
        );
        assert_eq!(
            chart_version("redis-28.3.1-rc1").as_deref(),
            Some("28.3.1-rc1")
        );
        assert_eq!(chart_version("nochart"), None);
    }
}
