import SwiftUI

/// Selene's native Apple Pebble.
///
/// The Pebble is a translucent glass object containing state-colored light.
/// Its geometry remains constant across states; only its illumination and
/// animation change.
struct SelenePebble: View {

    struct IdleVisualValues: Equatable {
        let internalBaseOpacity: Double
        let internalBloomOpacity: Double
        let externalGlowOpacity: Double
        let glowScale: CGFloat
        let internalLightScale: CGFloat
    }

    // MARK: - State

    enum State: CaseIterable, Equatable {
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

    @Environment(\.accessibilityReduceMotion)
    private var reduceMotion

    @State private var breathing = false
    @State private var ringRotation = 0.0
    @State private var successPulse = false

    private var palette: Palette {
        state.palette
    }

    static func idleVisualValues(isExpanded: Bool) -> IdleVisualValues {
        IdleVisualValues(
            internalBaseOpacity: 0.26,
            internalBloomOpacity: 0.30,
            externalGlowOpacity: isExpanded ? 0.075 : 0.055,
            glowScale: isExpanded ? 1.02 : 0.99,
            internalLightScale: isExpanded ? 1.005 : 0.995
        )
    }

    private var idleVisualValues: IdleVisualValues {
        Self.idleVisualValues(isExpanded: breathing)
    }

    // MARK: - Body

