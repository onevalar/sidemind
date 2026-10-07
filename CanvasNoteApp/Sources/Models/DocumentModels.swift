import Foundation

/// A semantic block parsed from Markdown AST
struct MarkdownBlock: Identifiable, Equatable {
    /// Stable identifier derived from a SHA-256 of the block's type and content
    let id: String 
    
    /// The raw markdown content of this block
    let rawContent: String
    
    /// The type of the markdown block (e.g. Paragraph, Heading, CodeBlock)
    let type: String 
    
    /// Zero-based, inclusive line range of this block in the (newline-normalized) source file
    let startLine: Int
    let endLine: Int
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
    
    /// Brings saved placements in line with the blocks currently in the note:
    /// - placements for blocks that no longer exist are dropped (so board.json cannot grow forever),
    ///   unless the same number of brand-new blocks appeared, in which case the edited blocks
    ///   inherit the old spots, in reading order (an edit changes a block's ID, not where the user put it)
    /// - blocks without a placement get one at the end of the first column
    /// An empty block list is treated as "not loaded yet" and leaves placements untouched.
    static func reconcile(_ placements: [Placement], with blocks: [MarkdownBlock]) -> [Placement] {
        guard !blocks.isEmpty else { return placements }
        
        let blockIds = blocks.map { $0.id }
        let blockIdSet = Set(blockIds)
        
        var kept: [Placement] = []
        var keptIds = Set<String>()
        var orphans: [Placement] = []
        for p in placements {
            if blockIdSet.contains(p.blockId) {
                if keptIds.insert(p.blockId).inserted { kept.append(p) }
            } else {
                orphans.append(p)
            }
        }
        orphans.sort { ($0.groupIndex, $0.orderIndex) < ($1.groupIndex, $1.orderIndex) }
        
        let newIds = blockIds.filter { !keptIds.contains($0) }
        var result = kept
        
        if !newIds.isEmpty && newIds.count == orphans.count {
            for (id, old) in zip(newIds, orphans) {
                result.append(Placement(blockId: id, groupIndex: old.groupIndex, orderIndex: old.orderIndex, preferredWidth: old.preferredWidth))
            }
        } else {
            var nextOrder = (result.filter { $0.groupIndex == 0 }.map { $0.orderIndex }.max() ?? -1) + 1
            for id in newIds {
                result.append(Placement(blockId: id, groupIndex: 0, orderIndex: nextOrder))
                nextOrder += 1
            }
        }
        return result
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
