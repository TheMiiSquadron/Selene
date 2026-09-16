import SwiftUI

/// Native Apple implementation of Selene's canonical Pebble.
///
/// Visual behavior is derived from the desktop Pebble implementation:
/// - pebble/src/renderer/pebble.css
/// - pebble/src/shared/pebbleStates.cjs
struct SelenePebble: View {
    enum State: CaseIterable {
        case idle
        case working
        case success
        case asking
        case error
        case proactive

        fileprivate var palette: Palette {
            switch self {
            case .idle:
                Palette(
                    core: Color(hex: 0xDDEBFF),
                    bloom: Color(hex: 0xF4FAFF),
                    halo: Color(hex: 0x8AA7D8)
                )

            case .working:
                Palette(
                    core: Color(hex: 0x2D78FF),
                    bloom: Color(hex: 0xA9D1FF),
                    halo: Color(hex: 0x1E5FD8)
                )

            case .success:
                Palette(
                    core: Color(hex: 0x2FA45E),
                    bloom: Color(hex: 0xA7E7C0),
                    halo: Color(hex: 0x217547)
                )

            case .asking:
                Palette(
                    core: Color(hex: 0xEAA40E),
                    bloom: Color(hex: 0xFFD98A),
                    halo: Color(hex: 0xB87508)
                )

            case .error:
                Palette(
                    core: Color(hex: 0xE63B2E),
                    bloom: Color(hex: 0xFFAAA3),
                    halo: Color(hex: 0xC2301F)
                )

            case .proactive:
                Palette(
                    core: Color(hex: 0x8B7CFF),
                    bloom: Color(hex: 0xB8AFFF),
                    halo: Color(hex: 0x6E67E8)
                )
            }
        }
    }

    let state: State
    var size: CGFloat = 76

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var breathing = false
    @State private var ringRotation = 0.0
    @State private var successPulse = false

    private var palette: Palette {
        state.palette
    }

