import XCTest
@testable import CanvasNoteApp

final class MarkdownEngineTests: XCTestCase {
    
    func testExtractBasicParagraphs() throws {
        let text = """
        This is paragraph one.
        
        This is paragraph two.
        """
        let blocks = MarkdownEngine.parseToBlocks(from: text)
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks[0].type, "Paragraph")
        XCTAssertEqual(blocks[0].rawContent, "This is paragraph one.")
        XCTAssertEqual(blocks[1].type, "Paragraph")
        XCTAssertEqual(blocks[1].rawContent, "This is paragraph two.")
    }
    
    func testExtractMixedContent() throws {
        let text = """
        # Heading 1
        
        A simple paragraph.
        
        ```swift
        print("Hello")
        ```
        
        * Item 1
        * Item 2
        """
        
        let blocks = MarkdownEngine.parseToBlocks(from: text)
        XCTAssertEqual(blocks.count, 4)
        XCTAssertEqual(blocks[0].type, "Heading-1")
        XCTAssertEqual(blocks[1].type, "Paragraph")
        XCTAssertEqual(blocks[2].type, "CodeBlock")
        XCTAssertEqual(blocks[3].type, "UnorderedList")
        
        // Ensure multiline works
        XCTAssertTrue(blocks[2].rawContent.contains("print(\"Hello\")"))
        XCTAssertTrue(blocks[3].rawContent.contains("Item 2"))
    }
    
    // Very important: test that the ID remains stable if we don't change the block
    func testBlockIdStability() throws {
        let originalText = """
        Block A
        
        Block B
        """
        let blocks1 = MarkdownEngine.parseToBlocks(from: originalText)
        let idB = blocks1[1].id
        
        let modifiedText = """
        Block A (modified)
        
        Block B
        """
        let blocks2 = MarkdownEngine.parseToBlocks(from: modifiedText)
        let idB_after = blocks2[1].id
        
        XCTAssertEqual(idB, idB_after, "The ID of an unmodified block should remain strictly stable even if siblings change.")
    }
}

final class BlockIdentityTests: XCTestCase {
    
    /// IDs must be the same in every process. Swift's `hashValue` is randomly seeded per launch,
    /// so this pins a literal value: it fails if anyone switches back to a per-launch hash.
    func testIdIsDeterministicAcrossLaunches() throws {
        let blocks = MarkdownEngine.parseToBlocks(from: "Hello world")
        XCTAssertEqual(blocks.first?.id, "block-f969949656d03648")
    }
    
    func testDuplicateContentGetsDistinctIds() throws {
        let blocks = MarkdownEngine.parseToBlocks(from: "Same\n\nSame\n\nSame")
        XCTAssertEqual(blocks.count, 3)
        XCTAssertEqual(Set(blocks.map { $0.id }).count, 3)
    }
    
    func testCRLFLineEndingsMatchLF() throws {
        let lf = "# Title\n\nPara one.\n\n```swift\nlet a = 1\n```\n\nPara two."
        let crlf = lf.replacingOccurrences(of: "\n", with: "\r\n")
        let a = MarkdownEngine.parseToBlocks(from: lf)
        let b = MarkdownEngine.parseToBlocks(from: crlf)
        XCTAssertEqual(a, b)
        XCTAssertEqual(b.count, 4)
        XCTAssertEqual(b[3].rawContent, "Para two.")
    }
    
    func testInsertAfterBlockOnlyTouchesThatBlock() throws {
        let text = "Same\n\nSame\n\nTail"
        let blocks = MarkdownEngine.parseToBlocks(from: text)
        let result = MarkdownEngine.text(text, insertingAfter: blocks[1], content: "> note")
        XCTAssertEqual(result, "Same\n\nSame\n\n> note\n\nTail")
        XCTAssertEqual(result.components(separatedBy: "> note").count - 1, 1)
        XCTAssertTrue(result.hasPrefix("Same\n\nSame\n\n> note"))
    }
}

final class PlacementReconcileTests: XCTestCase {
    
    private func block(_ id: String) -> MarkdownBlock {
        MarkdownBlock(id: id, rawContent: id, type: "Paragraph", startLine: 0, endLine: 0)
    }
    
    func testEmptyBlocksLeavePlacementsUntouched() {
        let p = [Placement(blockId: "a", groupIndex: 2, orderIndex: 0)]
        XCTAssertEqual(NoteBoard.reconcile(p, with: []), p)
    }
    
    func testEditedBlockInheritsOldPosition() {
        let p = [Placement(blockId: "a", groupIndex: 3, orderIndex: 1, preferredWidth: 500),
                 Placement(blockId: "b", groupIndex: 0, orderIndex: 0)]
        let result = NoteBoard.reconcile(p, with: [block("a2"), block("b")])
        XCTAssertEqual(result.count, 2)
        let a2 = result.first { $0.blockId == "a2" }
        XCTAssertEqual(a2?.groupIndex, 3)
        XCTAssertEqual(a2?.orderIndex, 1)
        XCTAssertEqual(a2?.preferredWidth, 500)
    }
    
