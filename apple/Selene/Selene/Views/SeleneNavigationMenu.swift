import SwiftUI

struct SeleneNavigationMenu: View {
    @Binding var isPresented: Bool
    @Binding var selectedDestination: SeleneDestination

    var onOpen: () -> Void = {}
    
    private let accentColor = Color(
        red: 139.0 / 255.0,
        green: 124.0 / 255.0,
        blue: 1.0
    )

    var body: some View {
        ZStack(alignment: .topLeading) {
            if isPresented {
                dismissLayer
                    .transition(.opacity)
                    .zIndex(0)
            }

            navigationControls
                .zIndex(1)
        }
    }

    // MARK: - Dismissal

    private var dismissLayer: some View {
        Color.black
            .opacity(0.18)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture {
                closeNavigation()
            }
    }

    // MARK: - Navigation controls

    private var navigationControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            navigationButton

            if isPresented {
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
            onOpen()

            withAnimation(
                .spring(
                    response: 0.30,
                    dampingFraction: 0.82
                )
            ) {
                isPresented.toggle()
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
                        isPresented
                            ? "xmark"
                            : "line.3.horizontal"
                )
                .font(
                    .system(
                        size: isPresented ? 14 : 16,
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
            isPresented
                ? "Close Selene navigation"
                : "Open Selene navigation"
        )
    }

    // MARK: - Menu

    private var navigationMenu: some View {
        VStack(spacing: 2) {
            navigationRow(
                title: "Conversation",
                systemImage: "bubble.left.and.bubble.right",
                isSelected: selectedDestination == .conversation
            ) {
                selectDestination(.conversation)
            }
            navigationDivider

            navigationRow(
                title: "Activity",
                systemImage: "clock",
                isSelected: selectedDestination == .activity
            ) {
                selectDestination(.activity)
            }

            navigationDivider

            navigationRow(
                title: "Inbox",
                systemImage: "tray",
                isSelected: selectedDestination == .inbox
            ) {
                selectDestination(.inbox)
            }

            navigationDivider

            navigationRow(
                title: "Settings",
                systemImage: "gearshape",
                isSelected: selectedDestination == .settings
            ) {
                selectDestination(.settings)
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
            .allowsHitTesting(false)
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
            .allowsHitTesting(false)
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

    // MARK: - Menu rows

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
                            ? accentColor
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
                        .fill(accentColor)
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
                    .fill(accentColor.opacity(0.09))
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Actions
    private func selectDestination(_ destination: SeleneDestination) {
        selectedDestination = destination
        closeNavigation()
    }
    private func closeNavigation() {
        withAnimation(
            .spring(
                response: 0.28,
                dampingFraction: 0.86
            )
        ) {
            isPresented = false
        }
    }
}
