//! CPU and memory usage from metrics-server, joined with requests, limits and
//! node capacity from the pod and node specs.

use std::collections::BTreeMap;

use anyhow::{Context as _, Result};
use k8s_openapi::api::core::v1::{Node, Pod, ResourceRequirements};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use kube::Client;
use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind, ListParams};
use serde::Serialize;

/// CPU in cores, memory in bytes.
#[derive(Serialize, Default, Clone, Copy)]
pub struct Resources {
    pub cpu: f64,
    pub memory: f64,
}

#[derive(Serialize)]
pub struct NodeUsage {
    pub name: String,
    pub ready: bool,
    pub usage: Option<Resources>,
    pub allocatable: Resources,
    pub capacity: Resources,
    /// Sum over non-terminated pods scheduled on the node.
    pub requests: Resources,
    pub limits: Resources,
    pub pods: usize,
    pub pod_capacity: usize,
}

#[derive(Serialize)]
pub struct ContainerUsage {
    pub name: String,
    pub usage: Option<Resources>,
    pub requests: Resources,
    /// `None` per resource when the container sets no limit.
    pub cpu_limit: Option<f64>,
    pub memory_limit: Option<f64>,
}

#[derive(Serialize)]
pub struct PodUsage {
    pub namespace: String,
    pub name: String,
    pub node: Option<String>,
    pub phase: String,
    pub usage: Option<Resources>,
    pub requests: Resources,
    /// Pod-level limit; `None` if any container is unlimited for that resource.
    pub cpu_limit: Option<f64>,
    pub memory_limit: Option<f64>,
    pub containers: Vec<ContainerUsage>,
}

#[derive(Serialize)]
pub struct MetricsSnapshot {
    /// When metrics-server isn't installed or reachable, usage is absent but specs still load.
    pub metrics_error: Option<String>,
    pub nodes: Vec<NodeUsage>,
    pub pods: Vec<PodUsage>,
}

fn metrics_api(client: &Client, kind: &str, plural: &str) -> Api<DynamicObject> {
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", kind);
    Api::all_with(
        client.clone(),
        &ApiResource::from_gvk_with_plural(&gvk, plural),
    )
}

pub async fn snapshot(client: Client) -> Result<MetricsSnapshot> {
    let params = ListParams::default();
    let (pod_api, node_api) = (
        Api::<Pod>::all(client.clone()),
        Api::<Node>::all(client.clone()),
    );
    let (pod_metrics_api, node_metrics_api) = (
        metrics_api(&client, "PodMetrics", "pods"),
        metrics_api(&client, "NodeMetrics", "nodes"),
    );
    let (pods, nodes, pod_metrics, node_metrics) = tokio::join!(
        pod_api.list(&params),
        node_api.list(&params),
        pod_metrics_api.list(&params),
        node_metrics_api.list(&params),
    );
    let pods = pods.context("failed to list pods")?.items;
    let nodes = nodes.context("failed to list nodes")?.items;

    let metrics_error = match (&pod_metrics, &node_metrics) {
        (Err(e), _) | (_, Err(e)) => Some(format!("metrics-server unavailable: {e}")),
        _ => None,
    };

    // (namespace, pod) -> container -> usage
    let mut pod_usage: BTreeMap<(String, String), BTreeMap<String, Resources>> = BTreeMap::new();
    for m in pod_metrics.map(|l| l.items).unwrap_or_default() {
        let key = (
            m.metadata.namespace.clone().unwrap_or_default(),
            m.metadata.name.clone().unwrap_or_default(),
        );
        let containers = pod_usage.entry(key).or_default();
        for c in m.data["containers"].as_array().into_iter().flatten() {
            if let Some(name) = c["name"].as_str() {
                containers.insert(name.to_owned(), usage_of(&c["usage"]));
            }
        }
    }
    let node_usage: BTreeMap<String, Resources> = node_metrics
        .map(|l| l.items)
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            (
                m.metadata.name.clone().unwrap_or_default(),
                usage_of(&m.data["usage"]),
            )
        })
        .collect();

    let mut node_requests: BTreeMap<String, (Resources, Resources, usize)> = BTreeMap::new();
    let mut out_pods = Vec::new();
    for pod in pods {
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        let name = pod.metadata.name.clone().unwrap_or_default();
        let phase = pod
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_default();
        let spec = pod.spec.unwrap_or_default();
        let usage_by_container = pod_usage.remove(&(namespace.clone(), name.clone()));

        let containers: Vec<ContainerUsage> = spec
            .containers
            .iter()
            .map(|c| {
                let (requests, cpu_limit, memory_limit) = requirements(c.resources.as_ref());
                ContainerUsage {
                    name: c.name.clone(),
                    usage: usage_by_container
                        .as_ref()
                        .and_then(|u| u.get(&c.name).copied()),
                    requests,
                    cpu_limit,
                    memory_limit,
                }
            })
            .collect();

        let requests = Resources {
            cpu: containers.iter().map(|c| c.requests.cpu).sum(),
            memory: containers.iter().map(|c| c.requests.memory).sum(),
        };
        let cpu_limit = containers.iter().map(|c| c.cpu_limit).sum::<Option<f64>>();
        let memory_limit = containers
            .iter()
            .map(|c| c.memory_limit)
            .sum::<Option<f64>>();
        let usage = usage_by_container.map(|u| Resources {
            cpu: u.values().map(|r| r.cpu).sum(),
            memory: u.values().map(|r| r.memory).sum(),
        });

        // Finished pods no longer hold their node's resources.
        if let Some(node) = &spec.node_name
            && phase != "Succeeded"
            && phase != "Failed"
        {
            let entry = node_requests.entry(node.clone()).or_default();
            entry.0.cpu += requests.cpu;
            entry.0.memory += requests.memory;
            entry.1.cpu += cpu_limit.unwrap_or(0.0);
            entry.1.memory += memory_limit.unwrap_or(0.0);
            entry.2 += 1;
        }

        out_pods.push(PodUsage {
            namespace,
            name,
            node: spec.node_name,
            phase,
            usage,
            requests,
            cpu_limit,
            memory_limit,
            containers,
        });
    }

    let out_nodes = nodes
        .into_iter()
        .map(|n| {
            let name = n.metadata.name.clone().unwrap_or_default();
            let status = n.status.unwrap_or_default();
            let of = |map: &Option<BTreeMap<String, Quantity>>| Resources {
                cpu: map
                    .as_ref()
                    .and_then(|m| m.get("cpu"))
                    .and_then(|q| parse_quantity(&q.0))
                    .unwrap_or(0.0),
                memory: map
                    .as_ref()
                    .and_then(|m| m.get("memory"))
                    .and_then(|q| parse_quantity(&q.0))
                    .unwrap_or(0.0),
            };
            let pod_capacity = status
                .allocatable
                .as_ref()
                .and_then(|m| m.get("pods"))
                .and_then(|q| parse_quantity(&q.0))
                .unwrap_or(0.0) as usize;
            let (requests, limits, pods) = node_requests.remove(&name).unwrap_or_default();
            NodeUsage {
                ready: status
                    .conditions
                    .iter()
                    .flatten()
                    .any(|c| c.type_ == "Ready" && c.status == "True"),
                usage: node_usage.get(&name).copied(),
                allocatable: of(&status.allocatable),
                capacity: of(&status.capacity),
                requests,
                limits,
                pods,
                pod_capacity,
                name,
            }
        })
        .collect();

    Ok(MetricsSnapshot {
        metrics_error,
        nodes: out_nodes,
        pods: out_pods,
    })
}

