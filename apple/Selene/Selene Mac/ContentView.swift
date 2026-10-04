import SwiftUI

struct ContentView: View {
    @State private var messages: [LocalMessage] = []
    @State private var destination: SeleneDestination = .home
    @State private var isNavigationOpen = false
    @AppStorage("selene.environment") private var environmentRawValue = SeleneEnvironment.obsidian.rawValue

    private var environment: SeleneEnvironment {
        get { SeleneEnvironment(rawValue: environmentRawValue) ?? .obsidian }
        nonmutating set { environmentRawValue = newValue.rawValue }
    }

    var body: some View {
        ZStack {
            SeleneHomeBackground(environment: environment)
                .id(environment)
                .transition(.opacity)

            Group {
                switch destination {
                case .home:
                    if messages.isEmpty {
                        restingHome
                            .transition(.opacity.combined(with: .scale(scale: 0.985)))
                    } else {
                        conversationHome
                            .transition(.opacity)
                    }
                default:
                    SelenePlaceholderDestination(destination: destination, accent: environment.accent)
                        .transition(.opacity)
                }
            }

            if isNavigationOpen {
                Color.black
                    .opacity(0.18)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                            isNavigationOpen = false
                        }
                    }
                    .transition(.opacity)
            }

            SeleneNavigationRail(
                selection: $destination,
                isOpen: $isNavigationOpen,
                accent: environment.accent
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.leading, 10)
            .padding(.top, 28)

            VStack {
                Spacer()
                EnvironmentSwitcher(selection: Binding(
                    get: { environment },
                    set: { newEnvironment in
                        withAnimation(.easeInOut(duration: 0.45)) {
                            environment = newEnvironment
                        }
                    }
                ))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 24)
                .padding(.bottom, 22)
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

            SeleneComposer(accent: environment.accent, onSend: submit)

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

            SeleneComposer(accent: environment.accent, onSend: submit)
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

private enum SeleneDestination: String, CaseIterable, Identifiable {
    case home
    case history
    case activity
    case devices
    case settings

    var id: String { rawValue }

    var title: String { rawValue.capitalized }

    var symbol: String {
        switch self {
        case .home: return "house"
        case .history: return "clock.arrow.circlepath"
        case .activity: return "sparkles"
        case .devices: return "laptopcomputer.and.iphone"
        case .settings: return "gearshape"
        }
    }
}

private struct SeleneNavigationRail: View {
    @Binding var selection: SeleneDestination
    @Binding var isOpen: Bool
    let accent: Color

    @State private var buttonHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            navigationButton

            if isOpen {
                navigationMenu
                    .transition(
                        .asymmetric(
                            insertion: .scale(scale: 0.88, anchor: .topLeading)
                                .combined(with: .opacity),
                            removal: .scale(scale: 0.94, anchor: .topLeading)
                                .combined(with: .opacity)
                        )
                    )
            }
        }
    }

    private var navigationButton: some View {
        Button {
            withAnimation(.spring(response: 0.30, dampingFraction: 0.82)) {
                isOpen.toggle()
            }
        } label: {
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)

                Circle()
                    .fill(.white.opacity(buttonHovered ? 0.055 : 0.025))

                Circle()
                    .stroke(
                        isOpen ? accent.opacity(0.34) : .white.opacity(buttonHovered ? 0.16 : 0.09),
                        lineWidth: 1
                    )

                Image(systemName: isOpen ? "xmark" : "line.3.horizontal")
                    .font(.system(size: isOpen ? 17 : 19, weight: .semibold))
                    .foregroundStyle(.white.opacity(buttonHovered || isOpen ? 0.92 : 0.76))
                    .contentTransition(.symbolEffect(.replace))
            }
            .frame(width: 42, height: 42)
            .shadow(color: isOpen ? accent.opacity(0.15) : .black.opacity(0.14), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .help(isOpen ? "Close navigation" : "Open navigation")
        .accessibilityLabel(isOpen ? "Close Selene navigation" : "Open Selene navigation")
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.16)) {
                buttonHovered = hovering
            }
        }
    }

    private var navigationMenu: some View {
        VStack(spacing: 2) {
            ForEach(Array(SeleneDestination.allCases.enumerated()), id: \.element.id) { index, destination in
                navigationRow(destination)

                if index < SeleneDestination.allCases.count - 1 {
                    Rectangle()
                        .fill(.white.opacity(0.055))
                        .frame(height: 1)
                        .padding(.leading, 42)
                        .padding(.trailing, 8)
                }
            }
        }
        .padding(7)
        .frame(width: 228)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(.black.opacity(0.16))
                .allowsHitTesting(false)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(.white.opacity(0.10), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .shadow(color: .black.opacity(0.30), radius: 22, y: 10)
    }

    private func navigationRow(_ destination: SeleneDestination) -> some View {
        Button {
            selection = destination
            withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                isOpen = false
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: destination.symbol)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(selection == destination ? accent : .white.opacity(0.68))
                    .frame(width: 24)

                Text(destination.title)
                    .font(.system(size: 15, weight: .medium, design: .rounded))
                    .foregroundStyle(selection == destination ? .white : .white.opacity(0.86))

                Spacer()

                if selection == destination {
                    Circle()
                        .fill(accent)
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 45)
            .contentShape(Rectangle())
            .background {
                if selection == destination {
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .fill(accent.opacity(0.09))
                }
            }
        }
        .buttonStyle(.plain)
    }
}

