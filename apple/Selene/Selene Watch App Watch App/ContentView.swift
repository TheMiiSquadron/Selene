//
//  ContentView.swift
//  Selene Watch App Watch App
//
//  Created by Alex Markham on 9/24/26.
//

import SwiftUI

struct ContentView: View {
    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()

            VStack(spacing: 12) {
                Image(systemName: "moon.fill")
                    .font(.system(size: 54))
                    .foregroundStyle(.purple)

                Text("Selene")
                    .font(.headline)
                    .foregroundStyle(.white)
            }
        }
    }
}

#Preview {
    ContentView()
}