fn usage_of(v: &serde_json::Value) -> Resources {
    Resources {
        cpu: v["cpu"].as_str().and_then(parse_quantity).unwrap_or(0.0),
        memory: v["memory"].as_str().and_then(parse_quantity).unwrap_or(0.0),
    }
}

/// (requests, cpu limit, memory limit) of one container.
fn requirements(r: Option<&ResourceRequirements>) -> (Resources, Option<f64>, Option<f64>) {
    let get = |map: Option<&BTreeMap<String, Quantity>>, key: &str| {
        map.and_then(|m| m.get(key))
            .and_then(|q| parse_quantity(&q.0))
    };
    let requests = r.and_then(|r| r.requests.as_ref());
    let limits = r.and_then(|r| r.limits.as_ref());
    (
        Resources {
            // Kubernetes defaults a missing request to the limit.
            cpu: get(requests, "cpu")
                .or_else(|| get(limits, "cpu"))
                .unwrap_or(0.0),
            memory: get(requests, "memory")
                .or_else(|| get(limits, "memory"))
                .unwrap_or(0.0),
        },
        get(limits, "cpu"),
        get(limits, "memory"),
    )
}

/// Parse a Kubernetes quantity ("250m", "1.5", "128Mi", "1e3", "123456n") into a plain number.
pub fn parse_quantity(s: &str) -> Option<f64> {
    let s = s.trim();
    let split = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '+' || c == '-'))
        .unwrap_or(s.len());
    let (number, suffix) = s.split_at(split);
    let value: f64 = number.parse().ok()?;
    let scale = match suffix {
        "" => 1.0,
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        "Ki" => 1024.0,
        "Mi" => 1024f64.powi(2),
        "Gi" => 1024f64.powi(3),
        "Ti" => 1024f64.powi(4),
        "Pi" => 1024f64.powi(5),
        "Ei" => 1024f64.powi(6),
        // Decimal exponent: "1e3", "5E-2".
        e if e.len() > 1 && (e.starts_with('e') || e.starts_with('E')) => {
            10f64.powi(e[1..].parse().ok()?)
        }
        _ => return None,
    };
    Some(value * scale)
}

#[cfg(test)]
mod tests {
    use super::parse_quantity;

    #[test]
    fn quantities() {
        assert_eq!(parse_quantity("250m"), Some(0.25));
        assert_eq!(parse_quantity("2"), Some(2.0));
        assert_eq!(parse_quantity("1.5"), Some(1.5));
        assert_eq!(parse_quantity("128Mi"), Some(128.0 * 1024.0 * 1024.0));
        assert_eq!(parse_quantity("1Gi"), Some(1024f64.powi(3)));
        assert_eq!(parse_quantity("1G"), Some(1e9));
        assert_eq!(parse_quantity("1e3"), Some(1000.0));
        assert!((parse_quantity("123456n").unwrap() - 0.000123456).abs() < 1e-12);
        assert_eq!(parse_quantity("5216Mi"), Some(5216.0 * 1024.0 * 1024.0));
        assert_eq!(parse_quantity("abc"), None);
        assert_eq!(parse_quantity("1Zi"), None);
    }
}
