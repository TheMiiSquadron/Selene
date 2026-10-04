import AppKit
import SwiftUI

struct SeleneMenuBarView: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Selene")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))

                Text("Offline")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
            }

            Divider()

            Button("Open Selene") {
                openWindow(id: "selene-home")
                NSApp.activate(ignoringOtherApps: true)
            }

            Button("Quit Selene") {
                NSApp.terminate(nil)
            }
        }
        .padding(14)
        .frame(width: 220)
    }
}
