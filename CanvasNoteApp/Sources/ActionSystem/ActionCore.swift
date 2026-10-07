import Foundation

/// Defines a discrete, undoable Artificial Intelligence action in the Canvas Note App
protocol CanvasAction {
    var id: UUID { get }
    var name: String { get }
    
    /// The note this action changes. Undo history is tracked per note.
    var noteFilename: String { get }
    
    /// Apply the change. Must be all-or-nothing: if this throws, nothing may have been written.
    func execute() async throws
    
    /// Revert the change. Must refuse (throw) rather than overwrite edits made after `execute`.
    func undo() async throws
}

enum ActionError: LocalizedError {
    case noteUnreadable
    case blockNotFound
    case externalEditConflict
    
    var errorDescription: String? {
        switch self {
        case .noteUnreadable: return "无法读取这篇笔记。"
        case .blockNotFound: return "目标内容块已经不存在（笔记在此期间被修改）。"
        case .externalEditConflict: return "这篇笔记在 AI 操作之后又被修改过，为避免覆盖你的改动，已取消撤销。"
        }
    }
}

@MainActor
final class ActionExecutor: ObservableObject {
    static let shared = ActionExecutor()
    
    @Published private(set) var historyStack: [CanvasAction] = []
    @Published private(set) var isRunning = false
    @Published var lastError: String?
    
    /// Run an AI operation. It enters the undo history only after it has fully succeeded.
    @discardableResult
    func perform(_ action: CanvasAction) async -> Bool {
        guard !isRunning else { return false }
        isRunning = true
        defer { isRunning = false }
        
        do {
            try await action.execute()
            historyStack.append(action)
            return true
        } catch {
            // execute() is all-or-nothing, so there is no partial state to clean up.
            lastError = error.localizedDescription
            return false
        }
    }
    
    func canUndo(note filename: String) -> Bool {
        historyStack.contains { $0.noteFilename == filename }
    }
    
    /// Undo the most recent action of the given note only.
    func undoLast(note filename: String) async {
        guard !isRunning,
              let index = historyStack.lastIndex(where: { $0.noteFilename == filename }) else { return }
        isRunning = true
        defer { isRunning = false }
        
        let action = historyStack[index]
        do {
            try await action.undo()
            historyStack.remove(at: index)
        } catch {
            // Keep it in history only if retrying could still make sense; a conflict never will.
            if case ActionError.externalEditConflict = error {
                historyStack.remove(at: index)
            }
            lastError = error.localizedDescription
        }
    }
}
