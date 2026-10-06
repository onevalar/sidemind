import SwiftUI

@main
struct CanvasNoteAppApp: App {
    var body: some Scene {
        WindowGroup("CanvasNote") {
            AppView()
                .frame(minWidth: 900, minHeight: 600)
        }
    }
}
