import SwiftUI

struct ContentView: View {
    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()

            SelenePebble(
                state: .idle,
                size: 76
            )
        }
        .frame(
            minWidth: 600,
            minHeight: 400
        )
    }
}

#Preview {
    ContentView()
}