    func testRemovedBlocksArePrunedAndNewOnesAppended() {
        let p = [Placement(blockId: "a", groupIndex: 0, orderIndex: 0),
                 Placement(blockId: "gone", groupIndex: 0, orderIndex: 1),
                 Placement(blockId: "gone2", groupIndex: 0, orderIndex: 2)]
        let result = NoteBoard.reconcile(p, with: [block("a"), block("new")])
        XCTAssertEqual(Set(result.map { $0.blockId }), ["a", "new"])
        XCTAssertEqual(result.first { $0.blockId == "new" }?.orderIndex, 1)
    }
}

final class FileWatcherTests: XCTestCase {
    
    /// The real-world failure: after one atomic save (temp file + rename) the watcher used to go deaf.
    func testWatcherSurvivesRepeatedAtomicSaves() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fw-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("n.md")
        try "v0".write(to: file, atomically: true, encoding: .utf8)
        
        var fired = 0
        let watcher = FileWatcher(url: file) { fired += 1 }
        watcher.start()
        defer { watcher.stop() }
        
        for i in 1...3 {
            let before = fired
            try "v\(i)".write(to: file, atomically: true, encoding: .utf8)
            let deadline = Date().addingTimeInterval(3)
            while fired == before && Date() < deadline {
                RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            }
            XCTAssertGreaterThan(fired, before, "No change notification after atomic save #\(i)")
            RunLoop.main.run(until: Date().addingTimeInterval(0.4)) // let re-arm settle
        }
    }
}

@MainActor
final class ActionTests: XCTestCase {
    
    private struct InstantLLM: LLMProvider {
        func generateSummary(for text: String) async throws -> String { "SUM" }
        func splitContent(text: String, intoParts parts: Int) async throws -> [String] { [text] }
    }
    private struct FailingLLM: LLMProvider {
        struct Boom: Error {}
        func generateSummary(for text: String) async throws -> String { throw Boom() }
        func splitContent(text: String, intoParts parts: Int) async throws -> [String] { throw Boom() }
    }
    
    private var noteName = ""
    override func setUp() {
        noteName = "test-\(UUID().uuidString).md"
    }
    override func tearDown() {
        try? FileManager.default.removeItem(at: WorkspaceManager.shared.notesDir.appendingPathComponent(noteName))
    }
    
    private func makeAction(_ provider: LLMProvider) throws -> SummarizeBlockAction {
        try WorkspaceManager.shared.writeNote(filename: noteName, content: "Alpha\n\nBeta")
        let blocks = MarkdownEngine.parseToBlocks(from: "Alpha\n\nBeta")
        return SummarizeBlockAction(noteFilename: noteName, blockId: blocks[0].id, provider: provider)
    }
    
    func testFailedActionWritesNothingAndIsNotUndoable() async throws {
        let executor = ActionExecutor()
        let ok = await executor.perform(try makeAction(FailingLLM()))
        XCTAssertFalse(ok)
        XCTAssertFalse(executor.canUndo(note: noteName))
        XCTAssertEqual(WorkspaceManager.shared.readNote(filename: noteName), "Alpha\n\nBeta")
        XCTAssertNotNil(executor.lastError)
    }
    
    func testUndoRestoresOriginal() async throws {
        let executor = ActionExecutor()
        let ok = await executor.perform(try makeAction(InstantLLM()))
        XCTAssertTrue(ok)
        XCTAssertEqual(WorkspaceManager.shared.readNote(filename: noteName), "Alpha\n\n> SUM\n\nBeta")
        await executor.undoLast(note: noteName)
        XCTAssertEqual(WorkspaceManager.shared.readNote(filename: noteName), "Alpha\n\nBeta")
    }
    
    func testUndoRefusesToOverwriteExternalEdits() async throws {
        let executor = ActionExecutor()
        _ = await executor.perform(try makeAction(InstantLLM()))
        try WorkspaceManager.shared.writeNote(filename: noteName, content: "Edited elsewhere")
        await executor.undoLast(note: noteName)
        XCTAssertEqual(WorkspaceManager.shared.readNote(filename: noteName), "Edited elsewhere")
        XCTAssertNotNil(executor.lastError)
    }
    
    func testUndoIsScopedToTheCurrentNote() async throws {
        let executor = ActionExecutor()
        _ = await executor.perform(try makeAction(InstantLLM()))
        XCTAssertTrue(executor.canUndo(note: noteName))
        XCTAssertFalse(executor.canUndo(note: "some-other-note.md"))
    }
}
