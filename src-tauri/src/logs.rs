//! Streaming pod logs to the UI, one task per open log terminal.
//!
//! Lines are batched (every ~80ms or 1000 lines) so a chatty pod doesn't turn
//! into thousands of IPC messages per second.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use anyhow::Result;
use futures::AsyncBufReadExt;
use k8s_openapi::api::core::v1::Pod;
use kube::Client;
use kube::api::{Api, LogParams};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::task::JoinHandle;

const FLUSH_EVERY: Duration = Duration::from_millis(80);
const MAX_BATCH: usize = 1000;

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LogEvent {
    Lines {
        lines: Vec<String>,
    },
    /// The stream finished (container exited, or a non-follow request completed).
    End,
    Error {
        message: String,
    },
}

#[derive(Deserialize)]
pub struct LogOptions {
    pub container: Option<String>,
    pub previous: bool,
    pub timestamps: bool,
    /// `None` streams the whole log.
    pub tail_lines: Option<i64>,
}

#[derive(Serialize)]
pub struct ContainerInfo {
    pub name: String,
    pub init: bool,
    pub restart_count: i32,
    /// "running", "waiting: CrashLoopBackOff", "terminated: Completed", ...
    pub state: String,
}

#[derive(Default)]
pub struct LogStreams {
    next_id: AtomicU32,
    tasks: Mutex<HashMap<u32, JoinHandle<()>>>,
}

impl LogStreams {
    pub fn start(
        &self,
        client: Client,
        ns: &str,
        pod: String,
        options: LogOptions,
        channel: Channel<LogEvent>,
    ) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let api = Api::<Pod>::namespaced(client, ns);
        let params = LogParams {
            container: options.container,
            // Previous (terminated) containers have nothing more to follow.
            follow: !options.previous,
            previous: options.previous,
            timestamps: options.timestamps,
            tail_lines: options.tail_lines,
            ..Default::default()
        };
        let task = tokio::spawn(async move {
            if let Err(e) = stream(api, &pod, &params, &channel).await {
                let _ = channel.send(LogEvent::Error {
                    message: crate::err(e),
                });
            }
        });
        self.tasks.lock().unwrap().insert(id, task);
        id
    }

    pub fn stop(&self, id: u32) {
        if let Some(task) = self.tasks.lock().unwrap().remove(&id) {
            task.abort();
        }
    }
}

async fn stream(
    api: Api<Pod>,
    pod: &str,
    params: &LogParams,
    channel: &Channel<LogEvent>,
) -> Result<()> {
    let mut reader = Box::pin(api.log_stream(pod, params).await?);
    let mut buf = Vec::new();
    let mut batch = Vec::new();
    let mut tick = tokio::time::interval(FLUSH_EVERY);

    let flush = |batch: &mut Vec<String>| -> Result<()> {
        if !batch.is_empty() {
            channel.send(LogEvent::Lines {
                lines: std::mem::take(batch),
            })?;
        }
        Ok(())
    };

    loop {
        tokio::select! {
            // `read_until` appends to `buf` as it goes, so being cancelled by the
            // ticker mid-line loses nothing: the next call continues the line.
            read = reader.read_until(b'\n', &mut buf) => {
                if read? == 0 {
                    if !buf.is_empty() {
                        batch.push(String::from_utf8_lossy(&buf).into_owned());
                    }
                    flush(&mut batch)?;
                    channel.send(LogEvent::End)?;
                    return Ok(());
                }
                if buf.last() == Some(&b'\n') {
                    let line = buf.strip_suffix(b"\n").unwrap_or(&buf);
                    let line = line.strip_suffix(b"\r").unwrap_or(line);
                    batch.push(String::from_utf8_lossy(line).into_owned());
                    buf.clear();
                    if batch.len() >= MAX_BATCH {
                        flush(&mut batch)?;
                    }
                }
            }
            _ = tick.tick() => flush(&mut batch)?,
        }
    }
}

pub async fn containers(client: Client, ns: &str, pod: &str) -> Result<Vec<ContainerInfo>> {
    let pod = Api::<Pod>::namespaced(client, ns).get(pod).await?;
    let spec = pod.spec.unwrap_or_default();
    let status = pod.status.unwrap_or_default();
    let describe = |statuses: &Option<Vec<k8s_openapi::api::core::v1::ContainerStatus>>,
                    name: &str| {
        let s = statuses.iter().flatten().find(|s| s.name == name);
        let state = s
            .and_then(|s| s.state.as_ref())
            .map_or("unknown".to_owned(), |st| {
                if st.running.is_some() {
                    "running".to_owned()
                } else if let Some(w) = &st.waiting {
                    format!("waiting: {}", w.reason.as_deref().unwrap_or("-"))
                } else if let Some(t) = &st.terminated {
                    format!("terminated: {}", t.reason.as_deref().unwrap_or("-"))
                } else {
                    "unknown".to_owned()
                }
            });
        (s.map_or(0, |s| s.restart_count), state)
    };
    let mut out = Vec::new();
    for c in spec.containers {
        let (restart_count, state) = describe(&status.container_statuses, &c.name);
        out.push(ContainerInfo {
            name: c.name,
            init: false,
            restart_count,
            state,
        });
    }
    for c in spec.init_containers.unwrap_or_default() {
        let (restart_count, state) = describe(&status.init_container_statuses, &c.name);
        out.push(ContainerInfo {
            name: c.name,
            init: true,
            restart_count,
            state,
        });
    }
    Ok(out)
}
