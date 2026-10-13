import SwiftUI

@main
struct SidemindAppApp: App {
    var body: some Scene {
        WindowGroup("Sidemind") {
            AppView()
                .frame(minWidth: 900, minHeight: 600)
        }
    }
}
