import SwiftUI

struct SeleneSettingsView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "gearshape")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(.secondary)

            Text("Settings")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.white)

            Text("Your preferences will appear here.")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
        }
        .frame(
            maxWidth: .infinity,
            maxHeight: .infinity
        )
    }
}
