import SwiftUI

struct ContentView: View {
    @Bindable var viewModel: ChatViewModel

    @FocusState private var isMessageFocused: Bool

    var body: some View {
        ZStack {
            background

            VStack(spacing: 0) {
                identity

                conversation

                composer
            }
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - Background

    private var background: some View {
        Color(
            red: 0.025,
            green: 0.025,
            blue: 0.035
        )
        .ignoresSafeArea()
    }

    // MARK: - Selene identity

    private var identity: some View {
        VStack(spacing: 14) {
            SelenePebble(
                state: pebbleState,
                size: 76
            )

            VStack(spacing: 4) {
                Text(viewModel.assistantDisplayName)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.white)

                Text(statusText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, 30)
        .padding(.bottom, 24)
    }

    // MARK: - Conversation

    private var conversation: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let issue = viewModel.issue {
                    issueView(issue)
                }

                if let reply = viewModel.latestReply {
                    assistantMessage(reply)
                } else {
                    emptyConversation
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyConversation: some View {
        Text("Ready when you are.")
            .font(.system(size: 16))
            .foregroundStyle(.secondary)
            .frame(
                maxWidth: .infinity,
                alignment: .center
            )
            .padding(.top, 26)
    }

    private func assistantMessage(_ message: String) -> some View {
        Text(message)
            .font(.system(size: 16))
            .foregroundStyle(.white.opacity(0.92))
            .textSelection(.enabled)
            .frame(
                maxWidth: .infinity,
                alignment: .leading
            )
    }

    // MARK: - Composer

    private var composer: some View {
        HStack(spacing: 10) {
            Button {
                // Reserved for future attachments/actions.
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.white.opacity(0.72))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)

            TextField(
                "Message \(viewModel.assistantDisplayName)…",
                text: $viewModel.message,
                axis: .vertical
            )
            .font(.system(size: 16))
            .foregroundStyle(.white)
            .tint(Color(hex: 0x8B7CFF))
            .lineLimit(1...5)
            .focused($isMessageFocused)
            .submitLabel(.send)
            .onSubmit(send)
            .disabled(viewModel.isBusy)

            Button(action: send) {
                ZStack {
                    Circle()
                        .fill(
                            viewModel.canSend
                                ? Color.white
                                : Color.white.opacity(0.12)
                        )

                    if viewModel.isSending {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.black)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(
                                viewModel.canSend
                                    ? Color.black
                                    : Color.white.opacity(0.32)
                            )
                    }
                }
                .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .disabled(!viewModel.canSend)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background {
            RoundedRectangle(
                cornerRadius: 22,
                style: .continuous
            )
            .fill(Color.white.opacity(0.07))
        }
        .overlay {
            RoundedRectangle(
                cornerRadius: 22,
                style: .continuous
            )
            .stroke(
                Color.white.opacity(0.10),
                lineWidth: 1
            )
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    // MARK: - Issues

    private func issueView(_ issue: ChatViewModel.Issue) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: issueIconName(issue))
                .foregroundStyle(.red)

            Text(issue.message)
                .font(.system(size: 14))
                .foregroundStyle(.white.opacity(0.86))
        }
        .frame(
            maxWidth: .infinity,
            alignment: .leading
        )
        .padding(14)
        .background {
            RoundedRectangle(
                cornerRadius: 14,
                style: .continuous
            )
            .fill(Color.red.opacity(0.10))
        }
    }

    // MARK: - Pebble state

    private var pebbleState: SelenePebble.State {
        if viewModel.issue != nil {
            return .error
        }

        if viewModel.isBusy {
            return .working
        }

        if viewModel.latestReply != nil {
            return .success
        }

        return .idle
    }

    private var statusText: String {
        switch pebbleState {
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

    // MARK: - Actions

    private func send() {
        guard viewModel.canSend else {
            return
        }

        Task {
            await viewModel.sendMessage()
        }
    }

    private func issueIconName(
        _ issue: ChatViewModel.Issue
    ) -> String {
        switch issue {
        case .attention:
            return "exclamationmark.circle.fill"

        case .connection:
            return "wifi.exclamationmark"

        case .server:
            return "exclamationmark.triangle.fill"
        }
    }
}

// MARK: - Color helper

private extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}