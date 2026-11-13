//! Process-wide coordination for cooperating native writes and snapshot callers.
//! A barrier fails rather than waiting: callers can retry without blocking Tauri's
//! command threads. Leases never expire while a snapshot may still be running.
use std::sync::{Arc, Mutex};
use tauri::{State, WebviewWindow};

#[derive(Default)]
struct Inner {
    writers: usize,
    barrier: Option<(String, u64)>,
    next: u64,
}

#[derive(Default, Clone)]
pub struct WriteGate(Arc<Mutex<Inner>>);

pub struct WritePermit(WriteGate);
impl Drop for WritePermit {
    fn drop(&mut self) {
        let mut inner = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.writers -= 1;
    }
}

impl WriteGate {
    pub fn write(&self) -> Result<WritePermit, String> {
        let mut inner = self.0.lock().map_err(|_| "E_GATE_POISONED")?;
        if inner.barrier.is_some() { return Err("E_WRITE_PAUSED".into()); }
        inner.writers += 1;
        Ok(WritePermit(self.clone()))
    }

    pub(crate) fn acquire(&self, owner: &str) -> Result<u64, String> {
        let mut inner = self.0.lock().map_err(|_| "E_GATE_POISONED")?;
        if inner.writers != 0 || inner.barrier.is_some() { return Err("E_GATE_BUSY".into()); }
        inner.next = inner.next.checked_add(1).ok_or("E_GATE_EXHAUSTED")?;
        let token = inner.next;
        inner.barrier = Some((owner.to_owned(), token));
        Ok(token)
    }

    pub fn release_owner(&self, owner: &str) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.barrier.as_ref().is_some_and(|(o, _)| o == owner) {
            inner.barrier = None;
        }
    }

    pub(crate) fn release(&self, owner: &str, token: u64) -> Result<(), String> {
        let mut inner = self.0.lock().map_err(|_| "E_GATE_POISONED")?;
        if inner.barrier.as_ref().map(|(o, t)| (o.as_str(), *t)) != Some((owner, token)) {
            return Err("E_GATE_LEASE".into());
        }
        inner.barrier = None;
        Ok(())
    }
}

#[tauri::command]
pub fn write_gate_acquire(window: WebviewWindow, gate: State<'_, WriteGate>) -> Result<u64, String> {
    gate.acquire(window.label())
}

#[tauri::command]
pub fn write_gate_release(window: WebviewWindow, gate: State<'_, WriteGate>, token: u64) -> Result<(), String> {
    gate.release(window.label(), token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destroyed_owner_releases_only_its_lease() {
        let gate = WriteGate::default();
        let old = gate.acquire("owner").unwrap();
        gate.release_owner("other");
        assert_eq!(gate.write().err().unwrap(), "E_WRITE_PAUSED");
        gate.release_owner("owner");
        let new = gate.acquire("owner").unwrap();
        assert_eq!(gate.release("owner", old).unwrap_err(), "E_GATE_LEASE");
        gate.release("owner", new).unwrap();
        assert!(gate.write().is_ok());
    }

    #[test]
    fn shared_gate_drains_and_checks_lease_owner() {
        let a = WriteGate::default();
        let b = a.clone();
        let permit = a.write().unwrap();
        assert_eq!(b.acquire("backup").unwrap_err(), "E_GATE_BUSY");
        drop(permit);
        let token = b.acquire("backup").unwrap();
        assert!(a.write().is_err());
        assert_eq!(a.release("other", token).unwrap_err(), "E_GATE_LEASE");
        assert_eq!(a.acquire("other").unwrap_err(), "E_GATE_BUSY");
        b.release("backup", token).unwrap();
        assert!(a.write().is_ok());
        assert!(b.release("backup", token).is_err());
    }
}
