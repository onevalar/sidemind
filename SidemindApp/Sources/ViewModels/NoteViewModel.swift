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
        
        // Load synchronously so the canvas never renders a blank first frame
        // (an empty block list must not be mistaken for "the note was emptied").
        if let text = WorkspaceManager.shared.readNote(filename: filename) {
            self.content = text
            self.blocks = MarkdownEngine.parseToBlocks(from: text)
        }
        setupWatcher()
    }
    
    private func loadNote() {
        if let text = WorkspaceManager.shared.readNote(filename: filename) {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.content != text else { return }
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
