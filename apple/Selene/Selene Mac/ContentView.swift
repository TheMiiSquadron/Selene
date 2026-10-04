import SwiftUI

struct ContentView: View {
    @State private var messages: [LocalMessage] = []

    var body: some View {
        ZStack {
            SeleneHomeBackground()

            if messages.isEmpty {
                restingHome
                    .transition(.opacity.combined(with: .scale(scale: 0.985)))
            } else {
                conversationHome
                    .transition(.opacity)
            }
        }
        .frame(minWidth: 640, minHeight: 460)
        .animation(.easeInOut(duration: 0.32), value: messages.isEmpty)
    }

    private var restingHome: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 44)

            SelenePresence(compact: false)

            Spacer()
                .frame(height: 34)

            Text(greeting)
                .font(.system(size: 24, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.92))

            Spacer()
                .frame(height: 30)

            SeleneComposer(onSend: submit)

            Spacer(minLength: 46)
        }
        .padding(.horizontal, 52)
    }

    private var conversationHome: some View {
        VStack(spacing: 0) {
            SelenePresence(compact: true)
                .padding(.top, 28)
                .padding(.bottom, 22)

            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(messages) { message in
                        LocalMessageBubble(message: message)
                    }
                }
                .frame(maxWidth: 680)
                .padding(.horizontal, 34)
                .padding(.vertical, 8)
            }

            SeleneComposer(onSend: submit)
                .padding(.horizontal, 52)
                .padding(.top, 18)
                .padding(.bottom, 34)
        }
    }

    private func submit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        withAnimation(.easeInOut(duration: 0.28)) {
            messages.append(LocalMessage(text: trimmed, role: .user))
            messages.append(
                LocalMessage(
                    text: "This is a local Mac Home preview. Selene’s AI connection comes in a later milestone.",
                    role: .selene
                )
            )
        }
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
    let compact: Bool

    var body: some View {
        VStack(spacing: compact ? 6 : 10) {
            SelenePebble(
                state: .idle,
                size: compact ? 54 : 82
            )

            Text("Selene")
                .font(.system(size: compact ? 15 : 18, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.94))

            Text("Ready")
                .font(.system(size: compact ? 11 : 13, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.46))
        }
    }
}

private struct SeleneComposer: View {
    @State private var message = ""
    @FocusState private var isFocused: Bool

    let onSend: (String) -> Void

    var body: some View {
        HStack(spacing: 12) {
            TextField("Ask Selene…", text: $message)
                .textFieldStyle(.plain)
                .font(.system(size: 15, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.92))
                .focused($isFocused)
                .onSubmit(send)

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white.opacity(canSend ? 0.90 : 0.34))
                    .frame(width: 28, height: 28)
                    .background(
                        Circle()
                            .fill(.white.opacity(canSend ? 0.10 : 0.05))
                    )
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
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

    private var canSend: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let outgoing = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !outgoing.isEmpty else { return }

        onSend(outgoing)
        message = ""
        isFocused = true
    }
}

private struct LocalMessage: Identifiable {
    enum Role {
        case user
        case selene
    }

    let id = UUID()
    let text: String
    let role: Role
}

private struct LocalMessageBubble: View {
    let message: LocalMessage

    var body: some View {
        HStack {
            if message.role == .user {
                Spacer(minLength: 90)
            }

            Text(message.text)
                .font(.system(size: 14, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.90))
                .textSelection(.enabled)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(
                            message.role == .user
                                ? Color(red: 0.35, green: 0.30, blue: 0.70).opacity(0.34)
                                : .white.opacity(0.055)
                        )
                }

            if message.role == .selene {
                Spacer(minLength: 90)
            }
        }
    }
}

private struct SeleneHomeBackground: View {
    var body: some View {
        ZStack {
            Image("SeleneObsidian")
                .resizable()
                .scaledToFill()

            Color.black.opacity(0.28)
        }
        .ignoresSafeArea()
    }
}

#Preview {
    ContentView()
        .frame(width: 760, height: 540)
}
