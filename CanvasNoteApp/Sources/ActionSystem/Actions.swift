import Foundation

class SummarizeBlockAction: CanvasAction {
    let id = UUID()
    var name: String { "AI Summarize Block" }
    
    let noteFilename: String
    let targetBlockId: String
    let provider: LLMProvider
    
    // State backups
    private var originalContent: String?
    private var originalPlacements: [Placement]?
    
    init(noteFilename: String, blockId: String, provider: LLMProvider = MockLocalLLM()) {
        self.noteFilename = noteFilename
        self.targetBlockId = blockId
        self.provider = provider
    }
    
    func execute() throws {
        let wm = WorkspaceManager.shared
        guard let text = wm.readNote(filename: noteFilename) else {
            throw ActionExecutor.ActionError.transactionReverted
        }
        
        let board = NoteBoard(noteFilename: noteFilename)
        
        // Save backups
        originalContent = text
        originalPlacements = board.placements
        
        Task {
            // Find block content by re-parsing
            let blocks = MarkdownEngine.parseToBlocks(from: text)
            guard let block = blocks.first(where: { $0.id == targetBlockId }) else { return }
            
            do {
                let summary = try await provider.generateSummary(for: block.rawContent)
                
                // Pure string replacement for mockup purposes (In production, replace via AST source range)
                let newText = text.replacingOccurrences(of: block.rawContent, with: block.rawContent + "\n\n> \(summary)")
                
                // Atomically Save (UI auto refreshes due to FS Watcher)
                try wm.writeNote(filename: noteFilename, content: newText)
                
            } catch {
                try? self.undo()
            }
        }
    }
    
    func undo() throws {
        guard let content = originalContent, let placements = originalPlacements else { return }
        
        let wm = WorkspaceManager.shared
        try wm.writeNote(filename: noteFilename, content: content)
        
        let board = NoteBoard(noteFilename: noteFilename)
        board.placements = placements
        board.save()
    }
}
