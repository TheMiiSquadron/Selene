import Foundation
import Observation

@MainActor
@Observable
final class ChatViewModel {
    enum ConnectionState: Equatable {
        case notConnected
        case checking
        case connected
        case unavailable
    }

    enum Issue: Equatable {
        case attention(String)
        case connection(String)
        case server(String)

        var message: String {
            switch self {
            case .attention(let message), .connection(let message), .server(let message):
                message
            }
        }
    }

    enum PebbleState: Equatable {
        case neutral
        case working
        case connected
        case attention
        case error
    }

    let assistantDisplayName: String
    var message = ""
    private(set) var connectionState = ConnectionState.notConnected
    private(set) var latestReply: String?
    private(set) var issue: Issue?
    private(set) var isSending = false

    @ObservationIgnored
    private let api: any CompanionAPIProviding

    init(configuration: AppConfiguration, api: any CompanionAPIProviding) {
        assistantDisplayName = configuration.assistantDisplayName
        self.api = api
    }

    var isCheckingConnection: Bool {
        connectionState == .checking
    }

    var isBusy: Bool {
        isCheckingConnection || isSending
    }

    var canSend: Bool {
        !isBusy && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var statusText: String {
        if isSending {
            return "Sending"
        }

        switch connectionState {
        case .notConnected:
            return "Not Connected"
        case .checking:
            return "Checking Connection"
        case .connected:
            return "Connected"
        case .unavailable:
            return "Connection Unavailable"
        }
    }

    var pebbleState: PebbleState {
        if isBusy {
            return .working
        }

        if let issue {
            switch issue {
            case .attention:
                return .attention
            case .connection, .server:
                return .error
            }
        }

        return connectionState == .connected ? .connected : .neutral
    }

    func checkConnection() async {
        guard !isBusy else {
            return
        }

        connectionState = .checking
        issue = nil

        do {
            _ = try await api.fetchHealth()
            connectionState = .connected
        } catch {
            connectionState = .unavailable
            issue = makeIssue(for: error)
        }
    }

    func sendMessage() async {
        guard !isBusy else {
            return
        }

        let outgoingMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !outgoingMessage.isEmpty else {
            issue = .attention("Enter a message first.")
            return
        }

        isSending = true
        issue = nil
        defer { isSending = false }

        do {
            let response = try await api.sendChat(message: outgoingMessage)
            latestReply = response.reply
            message = ""
            connectionState = .connected
        } catch {
            let presentedIssue = makeIssue(for: error)
            issue = presentedIssue

            switch presentedIssue {
            case .connection:
                connectionState = .unavailable
            case .server:
                connectionState = .connected
            case .attention:
                break
            }
        }
    }

    private func makeIssue(for error: Error) -> Issue {
        guard let apiError = error as? CompanionAPIError else {
            return .connection("Unable to reach Companion.")
        }

        switch apiError {
        case .server(_, let message, _):
            return .server(message)
        case .httpStatus, .malformedResponse, .invalidResponse:
            return .server("Companion returned an unexpected response.")
        case .invalidBaseURL:
            return .connection("Companion is not configured correctly.")
        }
    }
}
