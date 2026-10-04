import SwiftUI

struct ContentView: View {
    var body: some View {
        ZStack {
            SeleneHomeBackground()

            VStack(spacing: 0) {
                Spacer(minLength: 44)

                SelenePresence()

                Spacer()
                    .frame(height: 34)

                Text(greeting)
                    .font(.system(size: 24, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.92))

                Spacer()
                    .frame(height: 30)

                SeleneComposer()

                Spacer(minLength: 46)
            }
            .padding(.horizontal, 52)
        }
        .frame(minWidth: 640, minHeight: 460)
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())

        switch hour {
        case 5..<12:
            return "Good morning, Alex."
        case 12..<17:
            return "Good afternoon, Alex."
        default:
            return "Good evening, Alex."
        }
    }
}

private struct SelenePresence: View {
    var body: some View {
        VStack(spacing: 10) {
            SelenePebble(
                state: .idle,
                size: 82
            )

            Text("Selene")
                .font(.system(size: 18, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.94))

            Text("Ready")
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.46))
        }
    }
}

private struct SeleneComposer: View {
    @State private var message = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 12) {
            TextField("Ask Selene…", text: $message)
                .textFieldStyle(.plain)
                .font(.system(size: 15, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.92))
                .focused($isFocused)
                .onSubmit {
                    // Interaction is intentionally deferred to a later milestone.
                }

            Button {
                // Interaction is intentionally deferred to a later milestone.
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white.opacity(message.isEmpty ? 0.34 : 0.90))
                    .frame(width: 28, height: 28)
                    .background(
                        Circle()
                            .fill(.white.opacity(message.isEmpty ? 0.05 : 0.10))
                    )
            }
            .buttonStyle(.plain)
            .disabled(message.isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.leading, 18)
        .padding(.trailing, 10)
        .padding(.vertical, 9)
        .frame(maxWidth: 520)
        .background {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(.white.opacity(0.055))
                .background(
                    .ultraThinMaterial,
                    in: RoundedRectangle(cornerRadius: 22, style: .continuous)
                )
        }
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(
                    isFocused
                        ? Color(red: 0.55, green: 0.49, blue: 1.0).opacity(0.72)
                        : .white.opacity(0.10),
                    lineWidth: 1
                )
        }
        .shadow(
            color: isFocused
                ? Color(red: 0.42, green: 0.34, blue: 1.0).opacity(0.22)
                : .clear,
            radius: 18
        )
        .animation(.easeOut(duration: 0.18), value: isFocused)
    }
}

private struct SeleneHomeBackground: View {
    var body: some View {
        ZStack {
            Color(red: 0.025, green: 0.027, blue: 0.045)

            RadialGradient(
                colors: [
                    Color(red: 0.23, green: 0.18, blue: 0.52).opacity(0.24),
                    .clear
                ],
                center: UnitPoint(x: 0.50, y: 0.28),
                startRadius: 0,
                endRadius: 330
            )

            RadialGradient(
                colors: [
                    Color(red: 0.12, green: 0.28, blue: 0.48).opacity(0.10),
                    .clear
                ],
                center: UnitPoint(x: 0.82, y: 0.78),
                startRadius: 0,
                endRadius: 300
            )
        }
        .ignoresSafeArea()
    }
}

#Preview {
    ContentView()
        .frame(width: 760, height: 540)
}
