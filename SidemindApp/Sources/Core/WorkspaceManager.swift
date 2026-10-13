import Foundation

/// Workspace operations for the localized-first Markdown Note application
class WorkspaceManager {
    static let shared = WorkspaceManager()
    
    let fm = FileManager.default
    
    var rootDir: URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SidemindWorkspace")
    }
    
    var notesDir: URL {
        rootDir.appendingPathComponent("Notes")
    }
    
    var canvasDataDir: URL {
        rootDir.appendingPathComponent(".sidemind")
    }
    
    init() {
        adoptCanvasNoteWorkspace()
        setupDirectoryStructure()
    }

    /// Moves a workspace left by the app's former name (Canvas Note) to its new place once, never overwriting anything.
    private func adoptCanvasNoteWorkspace() {
        let documents = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let old = documents.appendingPathComponent("CanvasNoteWorkspace")
        if fm.fileExists(atPath: old.path) && !fm.fileExists(atPath: rootDir.path) {
            try? fm.moveItem(at: old, to: rootDir)
            let oldData = rootDir.appendingPathComponent(".canvasnote")
            if fm.fileExists(atPath: oldData.path) && !fm.fileExists(atPath: canvasDataDir.path) {
                try? fm.moveItem(at: oldData, to: canvasDataDir)
            }
        }
    }
    
    private func setupDirectoryStructure() {
        try? fm.createDirectory(at: notesDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: canvasDataDir, withIntermediateDirectories: true)
        
        let demoFile = notesDir.appendingPathComponent("Welcome.md")
        if !fm.fileExists(atPath: demoFile.path) {
            let demoText = """
            # Welcome to Sidemind
            
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
