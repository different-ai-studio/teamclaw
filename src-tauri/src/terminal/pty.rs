//! Per-PTY state. Holds the master handle, child, ring buffer, and reader thread.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use super::ring::RingBuffer;
use super::registry::{TerminalError, TerminalStatus};

const READER_BATCH_BYTES: usize = 4096;
const READER_FLUSH_INTERVAL: Duration = Duration::from_millis(10);

pub struct PtyHandle {
    pub id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub pid: u32,

    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    ring: Arc<Mutex<RingBuffer>>,
    status: Mutex<TerminalStatus>,
    exit_code: Mutex<Option<i32>>,
}

pub struct SpawnArgs {
    pub id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}

pub struct EmitContext {
    /// Called with `(event_name, payload_bytes)` for data events.
    pub emit_data: Arc<dyn Fn(&str, Vec<u8>) + Send + Sync>,
    /// Called once with `(event_name, code)` when the child exits or reader stops.
    pub emit_exit: Arc<dyn Fn(&str, Option<i32>) + Send + Sync>,
}

impl PtyHandle {
    pub fn spawn(args: SpawnArgs, emit: EmitContext) -> Result<Arc<Self>, TerminalError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: args.rows, cols: args.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&args.shell);
        if shell_takes_login_flag(&args.shell) {
            cmd.arg("-l");
        }
        cmd.cwd(&args.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TEAMCLAW_TERMINAL", "1");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let handle = Arc::new(Self {
            id: args.id.clone(),
            workspace_id: args.workspace_id,
            cwd: args.cwd,
            shell: args.shell,
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            ring: Arc::new(Mutex::new(RingBuffer::new())),
            status: Mutex::new(TerminalStatus::Running),
            exit_code: Mutex::new(None),
        });

        Self::start_reader_thread(handle.clone(), reader, emit);
        Ok(handle)
    }

    fn start_reader_thread(
        handle: Arc<Self>,
        mut reader: Box<dyn std::io::Read + Send>,
        emit: EmitContext,
    ) {
        let data_event = format!("terminal://{}/data", handle.id);
        let exit_event = format!("terminal://{}/exit", handle.id);
        let ring = handle.ring.clone();
        let weak = Arc::downgrade(&handle);

        std::thread::Builder::new()
            .name(format!("pty-reader-{}", &handle.id))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut tmp = [0u8; 4096];
                    let mut batch: Vec<u8> = Vec::with_capacity(READER_BATCH_BYTES);
                    let mut last_flush = Instant::now();

                    loop {
                        match reader.read(&mut tmp) {
                            Ok(0) => break,
                            Ok(n) => {
                                ring.lock().unwrap().write(&tmp[..n]);
                                batch.extend_from_slice(&tmp[..n]);
                                if batch.len() >= READER_BATCH_BYTES
                                    || last_flush.elapsed() >= READER_FLUSH_INTERVAL
                                {
                                    (emit.emit_data)(&data_event, std::mem::take(&mut batch));
                                    last_flush = Instant::now();
                                }
                            }
                            Err(_) => break,
                        }
                    }

                    if !batch.is_empty() {
                        (emit.emit_data)(&data_event, batch);
                    }
                }));

                let exit_code = if let Some(h) = weak.upgrade() {
                    let mut child = h.child.lock().unwrap();
                    match child.wait() {
                        Ok(status) => status.exit_code() as i32,
                        Err(_) => -1,
                    }
                } else {
                    -1
                };

                if let Some(h) = weak.upgrade() {
                    *h.status.lock().unwrap() = TerminalStatus::Exited;
                    *h.exit_code.lock().unwrap() = Some(exit_code);
                }

                let code = if result.is_err() { Some(-1) } else { Some(exit_code) };
                (emit.emit_exit)(&exit_event, code);
            })
            .expect("failed to spawn reader thread");
    }

    pub fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        if matches!(*self.status.lock().unwrap(), TerminalStatus::Exited) {
            return Err(TerminalError::PtyClosed);
        }
        let mut w = self.writer.lock().unwrap();
        w.write_all(data).map_err(|_| TerminalError::PtyClosed)?;
        w.flush().map_err(|_| TerminalError::PtyClosed)?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self.master.lock().unwrap();
        master
            .resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        Ok(())
    }

    pub fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.ring.lock().unwrap().snapshot()
    }

    pub fn status(&self) -> TerminalStatus { *self.status.lock().unwrap() }
    pub fn exit_code(&self) -> Option<i32> { *self.exit_code.lock().unwrap() }
}

fn shell_takes_login_flag(shell: &str) -> bool {
    let name = Path::new(shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    matches!(name, "zsh" | "bash" | "sh" | "fish")
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn make_emit() -> (EmitContext, mpsc::Receiver<(String, Vec<u8>)>, mpsc::Receiver<(String, Option<i32>)>) {
        let (data_tx, data_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let data_tx = Mutex::new(data_tx);
        let exit_tx = Mutex::new(exit_tx);
        let emit = EmitContext {
            emit_data: Arc::new(move |name, bytes| {
                let _ = data_tx.lock().unwrap().send((name.to_string(), bytes));
            }),
            emit_exit: Arc::new(move |name, code| {
                let _ = exit_tx.lock().unwrap().send((name.to_string(), code));
            }),
        };
        (emit, data_rx, exit_rx)
    }

    #[test]
    fn echo_produces_output_and_exit() {
        let tmp = std::env::temp_dir();
        let (emit, data_rx, exit_rx) = make_emit();
        let handle = PtyHandle::spawn(
            SpawnArgs {
                id: "test-1".into(),
                workspace_id: "ws".into(),
                cwd: tmp.clone(),
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn");

        handle.write(b"echo hello\nexit\n").expect("write");

        // Collect data events until exit fires.
        let exit_msg = exit_rx.recv_timeout(Duration::from_secs(5)).expect("exit event");
        assert!(exit_msg.0.starts_with("terminal://test-1/exit"));

        let mut buf = Vec::new();
        while let Ok((_, chunk)) = data_rx.try_recv() {
            buf.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("hello"), "expected 'hello' in output, got: {text}");
        assert!(matches!(handle.status(), TerminalStatus::Exited));
    }

    #[test]
    fn ring_buffer_replay_after_output() {
        let tmp = std::env::temp_dir();
        let (emit, _data_rx, exit_rx) = make_emit();
        let handle = PtyHandle::spawn(
            SpawnArgs {
                id: "test-2".into(),
                workspace_id: "ws".into(),
                cwd: tmp,
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn");

        handle.write(b"printf marker_xyz\nexit\n").expect("write");
        let _ = exit_rx.recv_timeout(Duration::from_secs(5));

        let snap = handle.snapshot();
        let text = String::from_utf8_lossy(&snap);
        assert!(text.contains("marker_xyz"), "snapshot missing marker: {text}");
    }
}
