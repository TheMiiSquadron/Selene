import Foundation

enum SeleneDestination: String, CaseIterable, Identifiable {
    case conversation
    case activity
    case inbox
    case settings

    var id: Self { self }
}
