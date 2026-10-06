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
