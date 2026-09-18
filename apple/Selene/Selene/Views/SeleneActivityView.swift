import SwiftUI

struct SeleneActivityView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "clock")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(.secondary)

            Text("Activity")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.white)

            Text("Your activity will appear here.")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
        }
        .frame(
            maxWidth: .infinity,
            maxHeight: .infinity
        )
    }
}