    var body: some View {
        ZStack {
            halo

            pebbleBody

            if state == .working {
                workingRing
            }
        }
        .frame(width: size, height: size)
        .onAppear {
            updateAnimation(for: state)
        }
        .onChange(of: state) { _, newState in
            updateAnimation(for: newState)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Selene")
        .accessibilityValue(accessibilityState)
    }

    private var halo: some View {
        Circle()
            .fill(palette.halo.opacity(haloOpacity))
            .frame(
                width: size * haloScale,
                height: size * haloScale
            )
            .blur(radius: size * 0.18)
            .scaleEffect(breathingScale)
    }

    private var pebbleBody: some View {
        PebbleShape()
            .fill(.ultraThinMaterial)
            .overlay {
                PebbleShape()
                    .fill(
                        RadialGradient(
                            colors: [
                                palette.bloom.opacity(innerBloomOpacity),
                                palette.core.opacity(innerCoreOpacity),
                                palette.core.opacity(0.08),
                                .clear
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: size * 0.48
                        )
                    )
            }
            .overlay {
                PebbleShape()
                    .fill(
                        LinearGradient(
                            colors: [
                                .white.opacity(0.72),
                                .white.opacity(0.16),
                                .clear,
                                .black.opacity(0.10)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .blendMode(.screen)
            }
            .overlay {
                PebbleShape()
                    .stroke(
                        LinearGradient(
                            colors: [
                                .white.opacity(0.90),
                                .white.opacity(0.28),
                                .black.opacity(0.22)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: max(0.8, size * 0.012)
                    )
            }
            .shadow(
                color: palette.halo.opacity(shadowOpacity),
                radius: size * 0.16,
                x: 0,
                y: size * 0.055
            )
            .shadow(
                color: .black.opacity(0.30),
                radius: size * 0.08,
                x: 0,
                y: size * 0.04
            )
            .scaleEffect(pebbleScale)
    }

    private var workingRing: some View {
        PebbleShape()
            .stroke(
                AngularGradient(
                    colors: [
                        .clear,
                        .clear,
                        .white.opacity(0.08),
                        .white.opacity(0.95),
                        palette.bloom.opacity(0.85),
                        .clear
                    ],
                    center: .center
                ),
                lineWidth: max(2, size * 0.045)
            )
            .padding(size * 0.08)
            .rotationEffect(.degrees(ringRotation))
            .opacity(0.95)
    }

    private var innerBloomOpacity: Double {
        switch state {
        case .idle:
            return breathing ? 0.55 : 0.34

        case .working:
            return breathing ? 0.50 : 0.30

        case .success:
            return successPulse ? 0.95 : 0.30

        case .asking, .error:
            return breathing ? 0.95 : 0.62

        case .proactive:
            return breathing ? 0.88 : 0.48
        }
    }

    private var innerCoreOpacity: Double {
        switch state {
        case .idle:
            return 0.22
        case .working:
            return 0.38
        case .success:
            return successPulse ? 0.70 : 0.24
        case .asking, .error:
            return 0.55
        case .proactive:
            return 0.50
        }
    }

    private var haloOpacity: Double {
        switch state {
        case .idle:
            return 0.14
        case .working:
            return 0.28
        case .success:
            return successPulse ? 0.32 : 0.12
        case .asking, .error:
            return 0.30
        case .proactive:
            return 0.26
        }
    }

    private var haloScale: CGFloat {
        switch state {
        case .idle:
            return 1.15
        case .working:
            return 1.28
        case .success:
            return successPulse ? 1.38 : 1.18
        case .asking, .error:
            return 1.30
        case .proactive:
            return 1.34
        }
    }

    private var shadowOpacity: Double {
        switch state {
        case .idle:
            return 0.20
        case .working:
            return 0.46
        case .success:
            return 0.40
        case .asking, .error:
            return 0.48
        case .proactive:
            return 0.42
        }
    }

    private var breathingScale: CGFloat {
        guard !reduceMotion else {
            return 1
        }

        switch state {
        case .idle:
            return breathing ? 1.04 : 0.98
        case .working:
            return breathing ? 1.05 : 0.98
        case .asking, .error:
            return breathing ? 1.06 : 0.97
        case .proactive:
            return breathing ? 1.08 : 0.92
        case .success:
            return successPulse ? 1.18 : 0.90
        }
    }

    private var pebbleScale: CGFloat {
        guard !reduceMotion else {
            return 1
        }

        if state == .success {
            return successPulse ? 1.08 : 0.96
        }

        return 1
    }

    private var accessibilityState: String {
        switch state {
        case .idle:
            return "Idle"
        case .working:
            return "Working"
        case .success:
            return "Done"
        case .asking:
            return "Needs your attention"
        case .error:
            return "Unable to proceed"
        case .proactive:
            return "Has something for you"
        }
    }

    private func updateAnimation(for newState: State) {
        breathing = false
        ringRotation = 0
        successPulse = false

        guard !reduceMotion else {
            return
        }

        switch newState {
        case .idle:
            withAnimation(
                .easeInOut(duration: 2.0)
                    .repeatForever(autoreverses: true)
            ) {
                breathing = true
            }

        case .working:
            withAnimation(
                .easeInOut(duration: 1.05)
                    .repeatForever(autoreverses: true)
            ) {
                breathing = true
            }

            withAnimation(
                .linear(duration: 1.4)
                    .repeatForever(autoreverses: false)
            ) {
                ringRotation = 360
            }

        case .success:
            withAnimation(.easeOut(duration: 0.9)) {
                successPulse = true
            }

        case .asking, .error:
            withAnimation(
                .easeInOut(duration: 0.625)
                    .repeatForever(autoreverses: true)
            ) {
                breathing = true
            }

        case .proactive:
            withAnimation(
                .easeInOut(duration: 1.9)
                    .repeatForever(autoreverses: true)
            ) {
                breathing = true
            }
        }
    }
}

private struct Palette {
    let core: Color
    let bloom: Color
    let halo: Color
}

/// SwiftUI approximation of the desktop Pebble's:
/// `border-radius: 50% 50% 50% 6px; transform: rotate(45deg);`
private struct PebbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let radius = side * 0.50
        let smallRadius = side * 0.115

        let baseRect = CGRect(
            x: rect.midX - side / 2,
            y: rect.midY - side / 2,
            width: side,
            height: side
        )

        var path = Path(
            roundedRect: baseRect,
            cornerRadii: RectangleCornerRadii(
                topLeading: radius,
                bottomLeading: smallRadius,
                bottomTrailing: radius,
                topTrailing: radius
            )
        )

        let transform = CGAffineTransform(
            rotationAngle: .pi / 4
        ).concatenating(
            CGAffineTransform(
                translationX: rect.midX,
                y: rect.midY
            )
        ).concatenating(
            CGAffineTransform(
                translationX: -rect.midX,
                y: -rect.midY
            )
        )

        path = path.applying(transform)

        return path
    }
}

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

#Preview("Selene Pebble") {
    ZStack {
        Color.black
            .ignoresSafeArea()

        VStack(spacing: 32) {
            SelenePebble(state: .idle)
            SelenePebble(state: .working)
            SelenePebble(state: .proactive)
        }
    }
}