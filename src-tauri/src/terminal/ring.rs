//! Fixed-capacity ring buffer for PTY output replay.

pub const RING_CAPACITY: usize = 8 * 1024 * 1024; // 8 MiB

pub struct RingBuffer {
    buf: Box<[u8]>,
    head: usize,
    filled: bool,
}

impl RingBuffer {
    pub fn new() -> Self {
        Self {
            buf: vec![0u8; RING_CAPACITY].into_boxed_slice(),
            head: 0,
            filled: false,
        }
    }

    pub fn write(&mut self, _data: &[u8]) {
        unimplemented!()
    }

    pub fn snapshot(&self) -> Vec<u8> {
        unimplemented!()
    }
}

impl Default for RingBuffer {
    fn default() -> Self { Self::new() }
}
