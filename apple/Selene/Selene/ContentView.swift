import SwiftUI

struct ContentView: View {
    @Bindable var viewModel: ChatViewModel
    @FocusState private var isMessageFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let issue = viewModel.issue {
                        issueView(issue)
                    }

                    responseView
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }

            composer
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 12) {
            pebble

            VStack(alignment: .leading, spacing: 2) {
                Text(viewModel.assistantDisplayName)
                    .font(.headline)

                HStack(spacing: 6) {
                    if viewModel.isCheckingConnection {
                        ProgressView()
                            .controlSize(.mini)
                    }

                    Text(viewModel.statusText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            Button {
                Task {
                    await viewModel.checkConnection()
                }
            } label: {
                Label("Check Connection", systemImage: "network")
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.isBusy)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .background(.thinMaterial)
    }

    private var pebble: some View {
        Circle()
            .fill(viewModel.pebbleState.color)
            .overlay {
                Circle()
                    .stroke(.white.opacity(0.22), lineWidth: 1)
            }
            .frame(width: 22, height: 22)
            .accessibilityLabel("\(viewModel.assistantDisplayName) state: \(viewModel.statusText)")
    }

    private var responseView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(viewModel.assistantDisplayName)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)

            if let reply = viewModel.latestReply {
                Text(reply)
                    .font(.body)
                    .textSelection(.enabled)
            } else {
                Text("Ready when you are.")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 12) {
            TextField("Message \(viewModel.assistantDisplayName)", text: $viewModel.message, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .focused($isMessageFocused)
                .submitLabel(.send)
                .onSubmit(send)
                .disabled(viewModel.isBusy)

            Button(action: send) {
                Group {
                    if viewModel.isSending {
                        ProgressView()
                    } else {
                        Label("Send", systemImage: "paperplane.fill")
                    }
                }
                .frame(minWidth: 62, minHeight: 20)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!viewModel.canSend)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(.thinMaterial)
    }

    private func issueView(_ issue: ChatViewModel.Issue) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: issue.iconName)
                .foregroundStyle(issue.color)

            Text(issue.message)
                .font(.subheadline)
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(issue.color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func send() {
        guard viewModel.canSend else {
            return
        }

        Task {
            await viewModel.sendMessage()
        }
    }
}

private extension ChatViewModel.PebbleState {
    var color: Color {
        switch self {
        case .neutral:
            return .secondary
        case .working:
            return .blue
        case .connected:
            return .green
        case .attention:
            return .orange
        case .error:
            return .red
        }
    }
}

private extension ChatViewModel.Issue {
    var color: Color {
        switch self {
        case .attention:
            return .orange
        case .connection, .server:
            return .red
        }
    }

    var iconName: String {
        switch self {
        case .attention:
            return "exclamationmark.circle.fill"
        case .connection:
            return "wifi.exclamationmark"
        case .server:
            return "exclamationmark.triangle.fill"
        }
    }
}

#Preview {
    ContentView(
        viewModel: ChatViewModel(
            configuration: .development,
            api: PreviewCompanionAPI()
        )
    )
}

private actor PreviewCompanionAPI: CompanionAPIProviding {
    func fetchHealth() async throws -> CompanionHealthResponse {
        CompanionHealthResponse(ok: true, name: "Selene Core", machine: "Preview", version: "0")
    }

    func sendChat(message: String) async throws -> CompanionChatResponse {
        CompanionChatResponse(ok: true, reply: "Hello. I'm here.", state: "idle", events: [])
    }
}
