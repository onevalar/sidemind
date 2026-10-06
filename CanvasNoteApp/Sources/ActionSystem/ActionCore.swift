import Foundation

/// Defines a discreet, undoable Artificial Intelligence action in the Canvas Note App
protocol CanvasAction {
    var id: UUID { get }
    var name: String { get }
    
    /// Apply the change locally to the Workspace and Memory
    func execute() throws
    
    /// Revert the change locally
    func undo() throws
}

class ActionExecutor {
    static let shared = ActionExecutor()
    
    private var historyStack: [CanvasAction] = []
    
    enum ActionError: Error {
        case atomicWriteFailed
        case transactionReverted
    }
    
    /// Safely execute an AI operation and track it for global undo
    func perform(_ action: CanvasAction) {
        do {
            try action.execute()
            historyStack.append(action)
            print("Successfully performed: \(action.name)")
        } catch {
            print("Action Failed. Attempting Rollback: \(error.localizedDescription)")
            // Force an undo to clean up any partial state
            try? action.undo()
        }
    }
    
    func canUndo() -> Bool {
        return !historyStack.isEmpty
    }
    
    func undoLast() {
        guard let action = historyStack.popLast() else { return }
        do {
            try action.undo()
            // Optionally, tell the UI to force a refresh here,
            // but our FileWatcher handles it naturally via the FS!
            print("Successfully Undid: \(action.name)")
        } catch {
            print("Failed to Undo Action! System may be in an inconsistent state.")
        }
    }
}
