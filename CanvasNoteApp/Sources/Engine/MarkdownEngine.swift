import Foundation
import Markdown

/// Wraps swift-markdown to extract Block-level elements.
class MarkdownEngine {
    
    /// Parses raw markdown text into an array of semantic UI blocks.
    /// This ensures we extract top-level blocks like paragraphs, headings, codeblocks, and lists.
    static func parseToBlocks(from text: String) -> [MarkdownBlock] {
        let document = Document(parsing: text)
        var blocks: [MarkdownBlock] = []
        var extractor = BlockExtractor(sourceText: text)
        
        // Walk the AST
        extractor.visit(document)
        blocks = extractor.extractedBlocks
        
        return blocks
    }
}

/// A custom MarkupWalker that pulls out top-level blocks.
private struct BlockExtractor: MarkupWalker {
    let sourceText: String
    var extractedBlocks: [MarkdownBlock] = []
    
    // Generate a naive but "stable" ID.
    // In production, calculating a cryptographic hash of content + index is better
    private func generateId(for markup: Markup, text: String) -> String {
        let digest = text.hashValue
        return "block-\(digest)"
    }
    
    // Helper to slice original string based on SourceRange
    private func textFor(range: SourceRange?) -> String {
        guard let range = range else { return "" }
        let lines = sourceText.components(separatedBy: .newlines)
        
        // This is a naive extraction purely for the Demo (real implementation requires precise utf8 offset translation)
        // swift-markdown provides line/column which is 1-based
        let startLine = max(0, range.lowerBound.line - 1)
        let endLine = min(lines.count - 1, range.upperBound.line - 1)
        
        if startLine == endLine {
            return lines[startLine]
        } else {
            return lines[startLine...endLine].joined(separator: "\n")
        }
    }
    
    // We only want top level blocks, so we don't recurse into them.
    
    mutating func visitParagraph(_ paragraph: Paragraph) {
        let content = textFor(range: paragraph.range)
        let block = MarkdownBlock(
            id: generateId(for: paragraph, text: content),
            rawContent: content,
            type: "Paragraph",
            sourceRange: nil // Skipped full NSRange mapping for demo simplicity
        )
        extractedBlocks.append(block)
        // Do not call descendentVisit so we don't extract individual text/link nodes
    }
    
    mutating func visitHeading(_ heading: Heading) {
        let content = textFor(range: heading.range)
        let block = MarkdownBlock(
            id: generateId(for: heading, text: content),
            rawContent: content,
            type: "Heading-\(heading.level)",
            sourceRange: nil
        )
        extractedBlocks.append(block)
    }
    
    mutating func visitCodeBlock(_ codeBlock: CodeBlock) {
        let content = textFor(range: codeBlock.range)
        let block = MarkdownBlock(
            id: generateId(for: codeBlock, text: content),
            rawContent: content,
            type: "CodeBlock",
            sourceRange: nil
        )
        extractedBlocks.append(block)
    }
    
    mutating func visitBlockQuote(_ blockQuote: BlockQuote) {
        let content = textFor(range: blockQuote.range)
        let block = MarkdownBlock(
            id: generateId(for: blockQuote, text: content),
            rawContent: content,
            type: "Quote",
            sourceRange: nil
        )
        extractedBlocks.append(block)
    }
    
    mutating func visitUnorderedList(_ list: UnorderedList) {
        let content = textFor(range: list.range)
        let block = MarkdownBlock(
            id: generateId(for: list, text: content),
            rawContent: content,
            type: "UnorderedList",
            sourceRange: nil
        )
        extractedBlocks.append(block)
    }
    
    mutating func visitOrderedList(_ list: OrderedList) {
        let content = textFor(range: list.range)
        let block = MarkdownBlock(
            id: generateId(for: list, text: content),
            rawContent: content,
            type: "OrderedList",
            sourceRange: nil
        )
        extractedBlocks.append(block)
    }
}