private struct SelenePlaceholderDestination: View {
    let destination: SeleneDestination
    let accent: Color

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: destination.symbol)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(accent.opacity(0.82))

            Text(destination.title)
                .font(.system(size: 24, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.92))

            Text("Coming soon")
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.44))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private enum SeleneEnvironment: String, CaseIterable, Identifiable {
    case obsidian
    case sapphire
    case ruby

    var id: String { rawValue }

    var name: String {
        rawValue.capitalized
    }

    var assetName: String {
        switch self {
        case .obsidian: return "SeleneObsidian"
        case .sapphire: return "SeleneSapphire"
        case .ruby: return "SeleneRuby"
        }
    }

    var accent: Color {
        switch self {
        case .obsidian: return Color(red: 0.55, green: 0.49, blue: 1.0)
        case .sapphire: return Color(red: 0.12, green: 0.58, blue: 1.0)
        case .ruby: return Color(red: 1.0, green: 0.18, blue: 0.30)
        }
    }

    var swatch: Color { accent }
}

private struct EnvironmentSwitcher: View {
    @Binding var selection: SeleneEnvironment
    @State private var hovered: SeleneEnvironment?

    var body: some View {
        HStack(spacing: 8) {
            ForEach(SeleneEnvironment.allCases) { environment in
                Button {
                    selection = environment
                } label: {
                    Circle()
                        .fill(environment.swatch.gradient)
                        .frame(width: 18, height: 18)
                        .overlay {
                            Circle()
                                .strokeBorder(
                                    .white.opacity(selection == environment ? 0.82 : 0.22),
                                    lineWidth: selection == environment ? 1.5 : 1
                                )
                        }
                        .shadow(
                            color: environment.swatch.opacity(selection == environment ? 0.55 : 0),
                            radius: 7
                        )
                        .scaleEffect(hovered == environment ? 1.16 : 1)
                }
                .buttonStyle(.plain)
                .help(environment.name)
                .onHover { isHovering in
                    withAnimation(.easeOut(duration: 0.14)) {
                        hovered = isHovering ? environment : nil
                    }
                }
                .accessibilityLabel(environment.name)
                .accessibilityValue(selection == environment ? "Selected" : "")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay {
            Capsule()
                .strokeBorder(.white.opacity(0.10), lineWidth: 1)
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

    let accent: Color
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
                        ? accent.opacity(0.72)
                        : .white.opacity(0.10),
                    lineWidth: 1
                )
        }
        .shadow(
            color: isFocused
                ? accent.opacity(0.22)
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
    let environment: SeleneEnvironment

    var body: some View {
        ZStack {
            Image(environment.assetName)
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
