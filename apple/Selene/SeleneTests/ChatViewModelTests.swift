import Foundation
import Testing
@testable import Selene

@Suite("Chat view model")
@MainActor
struct ChatViewModelTests {
    @Test("Initial state is disconnected")
    func initialState() {
        let viewModel = makeViewModel(api: StubCompanionAPI())

        #expect(viewModel.assistantDisplayName == "Test Selene")
        #expect(viewModel.connectionState == .notConnected)
        #expect(viewModel.statusText == "Not Checked")
        #expect(viewModel.pebbleState == .neutral)
        #expect(viewModel.latestReply == nil)
        #expect(viewModel.issue == nil)
        #expect(!viewModel.isBusy)
    }

    @Test("Successful connection check marks Companion connected")
    func successfulConnectionCheck() async {
        let api = StubCompanionAPI()
        let viewModel = makeViewModel(api: api)

        await viewModel.checkConnection()
        let healthRequestCount = await api.healthRequestCount

        #expect(viewModel.connectionState == .connected)
        #expect(viewModel.statusText == "Connected")
        #expect(viewModel.pebbleState == .connected)
        #expect(viewModel.issue == nil)
        #expect(healthRequestCount == 1)
    }

    @Test("Failed connection check presents a connection error")
    func failedConnectionCheck() async {
        let api = StubCompanionAPI(
            health: { throw URLError(.cannotConnectToHost) }
        )
        let viewModel = makeViewModel(api: api)

        await viewModel.checkConnection()

        #expect(viewModel.connectionState == .unavailable)
        #expect(viewModel.statusText == "Connection Unavailable")
        #expect(viewModel.pebbleState == .error)
        #expect(viewModel.issue == .connection("Unable to reach Companion."))
    }

    @Test("Connection check exposes checking status and working Pebble")
    func checkingConnection() async {
        let api = BlockingHealthCompanionAPI()
        let viewModel = makeViewModel(api: api)

        let connectionCheck = Task {
            await viewModel.checkConnection()
        }

        await api.waitUntilHealthCheckStarts()

        #expect(viewModel.connectionState == .checking)
        #expect(viewModel.statusText == "Checking Connection")
        #expect(viewModel.pebbleState == .working)
        #expect(viewModel.isCheckingConnection)
        #expect(viewModel.isBusy)

        await api.completeHealthCheck()
        await connectionCheck.value

        #expect(viewModel.connectionState == .connected)
        #expect(viewModel.statusText == "Connected")
        #expect(viewModel.pebbleState == .connected)
    }

    @Test("Whitespace-only messages are rejected locally")
    func whitespaceMessage() async {
        let api = StubCompanionAPI()
        let viewModel = makeViewModel(api: api)
        viewModel.message = "  \n\t "

        await viewModel.sendMessage()
        let sentMessages = await api.sentMessages

        #expect(viewModel.message == "  \n\t ")
        #expect(viewModel.issue == .attention("Enter a message first."))
        #expect(viewModel.statusText == "Not Checked")
        #expect(viewModel.pebbleState == .attention)
        #expect(sentMessages.isEmpty)
    }

    @Test("Conversation Pebble mapping preserves attention and connection states")
    func conversationPebbleMapping() {
        #expect(SelenePebble.State(.neutral) == .idle)
        #expect(SelenePebble.State(.connected) == .idle)
        #expect(SelenePebble.State(.working) == .working)
        #expect(SelenePebble.State(.attention) == .asking)
        #expect(SelenePebble.State(.error) == .error)
    }

    @Test("Successful send displays the reply and clears input")
    func successfulSend() async {
        let api = StubCompanionAPI(
            chat: { _ in
                CompanionChatResponse(
                    ok: true,
                    reply: "Hello from Selene.",
                    state: "idle",
                    events: []
                )
            }
        )
        let viewModel = makeViewModel(api: api)
        viewModel.message = "  Hello  "

        await viewModel.sendMessage()
        let sentMessages = await api.sentMessages

        #expect(sentMessages == ["Hello"])
        #expect(viewModel.latestReply == "Hello from Selene.")
        #expect(viewModel.message.isEmpty)
        #expect(viewModel.connectionState == .connected)
        #expect(viewModel.statusText == "Connected")
        #expect(viewModel.pebbleState == .connected)
        #expect(viewModel.issue == nil)
    }

    @Test("Failed send preserves input")
    func failedSend() async {
        let api = StubCompanionAPI(
            chat: { _ in throw URLError(.networkConnectionLost) }
        )
        let viewModel = makeViewModel(api: api)
        viewModel.message = "Please try this"

        await viewModel.sendMessage()

        #expect(viewModel.message == "Please try this")
        #expect(viewModel.latestReply == nil)
        #expect(viewModel.connectionState == .unavailable)
        #expect(viewModel.statusText == "Connection Unavailable")
        #expect(viewModel.pebbleState == .error)
        #expect(viewModel.issue == .connection("Unable to reach Companion."))
    }

