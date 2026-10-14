//
//  SeleneApp.swift
//  Selene
//
//  Created by Alex Markham on 9/15/26.
//

import SwiftUI

@main
struct SeleneApp: App {
    @State private var viewModel: ChatViewModel

    init() {
        let configuration = AppConfiguration.development

        guard let api = try? SeleneLinkAPIClient(baseURL: configuration.companionBaseURL) else {
            preconditionFailure("Invalid Selene Link configuration.")
        }

        _viewModel = State(initialValue: ChatViewModel(configuration: configuration, api: api))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: viewModel)
        }
    }
}
