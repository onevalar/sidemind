import Foundation

/// A lightweight wrapper around GCD to monitor file system changes.
class FileWatcher {
    private let url: URL
    private var source: DispatchSourceFileSystemObject?
    private var fileDescriptor: Int32 = -1
    private let callback: () -> Void
    
    init(url: URL, onChange callback: @escaping () -> Void) {
        self.url = url
        self.callback = callback
    }
    
    deinit {
        stop()
    }
    
    func start() {
        guard source == nil else { return }
        
        fileDescriptor = open(url.path, O_EVTONLY)
        guard fileDescriptor != -1 else {
            print("Failed to open file descriptor for monitoring: \(url.path)")
            return
        }
        
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fileDescriptor,
            eventMask: [.write, .delete, .rename, .extend],
            queue: DispatchQueue.global(qos: .default)
        )
        
        source.setEventHandler { [weak self] in
            // Debounce slightly to ensure external app finishes writing
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self?.callback()
            }
        }
        
        source.setCancelHandler { [weak self] in
            if let fd = self?.fileDescriptor, fd != -1 {
                close(fd)
            }
        }
        
        source.resume()
        self.source = source
    }
    
    func stop() {
        source?.cancel()
        source = nil
        fileDescriptor = -1
    }
}