    @Test("Structured API errors are presented while Companion remains connected")
    func serverError() async {
        let api = StubCompanionAPI(
            chat: { _ in
                throw CompanionAPIError.server(
                    code: "MODEL_UNAVAILABLE",
                    message: "Selene is unavailable right now.",
                    statusCode: 503
                )
            }
        )
        let viewModel = makeViewModel(api: api)
        viewModel.message = "Hello"

        await viewModel.sendMessage()

        #expect(viewModel.message == "Hello")
        #expect(viewModel.connectionState == .connected)
        #expect(viewModel.statusText == "Connected")
        #expect(viewModel.issue == .server("Selene is unavailable right now."))
        #expect(viewModel.pebbleState == .error)
    }

    @Test("Duplicate sends are ignored while a send is in progress")
    func duplicateSend() async {
        let api = BlockingCompanionAPI()
        let viewModel = makeViewModel(api: api)
        viewModel.message = "Hello"

        let firstSend = Task {
            await viewModel.sendMessage()
        }

        await api.waitUntilSendStarts()
        #expect(viewModel.isSending)
        #expect(viewModel.statusText == "Sending")
        #expect(viewModel.pebbleState == .working)

        await viewModel.sendMessage()
        let sendCountDuringRequest = await api.sendCount
        #expect(sendCountDuringRequest == 1)

        await api.completeSend()
        await firstSend.value
        let finalSendCount = await api.sendCount

        #expect(finalSendCount == 1)
        #expect(viewModel.latestReply == "Only once.")
        #expect(viewModel.statusText == "Connected")
        #expect(viewModel.pebbleState == .connected)
    }

    private func makeViewModel(api: any CompanionAPIProviding) -> ChatViewModel {
        ChatViewModel(
            configuration: AppConfiguration(
                assistantDisplayName: "Test Selene",
                companionBaseURL: AppConfiguration.development.companionBaseURL
            ),
            api: api
        )
    }
}

private actor BlockingHealthCompanionAPI: CompanionAPIProviding {
    private var healthRequestCount = 0
    private var healthContinuation: CheckedContinuation<CompanionHealthResponse, any Error>?

    func fetchHealth() async throws -> CompanionHealthResponse {
        healthRequestCount += 1

        return try await withCheckedThrowingContinuation { continuation in
            healthContinuation = continuation
        }
    }

    func sendChat(message: String) async throws -> CompanionChatResponse {
        CompanionChatResponse(ok: true, reply: "Hello.", state: "idle", events: [])
    }

    func waitUntilHealthCheckStarts() async {
        while healthRequestCount == 0 {
            await Task.yield()
        }
    }

    func completeHealthCheck() {
        healthContinuation?.resume(
            returning: CompanionHealthResponse(
                ok: true,
                name: "Selene Core",
                machine: "Test Host",
                version: "0"
            )
        )
        healthContinuation = nil
    }
}

private actor StubCompanionAPI: CompanionAPIProviding {
    typealias HealthHandler = @Sendable () async throws -> CompanionHealthResponse
    typealias ChatHandler = @Sendable (String) async throws -> CompanionChatResponse

    private let health: HealthHandler
    private let chat: ChatHandler
    private(set) var healthRequestCount = 0
    private(set) var sentMessages: [String] = []

    init(
        health: @escaping HealthHandler = {
            CompanionHealthResponse(ok: true, name: "Selene Core", machine: "Test Host", version: "0")
        },
        chat: @escaping ChatHandler = { _ in
            CompanionChatResponse(ok: true, reply: "Hello.", state: "idle", events: [])
        }
    ) {
        self.health = health
        self.chat = chat
    }

    func fetchHealth() async throws -> CompanionHealthResponse {
        healthRequestCount += 1
        return try await health()
    }

    func sendChat(message: String) async throws -> CompanionChatResponse {
        sentMessages.append(message)
        return try await chat(message)
    }
}

private actor BlockingCompanionAPI: CompanionAPIProviding {
    private(set) var sendCount = 0
    private var sendContinuation: CheckedContinuation<CompanionChatResponse, any Error>?

    func fetchHealth() async throws -> CompanionHealthResponse {
        CompanionHealthResponse(ok: true, name: "Selene Core", machine: "Test Host", version: "0")
    }

    func sendChat(message: String) async throws -> CompanionChatResponse {
        sendCount += 1

        return try await withCheckedThrowingContinuation { continuation in
            sendContinuation = continuation
        }
    }

    func waitUntilSendStarts() async {
        while sendCount == 0 {
            await Task.yield()
        }
    }

    func completeSend() {
        sendContinuation?.resume(
            returning: CompanionChatResponse(
                ok: true,
                reply: "Only once.",
                state: "idle",
                events: []
            )
        )
        sendContinuation = nil
    }
}
