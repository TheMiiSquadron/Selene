import Foundation

nonisolated struct AppConfiguration: Sendable {
    let assistantDisplayName: String
    let companionBaseURL: URL

    static let development = AppConfiguration(
        assistantDisplayName: "Selene",
        companionBaseURL: URL(string: "http://192.168.6.136:8787")!
    )
}
