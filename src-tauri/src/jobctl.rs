//! Pause and stop for long backend jobs. A command registers under the id its
//! Activity job has in the frontend (`register`); Activity's buttons reach it
//! through `job_pause` / `job_stop`. Between steps the command asks `go_on()`,
//! which waits while paused and says whether to carry on. A job that runs a
//! child process (ffmpeg, the engine) hands it to `watch_child`, which pauses,
//! resumes and kills that process with the job.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

#[derive(Default)]
pub struct Control {
    stop: AtomicBool,
    pause: AtomicBool,
}

impl Control {
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    pub fn paused(&self) -> bool {
        self.pause.load(Ordering::SeqCst)
    }
    /// Between two steps: waits while paused; false once stopped.
    pub fn go_on(&self) -> bool {
        while self.paused() && !self.stopped() {
            std::thread::sleep(Duration::from_millis(100));
        }
        !self.stopped()
    }
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<Control>>> {
    static J: OnceLock<Mutex<HashMap<String, Arc<Control>>>> = OnceLock::new();
    J.get_or_init(Default::default)
}

/// A job registered while this lives; dropped, the id goes.
pub struct Registered {
    id: String,
    pub ctl: Arc<Control>,
}

impl Drop for Registered {
    fn drop(&mut self) {
        let mut j = jobs().lock().unwrap_or_else(|p| p.into_inner());
        if j.get(&self.id).is_some_and(|c| Arc::ptr_eq(c, &self.ctl)) {
            j.remove(&self.id);
        }
    }
}

pub fn register(id: &str) -> Registered {
    let ctl = Arc::new(Control::default());
    jobs().lock().unwrap_or_else(|p| p.into_inner()).insert(id.to_string(), ctl.clone());
    Registered { id: id.to_string(), ctl }
}

/// Nothing to pause or stop (no id given): a control that is never paused or stopped.
pub fn none() -> Arc<Control> {
    Arc::new(Control::default())
}

pub fn pause(id: &str, on: bool) {
    if let Some(c) = jobs().lock().unwrap_or_else(|p| p.into_inner()).get(id) {
        c.pause.store(on, Ordering::SeqCst);
    }
}

pub fn stop(id: &str) {
    if let Some(c) = jobs().lock().unwrap_or_else(|p| p.into_inner()).get(id) {
        c.stop.store(true, Ordering::SeqCst);
    }
}

/// Follows a child process for as long as this lives: paused with the job (the process is
/// suspended where it is, and continues where it was), killed when the job is stopped.
pub struct ChildWatch {
    done: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ChildWatch {
    fn drop(&mut self) {
        self.done.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(unix)]
fn signal(pid: u32, sig: i32) {
    // SAFETY: kill(2) only sends a signal; the pid is a child this process started and still waits on.
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

pub fn watch_child(ctl: Arc<Control>, pid: u32) -> ChildWatch {
    // Without signals (Windows) the child isn't suspended or ended from here.
    #[cfg(not(unix))]
    let _ = (&ctl, pid);
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    let thread = std::thread::spawn(move || {
        #[cfg(unix)]
        let mut suspended = false;
        while !finished.load(Ordering::SeqCst) {
            #[cfg(unix)]
            {
                if ctl.stopped() {
                    if suspended {
                        signal(pid, libc::SIGCONT);
                    }
                    signal(pid, libc::SIGKILL);
                    return;
                }
                if ctl.paused() != suspended {
                    suspended = ctl.paused();
                    signal(pid, if suspended { libc::SIGSTOP } else { libc::SIGCONT });
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // Never leave it suspended behind us.
        #[cfg(unix)]
        if suspended {
            signal(pid, libc::SIGCONT);
        }
    });
    ChildWatch { done, thread: Some(thread) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn pauses_until_resumed_and_stops_by_id() {
        let r = register("t-1");
        pause("t-1", true);
        let ctl = r.ctl.clone();
        let t0 = Instant::now();
        let waiter = std::thread::spawn(move || ctl.go_on());
        std::thread::sleep(Duration::from_millis(300));
        assert!(!waiter.is_finished(), "waits while paused");
        pause("t-1", false);
        assert!(waiter.join().unwrap());
        assert!(t0.elapsed() >= Duration::from_millis(300));
        stop("t-1");
        assert!(!r.ctl.go_on());
        drop(r);
        stop("t-1"); // gone: nothing happens
        assert!(none().go_on());
    }

    #[cfg(unix)]
    #[test]
    fn suspends_resumes_and_kills_a_child() {
        let r = register("t-child");
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let w = watch_child(r.ctl.clone(), child.id());
        let state = |pid: u32| String::from_utf8(std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap().stdout).unwrap();
        pause("t-child", true);
        std::thread::sleep(Duration::from_millis(400));
        assert!(state(child.id()).starts_with('T'), "suspended: {}", state(child.id()));
        pause("t-child", false);
        std::thread::sleep(Duration::from_millis(400));
        assert!(!state(child.id()).starts_with('T'), "running again");
        stop("t-child");
        let t0 = Instant::now();
        let status = child.wait().unwrap();
        assert!(!status.success());
        assert!(t0.elapsed() < Duration::from_secs(5), "killed, not slept out");
        drop(w);
    }
}
