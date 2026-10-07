import Foundation

/// A lightweight wrapper around GCD to monitor file system changes.
///
/// Most editors (and our own `writeNote(atomically: true)`) save by writing a temp file and
/// renaming it over the original. That replaces the inode we were watching, so after a
/// delete/rename event the watcher re-opens the path and keeps going.
final class FileWatcher {
    private let url: URL
    private var source: DispatchSourceFileSystemObject?
    private let callback: () -> Void
    private var stopped = true
    
    /// How many times to retry opening a path that is briefly missing during a replace.
    private static let maxReopenAttempts = 10
    
    init(url: URL, onChange callback: @escaping () -> Void) {
        self.url = url
        self.callback = callback
    }
    
    deinit {
        stop()
    }
    
    func start() {
        guard source == nil else { return }
        stopped = false
        arm(attemptsLeft: Self.maxReopenAttempts)
    }
    
    func stop() {
        stopped = true
        source?.cancel()
        source = nil
    }
    
    private func arm(attemptsLeft: Int) {
        guard !stopped, source == nil else { return }
        
        let fd = open(url.path, O_EVTONLY)
        guard fd != -1 else {
            // The file may be mid-replace; try again shortly.
            guard attemptsLeft > 0 else {
                print("Failed to open file descriptor for monitoring: \(url.path)")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.arm(attemptsLeft: attemptsLeft - 1)
            }
            return
        }
        
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename, .extend],
            queue: DispatchQueue.global(qos: .default)
        )
        
        source.setEventHandler { [weak self, weak source] in
            let replaced = source?.data.contains(.delete) == true || source?.data.contains(.rename) == true
            // Debounce slightly to ensure external app finishes writing
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                guard let self, !self.stopped else { return }
                if replaced {
                    // The inode we were watching is gone: drop it and watch the new file at this path.
                    self.source?.cancel()
                    self.source = nil
                    self.arm(attemptsLeft: Self.maxReopenAttempts)
                }
                self.callback()
            }
        }
        
        // The fd is owned by this source alone; closing it here is safe because
        // the handler captures the local value, not mutable shared state.
        source.setCancelHandler {
            close(fd)
        }
        
        source.resume()
        self.source = source
    }
}
