import Foundation
import Combine

class NoteViewModel: ObservableObject {
    let filename: String
    let fileURL: URL
    
    @Published var content: String = ""
    @Published var blocks: [MarkdownBlock] = []
    
    let board: NoteBoard
    
    private var watcher: FileWatcher?
    
    init(filename: String) {
        self.filename = filename
        self.fileURL = WorkspaceManager.shared.notesDir.appendingPathComponent(filename)
        self.board = NoteBoard(noteFilename: filename)
        
        loadNote()
        setupWatcher()
    }
    
    private func loadNote() {
        if let text = WorkspaceManager.shared.readNote(filename: filename) {
            DispatchQueue.main.async {
                self.content = text
                self.blocks = MarkdownEngine.parseToBlocks(from: text)
            }
        }
    }
    
    private func setupWatcher() {
        watcher = FileWatcher(url: fileURL) { [weak self] in
            // When external app saves the file, this triggers
            self?.loadNote()
        }
        watcher?.start()
    }
    
    deinit {
        watcher?.stop()
    }
}
