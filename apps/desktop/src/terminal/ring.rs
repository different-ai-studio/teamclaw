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

    pub fn write(&mut self, data: &[u8]) {
        let cap = self.buf.len();
        if data.is_empty() || cap == 0 {
            return;
        }

        // If the chunk is at least one full capacity, keep only the tail.
        let (slice, start_head) = if data.len() >= cap {
            let tail = &data[data.len() - cap..];
            (tail, 0usize)
        } else {
            (data, self.head)
        };

        let n = slice.len();
        let first = (cap - start_head).min(n);
        self.buf[start_head..start_head + first].copy_from_slice(&slice[..first]);
        if first < n {
            self.buf[..n - first].copy_from_slice(&slice[first..]);
        }

        let new_head = (start_head + n) % cap;
        let wrapped = start_head + n >= cap;
        self.head = new_head;
        self.filled = self.filled || wrapped || (data.len() >= cap);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        if !self.filled {
            return self.buf[..self.head].to_vec();
        }
        let mut out = Vec::with_capacity(self.buf.len());
        out.extend_from_slice(&self.buf[self.head..]);
        out.extend_from_slice(&self.buf[..self.head]);
        out
    }
}

impl Default for RingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small_ring(cap: usize) -> RingBuffer {
        // Test helper: construct ring with custom capacity.
        RingBuffer {
            buf: vec![0u8; cap].into_boxed_slice(),
            head: 0,
            filled: false,
        }
    }

    #[test]
    fn empty_snapshot_is_empty() {
        let r = small_ring(8);
        assert!(r.snapshot().is_empty());
    }

    #[test]
    fn writes_under_capacity_are_preserved() {
        let mut r = small_ring(8);
        r.write(b"hello");
        assert_eq!(r.snapshot(), b"hello");
    }

    #[test]
    fn writes_exactly_at_capacity() {
        let mut r = small_ring(8);
        r.write(b"abcdefgh");
        assert_eq!(r.snapshot(), b"abcdefgh");
    }

    #[test]
    fn wrap_around_drops_oldest() {
        let mut r = small_ring(8);
        r.write(b"abcdefgh");
        r.write(b"ij");
        assert_eq!(r.snapshot(), b"cdefghij");
    }

    #[test]
    fn large_write_keeps_last_capacity_bytes() {
        let mut r = small_ring(4);
        r.write(b"abcdefghij");
        assert_eq!(r.snapshot(), b"ghij");
    }

    #[test]
    fn many_small_writes_after_full() {
        let mut r = small_ring(4);
        r.write(b"abcd");
        r.write(b"e");
        r.write(b"f");
        assert_eq!(r.snapshot(), b"cdef");
    }
}
