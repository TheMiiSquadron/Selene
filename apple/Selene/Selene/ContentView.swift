import SwiftUI

struct ContentView: View {
    @Bindable var viewModel: ChatViewModel

    @FocusState private var isMessageFocused: Bool
    @State private var showSuccess = false
    @State private var isNavigationPresented = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            background

            VStack(spacing: 0) {
                identity
                conversation
                composer
            }

            if isNavigationPresented {
                navigationDismissLayer
                    .transition(.opacity)
            }

            navigationControls
        }
        .preferredColorScheme(.dark)
        .onChange(of: viewModel.isSending) { wasSending, isSending in
            guard wasSending && !isSending else {
                return
            }

            guard viewModel.issue == nil else {
                return
            }

            showSuccess = true

            Task {
                try? await Task.sleep(for: .seconds(1.2))

                withAnimation(.easeInOut(duration: 0.25)) {
                    showSuccess = false
                }
            }
        }
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

    // MARK: - Navigation

    private var navigationDismissLayer: some View {
        Color.black
            .opacity(0.18)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture {
                closeNavigation()
            }
    }

    private var navigationControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            navigationButton

            if isNavigationPresented {
                navigationMenu
                    .transition(
                        .asymmetric(
                            insertion:
                                .scale(
                                    scale: 0.88,
                                    anchor: .topLeading
                                )
                                .combined(with: .opacity),
                            removal:
                                .scale(
                                    scale: 0.94,
                                    anchor: .topLeading
                                )
                                .combined(with: .opacity)
                        )
                    )
            }
        }
        .padding(.leading, 16)
        .padding(.top, 8)
    }

    private var navigationButton: some View {
        Button {
            isMessageFocused = false

            withAnimation(
                .spring(
                    response: 0.30,
                    dampingFraction: 0.82
                )
            ) {
                isNavigationPresented.toggle()
            }
        } label: {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.065))

                Circle()
                    .stroke(
                        Color.white.opacity(0.09),
                        lineWidth: 1
                    )

                Image(
                    systemName:
                        isNavigationPresented
                            ? "xmark"
                            : "line.3.horizontal"
                )
                .font(
                    .system(
                        size: isNavigationPresented ? 14 : 16,
                        weight: .semibold
                    )
                )
                .foregroundStyle(.white.opacity(0.74))
                .contentTransition(.symbolEffect(.replace))
            }
            .frame(width: 38, height: 38)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            isNavigationPresented
                ? "Close Selene navigation"
                : "Open Selene navigation"
        )
    }

    private var navigationMenu: some View {
        VStack(spacing: 2) {
            navigationRow(
                title: "Conversation",
                systemImage: "bubble.left.and.bubble.right",
                isSelected: true
            ) {
                closeNavigation()
            }

            navigationDivider

            navigationRow(
                title: "Activity",
                systemImage: "clock",
                isSelected: false
            ) {
                // Destination added in a later pass.
            }

            navigationDivider

            navigationRow(
                title: "Inbox",
                systemImage: "tray",
                isSelected: false
            ) {
                // Destination added in a later pass.
            }

            navigationDivider

            navigationRow(
                title: "Settings",
                systemImage: "gearshape",
                isSelected: false
            ) {
                // Destination added in a later pass.
            }
        }
        .padding(7)
        .frame(width: 238)
        .background {
            RoundedRectangle(
                cornerRadius: 20,
                style: .continuous
            )
            .fill(.ultraThinMaterial)
        }
        .overlay {
            RoundedRectangle(
                cornerRadius: 20,
                style: .continuous
            )
            .fill(Color.black.opacity(0.16))
        }
        .overlay {
            RoundedRectangle(
                cornerRadius: 20,
                style: .continuous
            )
            .stroke(
                Color.white.opacity(0.10),
                lineWidth: 1
            )
        }
        .shadow(
            color: .black.opacity(0.30),
            radius: 22,
            x: 0,
            y: 10
        )
    }

    private var navigationDivider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.055))
            .frame(height: 1)
            .padding(.leading, 42)
            .padding(.trailing, 8)
    }

    private func navigationRow(
        title: String,
        systemImage: String,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(
                        isSelected
                            ? Color(hex: 0x8B7CFF)
                            : Color.white.opacity(0.68)
                    )
                    .frame(width: 24)

                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(
                        isSelected
                            ? Color.white
                            : Color.white.opacity(0.86)
                    )

                Spacer()

                if isSelected {
                    Circle()
                        .fill(Color(hex: 0x8B7CFF))
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 45)
            .contentShape(Rectangle())
            .background {
                if isSelected {
                    RoundedRectangle(
                        cornerRadius: 13,
                        style: .continuous
                    )
                    .fill(
                        Color(hex: 0x8B7CFF)
                            .opacity(0.09)
                    )
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func closeNavigation() {
        withAnimation(
            .spring(
                response: 0.28,
                dampingFraction: 0.86
            )
        ) {
            isNavigationPresented = false
        }
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
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 18) {
                    if viewModel.messages.isEmpty {
                        emptyConversation
                    } else {
                        ForEach(viewModel.messages) { message in
                            conversationMessage(message)
                                .id(message.id)
                        }
                    }

                    if let issue = viewModel.issue {
                        issueView(issue)
                            .id("issue")
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .frame(
                maxWidth: .infinity,
                maxHeight: .infinity
            )
            .onChange(of: viewModel.messages.count) {
                guard let lastMessage = viewModel.messages.last else {
                    return
                }

                withAnimation(.easeOut(duration: 0.25)) {
                    proxy.scrollTo(
                        lastMessage.id,
                        anchor: .bottom
                    )
                }
            }
        }
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

    @ViewBuilder
    private func conversationMessage(
        _ message: ChatViewModel.ConversationMessage
    ) -> some View {
        switch message.role {
        case .user:
            userMessage(message.text)

        case .assistant:
            assistantMessage(message.text)
        }
    }

    private func userMessage(
        _ message: String
    ) -> some View {
        HStack {
            Spacer(minLength: 54)

            Text(message)
                .font(.system(size: 16))
                .foregroundStyle(.white.opacity(0.94))
                .textSelection(.enabled)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background {
                    RoundedRectangle(
                        cornerRadius: 18,
                        style: .continuous
                    )
                    .fill(Color.white.opacity(0.09))
                }
                .overlay {
                    RoundedRectangle(
                        cornerRadius: 18,
                        style: .continuous
                    )
                    .stroke(
                        Color.white.opacity(0.08),
                        lineWidth: 1
                    )
                }
        }
        .frame(maxWidth: .infinity)
    }

    private func assistantMessage(
        _ message: String
    ) -> some View {
        HStack {
            Text(message)
                .font(.system(size: 16))
                .foregroundStyle(.white.opacity(0.92))
                .textSelection(.enabled)
                .fixedSize(
                    horizontal: false,
                    vertical: true
                )

            Spacer(minLength: 44)
        }
        .frame(maxWidth: .infinity)
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

    private func issueView(
        _ issue: ChatViewModel.Issue
    ) -> some View {
        HStack(
            alignment: .top,
            spacing: 10
        ) {
            Image(
                systemName: issueIconName(issue)
            )
            .foregroundStyle(.red)

            Text(issue.message)
                .font(.system(size: 14))
                .foregroundStyle(
                    .white.opacity(0.86)
                )
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

        if showSuccess {
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
