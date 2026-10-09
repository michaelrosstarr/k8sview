//! Interactive terminals into containers: `kubectl exec -it` (run a command,
//! a shell by default) and `kubectl attach -it` (the container's main process).

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{Result, anyhow};
use futures::SinkExt;
use futures::channel::mpsc::Sender as ResizeSender;
use k8s_openapi::api::core::v1::Pod;
use kube::Client;
use kube::api::{Api, AttachParams, TerminalSize};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// Prefer bash, fall back to sh; set TERM since `exec` doesn't.
const DEFAULT_SHELL: &str = "export TERM=xterm-256color; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Run a command (a shell unless one is given).
    Exec,
    /// Connect to the container's main process.
    Attach,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExecEvent {
    /// The process ended. `code` is its exit code when Kubernetes reports one.
    Exit {
        code: Option<i32>,
        message: Option<String>,
    },
}

struct Session {
    input: mpsc::UnboundedSender<Vec<u8>>,
    resize: Option<ResizeSender<TerminalSize>>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct ExecSessions {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

impl ExecSessions {
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        client: Client,
        ns: &str,
        pod: &str,
        container: Option<String>,
        mode: Mode,
        command: Option<Vec<String>>,
        output: Channel<InvokeResponseBody>,
        events: Channel<ExecEvent>,
    ) -> Result<u32> {
        let api = Api::<Pod>::namespaced(client, ns);
        let mut params = AttachParams::interactive_tty();
        if let Some(c) = container {
            params = params.container(c);
        }
        let mut process = match mode {
            Mode::Exec => {
                let command = command
                    .filter(|c| !c.is_empty())
                    .unwrap_or_else(|| vec!["/bin/sh".into(), "-c".into(), DEFAULT_SHELL.into()]);
                api.exec(pod, command, &params).await?
            }
            Mode::Attach => api.attach(pod, &params).await?,
        };
        let mut stdin = process
            .stdin()
            .ok_or_else(|| anyhow!("no stdin on the attached process"))?;
        let mut stdout = process
            .stdout()
            .ok_or_else(|| anyhow!("no stdout on the attached process"))?;
        let resize = process.terminal_size();
        let status = process.take_status();
        let (input, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let task = tokio::spawn(async move {
            let reader = async {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if output
                                .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                }
            };
            let writer = async {
                while let Some(data) = input_rx.recv().await {
                    if stdin.write_all(&data).await.is_err() || stdin.flush().await.is_err() {
                        break;
                    }
                }
            };
            // Output ending means the process exited; input ending means we were stopped.
            tokio::select! {
                _ = reader => {}
                _ = writer => {}
            }
            let status = match status {
                Some(status) => status.await,
                None => None,
            };
            let code = status.as_ref().map(|s| {
                if s.status.as_deref() == Some("Success") {
                    0
                } else {
                    // Non-zero exits carry the code as an "ExitCode" cause.
                    s.details
                        .as_ref()
                        .and_then(|d| d.causes.as_ref())
                        .and_then(|c| c.iter().find(|c| c.reason.as_deref() == Some("ExitCode")))
                        .and_then(|c| c.message.as_deref()?.parse().ok())
                        .unwrap_or(1)
                }
            });
            let message = status.and_then(|s| s.message).filter(|m| !m.is_empty());
            let _ = events.send(ExecEvent::Exit { code, message });
            // Keep the process (and its websocket) alive until here.
            drop(process);
        });

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                input,
                resize,
                task,
            },
        );
        Ok(id)
    }

    pub fn input(&self, id: u32, data: Vec<u8>) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&id)
            .ok_or_else(|| anyhow!("terminal session {id} has ended"))?;
        session
            .input
            .send(data)
            .map_err(|_| anyhow!("terminal session {id} has ended"))
    }

    pub async fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<()> {
        let sender = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|s| s.resize.clone());
        if let Some(mut sender) = sender {
            // A closed session just means the resize no longer matters.
            let _ = sender
                .send(TerminalSize {
                    width: cols,
                    height: rows,
                })
                .await;
        }
        Ok(())
    }

    pub fn stop(&self, id: u32) {
        if let Some(session) = self.sessions.lock().unwrap().remove(&id) {
            session.task.abort();
        }
    }
}
