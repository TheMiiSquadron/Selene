import Foundation

nonisolated struct CompanionHealthResponse: Codable, Equatable, Sendable {
    let ok: Bool
    let name: String
    let machine: String
    let version: String
}

nonisolated struct CompanionChatRequest: Codable, Equatable, Sendable {
    let message: String
}

nonisolated struct CompanionEvent: Codable, Equatable, Sendable {}

nonisolated struct CompanionChatResponse: Codable, Equatable, Sendable {
    let ok: Bool
    let reply: String
    let state: String
    let events: [CompanionEvent]
}

private nonisolated struct CompanionErrorEnvelope: Decodable, Sendable {
    let ok: Bool
    let error: CompanionErrorPayload
}

private nonisolated struct CompanionErrorPayload: Decodable, Sendable {
    let code: String
    let message: String
}

nonisolated enum CompanionAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidBaseURL
    case invalidResponse
    case malformedResponse
    case httpStatus(Int)
    case server(code: String, message: String, statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            "The Companion server address is invalid."
        case .invalidResponse:
            "The Companion server returned an invalid response."
        case .malformedResponse:
            "The Companion server returned an unreadable response."
        case .httpStatus(let statusCode):
            "The Companion request failed with HTTP status \(statusCode)."
        case .server(_, let message, _):
            message
        }
    }
}

actor CompanionAPIClient {
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
            throw CompanionAPIError.invalidBaseURL
        }

        self.baseURL = baseURL
        self.session = session
    }

    func fetchHealth() async throws -> CompanionHealthResponse {
        var request = request(path: "health")
        request.httpMethod = "GET"

        let response: CompanionHealthResponse = try await perform(request)
        guard response.ok else {
            throw CompanionAPIError.malformedResponse
        }
        return response
    }

    func sendChat(message: String) async throws -> CompanionChatResponse {
        var request = request(path: "api/chat")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(CompanionChatRequest(message: message))

        let response: CompanionChatResponse = try await perform(request)
        guard response.ok else {
            throw CompanionAPIError.malformedResponse
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
            throw CompanionAPIError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            if
                let envelope = try? decoder.decode(CompanionErrorEnvelope.self, from: data),
                envelope.ok == false
            {
                throw CompanionAPIError.server(
                    code: envelope.error.code,
                    message: envelope.error.message,
                    statusCode: httpResponse.statusCode
                )
            }

            throw CompanionAPIError.httpStatus(httpResponse.statusCode)
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw CompanionAPIError.malformedResponse
        }
    }
}
