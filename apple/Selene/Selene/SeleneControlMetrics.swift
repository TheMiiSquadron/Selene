import SwiftUI

enum SeleneControlMetrics {
    static let compactButtonSize: CGFloat = 48
}

private struct SeleneCompactButtonSizeModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(
                width: SeleneControlMetrics.compactButtonSize,
                height: SeleneControlMetrics.compactButtonSize
            )
            .contentShape(Rectangle())
    }
}

extension View {
    func seleneCompactButtonSize() -> some View {
        modifier(SeleneCompactButtonSizeModifier())
    }
}
