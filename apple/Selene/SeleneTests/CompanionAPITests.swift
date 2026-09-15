import Foundation
import Testing
@testable import Selene

@Suite(.serialized)
struct CompanionAPITests {
    @Test("Health uses GET and decodes the Companion response")
    func healthRequest() async throws {
        let recorder = RequestRecorder()
        let (client, session) = try makeClient { request in
            recorder.record(request)
            return try stubResponse(
                for: request,
                statusCode: 200,
                body: #"{"ok":true,"name":"Selene Core","machine":"NOVA","version":"0.3.2"}"#
            )
        }
        defer { session.invalidateAndCancel() }

        let health = try await client.fetchHealth()
        let request = try #require(recorder.request)

        #expect(request.httpMethod == "GET")
        #expect(request.url?.path == "/health")
        #expect(request.url?.port == 8787)
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.httpBody == nil)
        #expect(request.timeoutInterval == CompanionAPIClient.requestTimeout)
        #expect(health == CompanionHealthResponse(
            ok: true,
            name: "Selene Core",
            machine: "NOVA",
            version: "0.3.2"
        ))
    }

    @Test("Chat uses POST with JSON and decodes the Companion response")
    func chatRequest() async throws {
        let recorder = RequestRecorder()
        let (client, session) = try makeClient { request in
            recorder.record(request)
            return try stubResponse(
                for: request,
                statusCode: 200,
                body: #"{"ok":true,"reply":"Hello from Selene.","state":"idle","events":[]}"#
            )
        }
        defer { session.invalidateAndCancel() }

        let chat = try await client.sendChat(message: "Hello")
        let request = try #require(recorder.request)
        let requestBody = try #require(request.httpBody)
        let decodedRequest = try JSONDecoder().decode(CompanionChatRequest.self, from: requestBody)

        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/chat")
        #expect(request.url?.port == 8787)
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(decodedRequest == CompanionChatRequest(message: "Hello"))
        #expect(request.timeoutInterval == CompanionAPIClient.requestTimeout)
        #expect(chat == CompanionChatResponse(
            ok: true,
            reply: "Hello from Selene.",
            state: "idle",
            events: []
        ))
    }

    @Test("Structured API errors are surfaced without internal response details")
    func structuredError() async throws {
        let (client, session) = try makeClient { request in
            try stubResponse(
                for: request,
                statusCode: 400,
                body: #"{"ok":false,"error":{"code":"INVALID_MESSAGE","message":"Message must not be empty."}}"#
            )
        }
        defer { session.invalidateAndCancel() }

        do {
            _ = try await client.sendChat(message: "")
            Issue.record("Expected a structured Companion API error.")
        } catch let error as CompanionAPIError {
            #expect(error == .server(
                code: "INVALID_MESSAGE",
                message: "Message must not be empty.",
                statusCode: 400
            ))
        }
    }

    @Test("Malformed success responses fail predictably")
    func malformedResponse() async throws {
        let (client, session) = try makeClient { request in
            try stubResponse(for: request, statusCode: 200, body: #"{"ok":true}"#)
        }
        defer { session.invalidateAndCancel() }

        do {
            _ = try await client.fetchHealth()
            Issue.record("Expected a malformed response error.")
        } catch let error as CompanionAPIError {
            #expect(error == .malformedResponse)
        }
    }

    @Test("Non-HTTP responses fail predictably")
    func nonHTTPResponse() async throws {
        let (client, session) = try makeClient { request in
            let response = URLResponse(
                url: try #require(request.url),
                mimeType: "application/json",
                expectedContentLength: 0,
                textEncodingName: "utf-8"
            )
            return (response, Data())
        }
        defer { session.invalidateAndCancel() }

        do {
            _ = try await client.fetchHealth()
            Issue.record("Expected an invalid response error.")
        } catch let error as CompanionAPIError {
            #expect(error == .invalidResponse)
        }
    }

    @Test("Client accepts only the Companion port")
    func rejectsPrivilegedPorts() throws {
        #expect(AppConfiguration.development.companionBaseURL.port == 8787)

        for port in [3030, 1234] {
            var components = try #require(URLComponents(
                url: AppConfiguration.development.companionBaseURL,
                resolvingAgainstBaseURL: false
            ))
            components.port = port
            let url = try #require(components.url)

            do {
                _ = try CompanionAPIClient(baseURL: url)
                Issue.record("Expected port \(port) to be rejected.")
            } catch let error as CompanionAPIError {
                #expect(error == .invalidBaseURL)
            }
        }
    }

    private func makeClient(
        handler: @escaping @Sendable (URLRequest) throws -> (URLResponse, Data)
    ) throws -> (CompanionAPIClient, URLSession) {
        URLProtocolStub.handler = handler

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        let session = URLSession(configuration: configuration)
        let client = try CompanionAPIClient(
            baseURL: AppConfiguration.development.companionBaseURL,
            session: session
        )
        return (client, session)
    }
}

private nonisolated func stubResponse(
    for request: URLRequest,
    statusCode: Int,
    body: String
) throws -> (URLResponse, Data) {
    let url = try #require(request.url)
    let response = try #require(HTTPURLResponse(
        url: url,
        statusCode: statusCode,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
    ))
    return (response, Data(body.utf8))
}

private final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedRequest: URLRequest?

    var request: URLRequest? {
        lock.withLock { storedRequest }
    }

    func record(_ request: URLRequest) {
        lock.withLock {
            storedRequest = request
        }
    }
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (URLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: CompanionAPIError.invalidResponse)
            return
        }

        do {
            let capturedRequest = try request.materializingHTTPBody()
            let (response, data) = try handler(capturedRequest)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private extension URLRequest {
    func materializingHTTPBody() throws -> URLRequest {
        guard httpBody == nil, let bodyStream = httpBodyStream else {
            return self
        }

        bodyStream.open()
        defer { bodyStream.close() }

        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4_096)
        defer { buffer.deallocate() }

        var body = Data()

        while true {
            let bytesRead = bodyStream.read(buffer, maxLength: 4_096)

            if bytesRead < 0 {
                throw bodyStream.streamError ?? URLError(.cannotDecodeContentData)
            }

            if bytesRead == 0 {
                break
            }

            body.append(buffer, count: bytesRead)
        }

        var request = self
        request.httpBody = body
        return request
    }
}
