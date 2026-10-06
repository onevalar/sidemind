import Foundation

/// A semantic block parsed from Markdown AST
struct MarkdownBlock: Identifiable, Equatable {
    /// Stable identifier derived from AST path and content hash
    let id: String 
    
    /// The raw markdown content of this block
    let rawContent: String
    
    /// The type of the markdown block (e.g. Paragraph, Heading, CodeBlock)
    let type: String 
    
    /// The original source range in the markdown file
    let sourceRange: NSRange?
}

/// A placement metadata object representing the block on the canvas
struct Placement: Identifiable, Codable, Equatable {
    var id: String { blockId }
    let blockId: String
    
    // Instead of absolute coordinates, we use a flexible width and order 
    // to simulate a flowing canvas inside a horizontal/vertical stack
    var groupIndex: Int // Which "column" or "container" this is in
    var orderIndex: Int // The order within the group
    
    var preferredWidth: Double
    
    init(blockId: String, groupIndex: Int = 0, orderIndex: Int = 0, preferredWidth: Double = 320.0) {
        self.blockId = blockId
        self.groupIndex = groupIndex
        self.orderIndex = orderIndex
        self.preferredWidth = preferredWidth
    }
}

/// Represents the meta-state of a single note's canvas
class NoteBoard: ObservableObject {
    @Published var placements: [Placement] = []
    
    let boardFileURL: URL
    
    init(noteFilename: String) {
        self.boardFileURL = WorkspaceManager.shared.canvasDataDir
            .appendingPathComponent(noteFilename + ".board.json")
        load()
    }
    
    func load() {
        if let data = try? Data(contentsOf: boardFileURL),
           let saved = try? JSONDecoder().decode([Placement].self, from: data) {
            self.placements = saved
        }
    }
    
    func save() {
        // Simple File-Based save (Last Wrtie Wins)
        if let data = try? JSONEncoder().encode(placements) {
            try? data.write(to: boardFileURL, options: .atomic)
        }
    }
}
