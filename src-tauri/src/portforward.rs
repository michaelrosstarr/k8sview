//! Local port forwards to pods, like `kubectl port-forward`.
//!
//! Each forward owns a TCP listener on 127.0.0.1. Every accepted connection
//! opens its own port-forward WebSocket to the pod and pipes bytes both ways.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, Result, anyhow, bail};
use k8s_openapi::api::core::v1::Pod;
use kube::client::UpgradeConnectionError;
use kube::{Api, Client};
use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

#[derive(Serialize, Clone)]
pub struct PortForwardInfo {
    pub id: u32,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub pod_port: u16,
    pub local_port: u16,
    pub active_connections: u32,
    pub total_connections: u64,
    /// Most recent connection failure (pod gone, nothing listening on the port, ...).
    pub last_error: Option<String>,
}

#[derive(Default)]
struct Stats {
    active: AtomicU32,
    total: AtomicU64,
    last_error: Mutex<Option<String>>,
}

impl Stats {
    fn fail(&self, e: anyhow::Error) {
        *self.last_error.lock().unwrap() = Some(format!("{e:#}"));
    }
}

struct Forward {
    info: PortForwardInfo,
    stats: Arc<Stats>,
    task: JoinHandle<()>,
}

impl Forward {
    fn snapshot(&self) -> PortForwardInfo {
        PortForwardInfo {
            active_connections: self.stats.active.load(Ordering::Relaxed),
            total_connections: self.stats.total.load(Ordering::Relaxed),
            last_error: self.stats.last_error.lock().unwrap().clone(),
            ..self.info.clone()
        }
    }
}

impl Drop for Forward {
    // Aborting the accept loop drops its JoinSet, which aborts open connections too.
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct PortForwards {
    next_id: AtomicU32,
    forwards: Mutex<BTreeMap<u32, Forward>>,
}

impl PortForwards {
    /// Start forwarding `127.0.0.1:local_port` (0 = pick a free port) to `pod_port` on the pod.
    pub async fn start(
        &self,
        client: Client,
        context: String,
        namespace: String,
        pod: String,
        pod_port: u16,
        local_port: u16,
    ) -> Result<PortForwardInfo> {
        let api = Api::<Pod>::namespaced(client, &namespace);
        // Fail fast instead of on the first connection.
        let phase = api
            .get(&pod)
            .await?
            .status
            .and_then(|s| s.phase)
            .unwrap_or_default();
        if phase != "Running" {
            bail!(
                "pod {pod} is {}, not Running",
                if phase.is_empty() { "Unknown" } else { &phase }
            );
        }
        let listener = TcpListener::bind(("127.0.0.1", local_port))
            .await
            .with_context(|| format!("cannot listen on 127.0.0.1:{local_port}"))?;
        let local_port = listener.local_addr()?.port();

        let stats = Arc::new(Stats::default());
        let task = tokio::spawn(serve(listener, api, pod.clone(), pod_port, stats.clone()));
        let forward = Forward {
            info: PortForwardInfo {
                id: self.next_id.fetch_add(1, Ordering::Relaxed) + 1,
                context,
                namespace,
                pod,
                pod_port,
                local_port,
                active_connections: 0,
                total_connections: 0,
                last_error: None,
            },
            stats,
            task,
        };
        let info = forward.snapshot();
        self.forwards.lock().unwrap().insert(info.id, forward);
        Ok(info)
    }

    pub fn stop(&self, id: u32) -> Result<()> {
        self.forwards
            .lock()
            .unwrap()
            .remove(&id)
            .map(drop)
            .ok_or_else(|| anyhow!("port forward {id} is not running"))
    }

    pub fn list(&self) -> Vec<PortForwardInfo> {
        self.forwards
            .lock()
            .unwrap()
            .values()
            .map(Forward::snapshot)
            .collect()
    }
}

async fn serve(listener: TcpListener, api: Api<Pod>, pod: String, port: u16, stats: Arc<Stats>) {
    let mut connections = JoinSet::new();
    loop {
        let socket = match listener.accept().await {
            Ok((socket, _)) => socket,
            Err(e) => {
                stats.fail(anyhow!(e).context("accept failed"));
                continue;
            }
        };
        while connections.try_join_next().is_some() {}

        let (api, pod, stats) = (api.clone(), pod.clone(), stats.clone());
        connections.spawn(async move {
            stats.active.fetch_add(1, Ordering::Relaxed);
            stats.total.fetch_add(1, Ordering::Relaxed);
            if let Err(e) = forward_connection(socket, &api, &pod, port).await {
                stats.fail(e);
            }
            stats.active.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

async fn forward_connection(
    mut socket: TcpStream,
    api: &Api<Pod>,
    pod: &str,
    port: u16,
) -> Result<()> {
    let mut forwarder = api.portforward(pod, &[port]).await.map_err(|e| match e {
        // Typically the pod was deleted or restarted after the forward started.
        kube::Error::UpgradeConnection(UpgradeConnectionError::ProtocolSwitch(status))
            if status.as_u16() == 404 =>
        {
            anyhow!("pod {pod} no longer exists; start a new forward to its replacement")
        }
        e => anyhow!(e).context(format!("port-forward to {pod} failed")),
    })?;
    let mut upstream = forwarder
        .take_stream(port)
        .ok_or_else(|| anyhow!("no stream for port {port}"))?;
    let error = forwarder.take_error(port);

    // I/O errors here are usually just one side hanging up; the error channel
    // below carries the failures worth reporting.
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
    drop(upstream);
    // The error future resolves once the forwarder's loop ends, so wait on both
    // together. `join` itself errors on ordinary closes ("Sending after closing
    // is not allowed"), so only the API server's error message is reported.
    let error = async {
        match error {
            Some(error) => error.await,
            None => None,
        }
    };
    let (message, _) = tokio::join!(error, forwarder.join());
    match message {
        Some(message) => bail!("{message}"),
        None => Ok(()),
    }
}
