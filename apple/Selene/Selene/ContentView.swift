import SwiftUI

struct ContentView: View {
    @State private var selectedState: SelenePebble.State = .idle

    private let states: [(String, SelenePebble.State)] = [
        ("Idle", .idle),
        ("Working", .working),
        ("Success", .success),
        ("Asking", .asking),
        ("Error", .error),
        ("Proactive", .proactive)
    ]

    var body: some View {
        ZStack {
            Color(red: 0.025, green: 0.025, blue: 0.035)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                VStack(spacing: 18) {
                    SelenePebble(
                        state: selectedState,
                        size: 76
                    )

                    VStack(spacing: 5) {
                        Text("Selene")
                            .font(.system(size: 24, weight: .semibold))
                            .foregroundStyle(.white)

                        Text(stateDescription)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                VStack(spacing: 14) {
                    Text("Pebble Lab")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .tracking(1.4)

                    LazyVGrid(
                        columns: [
                            GridItem(.flexible()),
                            GridItem(.flexible()),
                            GridItem(.flexible())
                        ],
                        spacing: 10
                    ) {
                        ForEach(states, id: \.0) { name, state in
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    selectedState = state
                                }
                            } label: {
                                Text(name)
                                    .font(.system(size: 13, weight: .medium))
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 42)
                                    .foregroundStyle(
                                        selectedState == state
                                            ? Color.white
                                            : Color.white.opacity(0.62)
                                    )
                                    .background {
                                        RoundedRectangle(cornerRadius: 13)
                                            .fill(
                                                selectedState == state
                                                    ? Color.white.opacity(0.13)
                                                    : Color.white.opacity(0.055)
                                            )
                                    }
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 13)
                                            .stroke(
                                                selectedState == state
                                                    ? Color.white.opacity(0.20)
                                                    : Color.white.opacity(0.07),
                                                lineWidth: 1
                                            )
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 34)
            }
        }
        .preferredColorScheme(.dark)
    }

    private var stateDescription: String {
        switch selectedState {
        case .idle:
            return "I'm here."

        case .working:
            return "I'm working."

        case .success:
            return "Done."

        case .asking:
            return "I need you."

        case .error:
            return "I couldn't proceed."

        case .proactive:
            return "I have something for you."
        }
    }
}

#Preview {
    ContentView()
}
