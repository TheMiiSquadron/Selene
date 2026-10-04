//
//  Selene_MacApp.swift
//  Selene Mac
//
//  Created by Alex Markham on 10/3/26.
//

import SwiftUI

@main
struct Selene_MacApp: App {
    var body: some Scene {
        WindowGroup(id: "selene-home") {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)

        MenuBarExtra {
            SeleneMenuBarView()
        } label: {
            Image("MoonStars")
                .resizable()
                .scaledToFit()
                .frame(width: 22, height: 22)
        }
        .menuBarExtraStyle(.window)
    }
}
