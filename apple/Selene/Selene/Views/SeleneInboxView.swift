import SwiftUI

struct SeleneInboxView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "tray")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(.secondary)

            Text("Inbox")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.white)

            Text("Messages and notifications will appear here.")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
        }
        .frame(
            maxWidth: .infinity,
            maxHeight: .infinity
        )
    }
}