    var body: some View {
        ZStack {
            externalGlow
            internalLight
            glassShell

            if state == .working {
                workingPerimeterLight
            }
        }
        .frame(width: size, height: size)
        .onAppear {
            startAnimations(for: state)
        }
        .onChange(of: state) { _, newState in
            startAnimations(for: newState)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Selene")
        .accessibilityValue(accessibilityDescription)
    }

    // MARK: - External glow

    /// A restrained bloom escaping from the illuminated glass.
    private var externalGlow: some View {
        PebbleShape()
            .fill(palette.halo.opacity(externalGlowOpacity))
            .frame(
                width: size * 1.08,
                height: size * 1.08
            )
            .blur(radius: size * 0.13)
            .scaleEffect(glowScale)
    }

    // MARK: - Internal state light

    /// The state color exists underneath the glass rather than tinting
    /// the glass shell itself.
    private var internalLight: some View {
        ZStack {
            PebbleShape()
                .fill(
                    LinearGradient(
                        stops: [
                            .init(
                                color: palette.core.opacity(
                                    internalBaseOpacity * 0.45
                                ),
                                location: 0.00
                            ),
                            .init(
                                color: palette.core.opacity(
                                    internalBaseOpacity
                                ),
                                location: 0.48
                            ),
                            .init(
                                color: palette.halo.opacity(
                                    internalBaseOpacity * 0.82
                                ),
                                location: 1.00
                            )
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            PebbleShape()
                .fill(
                    RadialGradient(
                        stops: [
                            .init(
                                color: palette.bloom.opacity(
                                    internalBloomOpacity
                                ),
                                location: 0.00
                            ),
                            .init(
                                color: palette.core.opacity(
                                    internalBloomOpacity * 0.88
                                ),
                                location: 0.28
                            ),
                            .init(
                                color: palette.core.opacity(
                                    internalBloomOpacity * 0.50
                                ),
                                location: 0.58
                            ),
                            .init(
                                color: .clear,
                                location: 1.00
                            )
                        ],
                        center: UnitPoint(x: 0.62, y: 0.46),
                        startRadius: 0,
                        endRadius: size * 0.76
                    )
                )
        }
        .clipShape(PebbleShape())
        .scaleEffect(internalLightScale)
    }

    // MARK: - Glass shell

    /// Neutral translucent surface detail sits above the colored light.
    /// These layers create reflection and depth without hiding the state.
    private var glassShell: some View {
        PebbleShape()

            // Very light neutral glass tint.
            .fill(
                LinearGradient(
                    stops: [
                        .init(
                            color: .white.opacity(0.20),
                            location: 0.00
                        ),
                        .init(
                            color: .white.opacity(0.07),
                            location: 0.30
                        ),
                        .init(
                            color: .clear,
                            location: 0.58
                        ),
                        .init(
                            color: .black.opacity(0.12),
                            location: 1.00
                        )
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )

            // Broad reflected light across the upper-left glass.
            .overlay {
                PebbleShape()
                    .fill(
                        RadialGradient(
                            stops: [
                                .init(
                                    color: .white.opacity(0.34),
                                    location: 0.00
                                ),
                                .init(
                                    color: .white.opacity(0.15),
                                    location: 0.28
                                ),
                                .init(
                                    color: .white.opacity(0.04),
                                    location: 0.60
                                ),
                                .init(
                                    color: .clear,
                                    location: 1.00
                                )
                            ],
                            center: UnitPoint(x: 0.24, y: 0.16),
                            startRadius: 0,
                            endRadius: size * 0.72
                        )
                    )
                    .blendMode(.screen)
            }

            // Thin diagonal surface sheen.
            .overlay {
                PebbleShape()
                    .fill(
                        LinearGradient(
                            stops: [
                                .init(
                                    color: .white.opacity(0.28),
                                    location: 0.00
                                ),
                                .init(
                                    color: .white.opacity(0.08),
                                    location: 0.22
                                ),
                                .init(
                                    color: .clear,
                                    location: 0.46
                                ),
                                .init(
                                    color: .clear,
                                    location: 1.00
                                )
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .blendMode(.screen)
            }

            // Crisp outer glass edge.
            .overlay {
                PebbleShape()
                    .stroke(
                        LinearGradient(
                            stops: [
                                .init(
                                    color: .white.opacity(0.90),
                                    location: 0.00
                                ),
                                .init(
                                    color: .white.opacity(0.42),
                                    location: 0.28
                                ),
                                .init(
                                    color: .white.opacity(0.13),
                                    location: 0.62
                                ),
                                .init(
                                    color: .black.opacity(0.22),
                                    location: 1.00
                                )
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: max(0.9, size * 0.013)
                    )
            }

            // A faint inner rim gives the glass thickness.
            .overlay {
                PebbleShape()
                    .inset(by: size * 0.035)
                    .stroke(
                        LinearGradient(
                            colors: [
                                .white.opacity(0.18),
                                .clear,
                                .black.opacity(0.12)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: max(0.6, size * 0.008)
                    )
            }

            .shadow(
                color: palette.halo.opacity(edgeGlowOpacity),
                radius: size * 0.08
            )

            .shadow(
                color: .black.opacity(0.38),
                radius: size * 0.08,
                x: 0,
                y: size * 0.045
            )

            .scaleEffect(pebbleScale)
    }

    // MARK: - Working light

    /// The Pebble never rotates.
    /// A bright section of the perimeter travels around the stationary glass.
    private var workingPerimeterLight: some View {
        PebbleShape()
            .stroke(
                AngularGradient(
                    gradient: Gradient(stops: [
                        .init(
                            color: .clear,
                            location: 0.00
                        ),
                        .init(
                            color: .clear,
                            location: 0.55
                        ),
                        .init(
                            color: palette.core.opacity(0.12),
                            location: 0.66
                        ),
                        .init(
                            color: palette.core.opacity(0.48),
                            location: 0.74
                        ),
                        .init(
                            color: palette.bloom.opacity(0.90),
                            location: 0.80
                        ),
                        .init(
                            color: .white.opacity(0.96),
                            location: 0.83
                        ),
                        .init(
                            color: palette.bloom.opacity(0.62),
                            location: 0.87
                        ),
                        .init(
                            color: palette.core.opacity(0.16),
                            location: 0.93
                        ),
                        .init(
                            color: .clear,
                            location: 1.00
                        )
                    ]),
                    center: .center,
                    angle: .degrees(ringRotation)
                ),
                lineWidth: max(1.4, size * 0.027)
            )
            .padding(size * 0.025)
            .shadow(
                color: palette.bloom.opacity(0.32),
                radius: size * 0.035
            )
    }

    // MARK: - State intensity

    private var internalBaseOpacity: Double {
        switch state {
        case .idle:
            return idleVisualValues.internalBaseOpacity

        case .working:
            return breathing ? 0.74 : 0.58

        case .success:
            return successPulse ? 0.78 : 0.58

        case .asking:
            return breathing ? 0.76 : 0.58

        case .error:
            return breathing ? 0.80 : 0.62

        case .proactive:
            return breathing ? 0.76 : 0.56
        }
    }

    private var internalBloomOpacity: Double {
        switch state {
        case .idle:
            return idleVisualValues.internalBloomOpacity

        case .working:
            return breathing ? 0.82 : 0.62

        case .success:
            return successPulse ? 0.88 : 0.62

        case .asking:
            return breathing ? 0.84 : 0.64

        case .error:
            return breathing ? 0.86 : 0.66

        case .proactive:
            return breathing ? 0.84 : 0.62
        }
    }

    private var externalGlowOpacity: Double {
        switch state {
        case .idle:
            return idleVisualValues.externalGlowOpacity

        case .working:
            return breathing ? 0.20 : 0.12

        case .success:
            return successPulse ? 0.22 : 0.11

        case .asking:
            return breathing ? 0.20 : 0.12

        case .error:
            return breathing ? 0.22 : 0.13

        case .proactive:
            return breathing ? 0.20 : 0.12
        }
    }

    private var edgeGlowOpacity: Double {
        switch state {
        case .idle:
            return 0.10

        case .working:
            return 0.26

        case .success:
            return 0.23

        case .asking:
            return 0.24

        case .error:
            return 0.27

        case .proactive:
            return 0.25
        }
    }

    // MARK: - Scale

    private var glowScale: CGFloat {
        guard !reduceMotion else {
            return 1
        }

        switch state {
        case .idle:
            return idleVisualValues.glowScale

        case .working:
            return breathing ? 1.07 : 0.98

        case .success:
            return successPulse ? 1.14 : 0.98

        case .asking, .error:
            return breathing ? 1.07 : 0.97

        case .proactive:
            return breathing ? 1.09 : 0.96
        }
    }

    private var internalLightScale: CGFloat {
        guard !reduceMotion else {
            return 1
        }

        switch state {
        case .idle:
            return idleVisualValues.internalLightScale

        case .working:
            return breathing ? 1.025 : 0.99

        case .success:
            return successPulse ? 1.045 : 0.99

        case .asking, .error:
            return breathing ? 1.025 : 0.99

        case .proactive:
            return breathing ? 1.035 : 0.985
        }
    }

    private var pebbleScale: CGFloat {
        guard !reduceMotion else {
            return 1
        }

        if state == .success {
            return successPulse ? 1.035 : 0.985
        }

        return 1
    }

    // MARK: - Animation

    private func startAnimations(for newState: State) {
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
            withAnimation(
                .easeOut(duration: 0.9)
            ) {
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

    // MARK: - Accessibility

    private var accessibilityDescription: String {
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
}

// MARK: - Palette

private struct Palette {
    let core: Color
    let bloom: Color
    let halo: Color
}

// MARK: - Pebble geometry

/// Approximation of the canonical desktop geometry:
///
/// border-radius: 50% 50% 50% 6px;
/// transform: rotate(45deg);
private struct PebbleShape: InsettableShape {
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let insetRect = rect.insetBy(
            dx: insetAmount,
            dy: insetAmount
        )

        let side = min(
            insetRect.width,
            insetRect.height
        )

        let square = CGRect(
            x: insetRect.midX - side / 2,
            y: insetRect.midY - side / 2,
            width: side,
            height: side
        )

        let largeRadius = side * 0.50
        let smallRadius = side * 0.115

        let path = Path(
            roundedRect: square,
            cornerRadii: RectangleCornerRadii(
                topLeading: largeRadius,
                bottomLeading: smallRadius,
                bottomTrailing: largeRadius,
                topTrailing: largeRadius
            )
        )

        let center = CGPoint(
            x: rect.midX,
            y: rect.midY
        )

        var transform = CGAffineTransform.identity

        transform = transform
            .translatedBy(
                x: center.x,
                y: center.y
            )
            .rotated(by: .pi / 4)
            .translatedBy(
                x: -center.x,
                y: -center.y
            )

        return path.applying(transform)
    }

    func inset(by amount: CGFloat) -> PebbleShape {
        var copy = self
        copy.insetAmount += amount
        return copy
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

// MARK: - Preview

#Preview("Selene Pebble") {
    ZStack {
        Color(
            red: 0.025,
            green: 0.025,
            blue: 0.035
        )
        .ignoresSafeArea()

        VStack(spacing: 28) {
            SelenePebble(
                state: .idle,
                size: 76
            )

            SelenePebble(
                state: .working,
                size: 76
            )

            SelenePebble(
                state: .proactive,
                size: 76
            )
        }
    }
}
