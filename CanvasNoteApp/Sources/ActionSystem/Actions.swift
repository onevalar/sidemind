import Foundation

/// Appends an AI summary right after a block, as its own quote block.
final class SummarizeBlockAction: CanvasAction {
    let id = UUID()
    var name: String { "AI Summarize Block" }
    
    let noteFilename: String
    let targetBlockId: String
    let provider: LLMProvider
    
    // Snapshots used to make undo safe
    private var contentBefore: String?
    private var contentAfter: String?
    
    init(noteFilename: String, blockId: String, provider: LLMProvider = MockLocalLLM()) {
        self.noteFilename = noteFilename
        self.targetBlockId = blockId
        self.provider = provider
    }
    
    func execute() async throws {
        let wm = WorkspaceManager.shared
        
        // 1. Read the block and ask the model. Nothing is written yet.
        guard let snapshot = wm.readNote(filename: noteFilename) else { throw ActionError.noteUnreadable }
        guard let block = MarkdownEngine.parseToBlocks(from: snapshot).first(where: { $0.id == targetBlockId }) else {
            throw ActionError.blockNotFound
        }
        let summary = try await provider.generateSummary(for: block.rawContent)
        
        // 2. The note may have been edited while the model was thinking: re-read and re-locate
        //    the block in the *current* text instead of writing back a stale copy.
        guard let current = wm.readNote(filename: noteFilename) else { throw ActionError.noteUnreadable }
        guard let freshBlock = MarkdownEngine.parseToBlocks(from: current).first(where: { $0.id == targetBlockId }) else {
            throw ActionError.blockNotFound
        }
        
        // 3. Insert exactly after that block (by line range), leaving every other block untouched.
        let newText = MarkdownEngine.text(current, insertingAfter: freshBlock, content: "> \(summary)")
        try wm.writeNote(filename: noteFilename, content: newText)
        
        contentBefore = current
        contentAfter = newText
    }
    
    func undo() async throws {
        guard let before = contentBefore, let after = contentAfter else { return }
        let wm = WorkspaceManager.shared
        
        // Only roll back if the file is still exactly what this action produced.
        guard wm.readNote(filename: noteFilename) == after else { throw ActionError.externalEditConflict }
        try wm.writeNote(filename: noteFilename, content: before)
    }
}
