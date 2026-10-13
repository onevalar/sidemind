import SwiftUI

struct AppView: View {
    @State private var notes: [String] = []
    @State private var selectedNote: String?
    
    var body: some View {
        NavigationSplitView {
            List(notes, id: \.self, selection: $selectedNote) { filename in
                Text(filename)
            }
            .navigationTitle("Workspace")
            .onAppear(perform: loadWorkspace)
            
            Button("New Note") {
                createNewNote()
            }
            .padding()
            
        } detail: {
            if let note = selectedNote {
                WorkspaceEditorView(filename: note)
                    .id(note) // Force recreation when switching notes
            } else {
                Text("Select or create a note")
                    .foregroundColor(.secondary)
            }
        }
    }
    
    func loadWorkspace() {
        let fm = WorkspaceManager.shared.fm
        if let files = try? fm.contentsOfDirectory(atPath: WorkspaceManager.shared.notesDir.path) {
            notes = files.filter { $0.hasSuffix(".md") }
            if selectedNote == nil { selectedNote = notes.first }
        }
    }
    
    func createNewNote() {
        let wm = WorkspaceManager.shared
        var name: String
        repeat {
            name = "Note-\(UUID().uuidString.prefix(8)).md"
        } while wm.fm.fileExists(atPath: wm.notesDir.appendingPathComponent(name).path)
        try? wm.writeNote(filename: name, content: "# New Note\n\nStart writing!")
        loadWorkspace()
        selectedNote = name
    }
}

/// Binds the Workspace files to the Canvas Engine
struct WorkspaceEditorView: View {
    @StateObject private var viewModel: NoteViewModel
    @ObservedObject private var executor = ActionExecutor.shared
    
    init(filename: String) {
        _viewModel = StateObject(wrappedValue: NoteViewModel(filename: filename))
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // A simple toolbar
            HStack {
                Text("Canvas Mode (\(viewModel.filename))")
                    .font(.headline)
                
                Spacer()
                
                Button(action: {
                    if let firstBlockId = viewModel.blocks.first?.id {
                        let action = SummarizeBlockAction(noteFilename: viewModel.filename, blockId: firstBlockId)
                        Task { await executor.perform(action) }
                    }
                }) {
                    Label("AI Summarize", systemImage: "sparkles")
                }
                .buttonStyle(.borderedProminent)
                .disabled(executor.isRunning)
                
                Button("Undo AI") {
                    Task { await executor.undoLast(note: viewModel.filename) }
                }
                .disabled(executor.isRunning || !executor.canUndo(note: viewModel.filename))
                
                Spacer()
                
                // The watcher will automatically reload, but keeping a manual button just in case
                Text("Auto-saving & Hot-reloading enabled")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding()
            .background(Color(NSColor.windowBackgroundColor))
            
            // The massive NSView Canvas
            CanvasPlatformView(noteBoard: viewModel.board, blocks: $viewModel.blocks)
                .edgesIgnoringSafeArea(.all)
        }
        .alert("操作未完成", isPresented: Binding(
            get: { executor.lastError != nil },
            set: { if !$0 { executor.lastError = nil } }
        )) {
            Button("好") { executor.lastError = nil }
        } message: {
            Text(executor.lastError ?? "")
        }
    }
}
