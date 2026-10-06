import Foundation

/// Workspace operations for the localized-first Markdown Note application
class WorkspaceManager {
    static let shared = WorkspaceManager()
    
    let fm = FileManager.default
    
    var rootDir: URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CanvasNoteWorkspace")
    }
    
    var notesDir: URL {
        rootDir.appendingPathComponent("Notes")
    }
    
    var canvasDataDir: URL {
        rootDir.appendingPathComponent(".canvasnote")
    }
    
    init() {
        setupDirectoryStructure()
    }
    
    private func setupDirectoryStructure() {
        try? fm.createDirectory(at: notesDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: canvasDataDir, withIntermediateDirectories: true)
        
        let demoFile = notesDir.appendingPathComponent("Welcome.md")
        if !fm.fileExists(atPath: demoFile.path) {
            let demoText = """
            # Welcome to the *Real* CanvasNote
            
            This application uses `swift-markdown` to parse the Abstract Syntax Tree (AST).
            
            You can write code blocks safely:
            ```swift
            print("Hello World")
            ```
            
            Every paragraph, list, or codeblock is an independent `Block`.
            When you drag a block on the canvas, its positional metadata is saved separately from the Markdown text.
            """.data(using: .utf8)
            try? demoText?.write(to: demoFile)
        }
    }
    
    /// Reads markdown content from disk
    func readNote(filename: String) -> String? {
        let url = notesDir.appendingPathComponent(filename)
        return try? String(contentsOf: url, encoding: .utf8)
    }
    
    /// Writes markdown content to disk (atomic write)
    func writeNote(filename: String, content: String) throws {
        let url = notesDir.appendingPathComponent(filename)
        try content.write(to: url, atomically: true, encoding: .utf8)
    }
}
