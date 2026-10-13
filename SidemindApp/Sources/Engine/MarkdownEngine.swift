import Foundation
import CryptoKit
import Markdown

/// Wraps swift-markdown to extract Block-level elements.
class MarkdownEngine {
    
    /// Normalizes line endings so that line numbers reported by the parser
    /// always match the lines we slice out of the source (CRLF / CR safe).
    static func normalize(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }
    
    /// Parses raw markdown text into an array of semantic UI blocks.
    /// This ensures we extract top-level blocks like paragraphs, headings, codeblocks, and lists.
    static func parseToBlocks(from text: String) -> [MarkdownBlock] {
        let normalized = normalize(text)
        let document = Document(parsing: normalized)
        var extractor = BlockExtractor(sourceText: normalized)
        
        // Only walk the direct children so nested content never becomes a block.
        for child in document.children {
            extractor.extract(child)
        }
        
        return extractor.extractedBlocks
    }
    
    /// Inserts `insertion` as a new paragraph directly after the given block (by line range).
    static func text(_ text: String, insertingAfter block: MarkdownBlock, content insertion: String) -> String {
        var lines = normalize(text).components(separatedBy: "\n")
        let insertAt = min(block.endLine + 1, lines.count)
        lines.insert(contentsOf: ["", insertion], at: insertAt)
        return lines.joined(separator: "\n")
    }
}

/// Pulls out top-level blocks with stable, content-derived IDs.
private struct BlockExtractor {
    let lines: [String]
    var extractedBlocks: [MarkdownBlock] = []
    
    /// How many times each content hash has been seen, so identical blocks
    /// (e.g. two empty-ish paragraphs) still get distinct IDs.
    private var seen: [String: Int] = [:]
    
    init(sourceText: String) {
        self.lines = sourceText.components(separatedBy: "\n")
    }
    
    /// Deterministic ID: SHA-256 of type + content (NOT Swift's per-launch randomized hashValue),
    /// plus an occurrence counter for duplicates. Position is deliberately excluded so that
    /// editing a sibling never changes this block's ID.
    private mutating func makeId(type: String, content: String) -> String {
        let digest = SHA256.hash(data: Data((type + "\n" + content).utf8))
        let base = "block-" + digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        let count = (seen[base] ?? 0) + 1
        seen[base] = count
        return count == 1 ? base : "\(base)-\(count)"
    }
    
    private func text(for range: SourceRange) -> (content: String, start: Int, end: Int)? {
        guard !lines.isEmpty else { return nil }
        let start = max(0, range.lowerBound.line - 1)
        var end = min(lines.count - 1, range.upperBound.line - 1)
        // An exclusive end at column 1 means the block ended on the previous line.
        if range.upperBound.column == 1 && end > start { end -= 1 }
        guard start <= end else { return nil }
        return (lines[start...end].joined(separator: "\n"), start, end)
    }
    
    private func typeName(for markup: Markup) -> String? {
        switch markup {
        case is Paragraph: return "Paragraph"
        case let h as Heading: return "Heading-\(h.level)"
        case is CodeBlock: return "CodeBlock"
        case is BlockQuote: return "Quote"
        case is UnorderedList: return "UnorderedList"
        case is OrderedList: return "OrderedList"
        default: return nil
        }
    }
    
    mutating func extract(_ markup: Markup) {
        guard let type = typeName(for: markup),
              let range = markup.range,
              let (content, start, end) = text(for: range) else { return }
        
        extractedBlocks.append(MarkdownBlock(
            id: makeId(type: type, content: content),
            rawContent: content,
            type: type,
            startLine: start,
            endLine: end
        ))
    }
}
