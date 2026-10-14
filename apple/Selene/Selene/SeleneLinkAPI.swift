import Foundation

nonisolated struct LinkHealthResponse: Codable, Equatable, Sendable {
    let ok: Bool
    let name: String
    let machine: String
    let version: String
}

nonisolated struct LinkChatRequest: Codable, Equatable, Sendable {
    let message: String
}

nonisolated struct LinkEvent: Codable, Equatable, Sendable {}

nonisolated struct LinkChatResponse: Codable, Equatable, Sendable {
    let ok: Bool
    let reply: String
    let state: String
    let events: [LinkEvent]
}

private nonisolated struct LinkErrorEnvelope: Decodable, Sendable {
    let ok: Bool
    let error: LinkErrorPayload
}

private nonisolated struct LinkErrorPayload: Decodable, Sendable {
    let code: String
    let message: String
}

nonisolated enum SeleneLinkAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidBaseURL
    case invalidResponse
    case malformedResponse
    case httpStatus(Int)
    case server(code: String, message: String, statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            "The Selene Link address is invalid."
        case .invalidResponse:
            "The Selene Link returned an invalid response."
        case .malformedResponse:
            "The Selene Link returned an unreadable response."
        case .httpStatus(let statusCode):
            "The Companion request failed with HTTP status \(statusCode)."
        case .server(_, let message, _):
            message
        }
    }
}

nonisolated protocol SeleneLinkAPIProviding: Sendable {
    func fetchHealth() async throws -> LinkHealthResponse
    func sendChat(message: String) async throws -> LinkChatResponse
}

actor SeleneLinkAPIClient {
    static let allowedPort = 8787
    static let requestTimeout: TimeInterval = 120

    private let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) throws {
        guard
            let scheme = baseURL.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            baseURL.host?.isEmpty == false,
            baseURL.port == Self.allowedPort,
            baseURL.user == nil,
            baseURL.password == nil,
            baseURL.query == nil,
            baseURL.fragment == nil,
            baseURL.path.isEmpty || baseURL.path == "/"
        else {
            throw SeleneLinkAPIError.invalidBaseURL
        }

        self.baseURL = baseURL
        self.session = session
    }

    func fetchHealth() async throws -> LinkHealthResponse {
        var request = request(path: "health")
        request.httpMethod = "GET"

        let response: LinkHealthResponse = try await perform(request)
        guard response.ok else {
            throw SeleneLinkAPIError.malformedResponse
        }
        return response
    }

    func sendChat(message: String) async throws -> LinkChatResponse {
        var request = request(path: "api/chat")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(LinkChatRequest(message: message))

        let response: LinkChatResponse = try await perform(request)
        guard response.ok else {
            throw SeleneLinkAPIError.malformedResponse
        }
        return response
    }

    private func request(path: String) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = Self.requestTimeout
        return request
    }

    private func perform<Response: Decodable & Sendable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw SeleneLinkAPIError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            if
                let envelope = try? decoder.decode(LinkErrorEnvelope.self, from: data),
                envelope.ok == false
            {
                throw SeleneLinkAPIError.server(
                    code: envelope.error.code,
                    message: envelope.error.message,
                    statusCode: httpResponse.statusCode
                )
            }

            throw SeleneLinkAPIError.httpStatus(httpResponse.statusCode)
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw SeleneLinkAPIError.malformedResponse
        }
    }
}

extension SeleneLinkAPIClient: SeleneLinkAPIProviding {}
