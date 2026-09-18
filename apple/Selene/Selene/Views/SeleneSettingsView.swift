import SwiftUI
import UIKit

struct SeleneSettingsView: View {

    @Binding var isSubpageOpen: Bool

    @State private var navigationPath = NavigationPath()

    private let accentColor = Color(
        red: 139.0 / 255.0,
        green: 124.0 / 255.0,
        blue: 1.0
    )

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {

                    NavigationLink(value: "appearance") {
                        settingsRow(
                            title: "Appearance",
                            subtitle: "App icon and visual preferences",
                            systemImage: "paintpalette"
                        )
                    }
                    .buttonStyle(.plain)

                    NavigationLink(value: "connection") {
                        settingsRow(
                            title: "Connection",
                            subtitle: "Companion and host status",
                            systemImage: "wifi"
                        )
                    }
                    .buttonStyle(.plain)

                    NavigationLink(value: "about") {
                        settingsRow(
                            title: "About Selene",
                            subtitle: "Version and app information",
                            systemImage: "info.circle"
                        )
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 20)
                .padding(.top, 24)
            }
            .background(
                Color(red: 11 / 255, green: 11 / 255, blue: 16 / 255)
            )
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: String.self) { destination in
                switch destination {
                case "appearance":
                    SeleneAppearanceView()

                case "appIcon":
                    SeleneAppIconView()

                case "connection":
                    SeleneConnectionView()

                default:
                    EmptyView()
                }
            }
        }
        .tint(accentColor)
        .onChange(of: navigationPath.count) { _, count in
            isSubpageOpen = count > 0
        }
    }

    private func settingsRow(
        title: String,
        subtitle: String,
        systemImage: String
    ) -> some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 19))
                .foregroundStyle(accentColor)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.white)

                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .background {
            RoundedRectangle(cornerRadius: 18)
                .fill(.white.opacity(0.055))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(.white.opacity(0.075), lineWidth: 1)
        }
    }
}

// MARK: - Appearance

private struct SeleneAppearanceView: View {

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {

                NavigationLink(value: "appIcon") {
                    HStack(spacing: 14) {
                        Image(systemName: "app")
                            .font(.system(size: 19))
                            .foregroundStyle(
                                Color(
                                    red: 139.0 / 255.0,
                                    green: 124.0 / 255.0,
                                    blue: 1.0
                                )
                            )
                            .frame(width: 28)

                        VStack(alignment: .leading, spacing: 4) {
                            Text("App Icon")
                                .font(.system(size: 16, weight: .medium))
                                .foregroundStyle(.white)

                            Text("Choose Selene's Home Screen icon")
                                .font(.system(size: 13))
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .background {
                        RoundedRectangle(cornerRadius: 18)
                            .fill(.white.opacity(0.055))
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 18)
                            .stroke(.white.opacity(0.075), lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
        }
        .background(
            Color(red: 11 / 255, green: 11 / 255, blue: 16 / 255)
        )
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - App Icon

private struct SeleneAppIconView: View {

    @State private var iconError: String?
    @State private var selectedIcon = "default"

    private let accentColor = Color(
        red: 139.0 / 255.0,
        green: 124.0 / 255.0,
        blue: 1.0
    )

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {

                Text("Choose how Selene appears on your Home Screen.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 8)

                iconRow(
                    title: "Selene",
                    subtitle: "Default",
                    identifier: "default",
                    backgroundColor: Color(
                        red: 11.0 / 255.0,
                        green: 11.0 / 255.0,
                        blue: 16.0 / 255.0
                    )
                )

                iconRow(
                    title: "Red Moon",
                    subtitle: "Ruby",
                    identifier: "red",
                    backgroundColor: Color(
                        red: 181.0 / 255.0,
                        green: 28.0 / 255.0,
                        blue: 50.0 / 255.0
                    )
                )

                if let iconError {
                    Text(iconError)
                        .font(.system(size: 13))
                        .foregroundStyle(.red)
                        .padding(.top, 8)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
        }
        .background(
            Color(red: 11 / 255, green: 11 / 255, blue: 16 / 255)
        )
        .navigationTitle("App Icon")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            selectedIcon =
                UIApplication.shared.alternateIconName == "Selene-Red"
                    ? "red"
                    : "default"
        }
    }

    private func iconRow(
        title: String,
        subtitle: String,
        identifier: String,
        backgroundColor: Color
    ) -> some View {
        Button {
            changeIcon(to: identifier)
        } label: {
            HStack(spacing: 14) {

                ZStack {
                    RoundedRectangle(cornerRadius: 13)
                        .fill(backgroundColor)

                    Image(systemName: "moon")
                        .font(.system(size: 26, weight: .light))
                        .foregroundStyle(.white)
                }
                .frame(width: 54, height: 54)

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.white)

                    Text(subtitle)
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if selectedIcon == identifier {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(accentColor)
                } else {
                    Circle()
                        .stroke(.white.opacity(0.25), lineWidth: 1.5)
                        .frame(width: 22, height: 22)
                }
            }
            .padding(14)
            .background {
                RoundedRectangle(cornerRadius: 18)
                    .fill(.white.opacity(0.055))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .stroke(
                        selectedIcon == identifier
                            ? accentColor.opacity(0.65)
                            : .white.opacity(0.075),
                        lineWidth: 1
                    )
            }
        }
        .buttonStyle(.plain)
    }

    private func changeIcon(to identifier: String) {
        iconError = nil

        let alternateIconName: String? =
            identifier == "red" ? "Selene-Red" : nil

        guard UIApplication.shared.supportsAlternateIcons else {
            iconError = "This device does not support alternate app icons."
            return
        }

        UIApplication.shared.setAlternateIconName(alternateIconName) { error in
            DispatchQueue.main.async {
                if let error {
                    iconError = error.localizedDescription
                } else {
                    selectedIcon = identifier
                }
            }
        }
    }
}

// MARK: - Connection

private struct SeleneConnectionView: View {

    @State private var connectionStatus = "Status not checked"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {

                Text("Manage Selene's connection to your host.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)

                connectionRow(
                    title: "Primary Host",
                    detail: "NOVA",
                    systemImage: "desktopcomputer"
                )

                connectionRow(
                    title: "Companion API",
                    detail: connectionStatus,
                    systemImage: "network"
                )
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
        }
        .background(
            Color(red: 11 / 255, green: 11 / 255, blue: 16 / 255)
        )
        .navigationTitle("Connection")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            checkConnection()
}
    }

    private func connectionRow(
        title: String,
        detail: String,
        systemImage: String
    ) -> some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 19))
                .foregroundStyle(
                    Color(
                        red: 139.0 / 255.0,
                        green: 124.0 / 255.0,
                        blue: 1.0
                    )
                )
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.white)

                Text(detail)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding(16)
        .background {
            RoundedRectangle(cornerRadius: 18)
                .fill(.white.opacity(0.055))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(.white.opacity(0.075), lineWidth: 1)
        }
    }

    private func checkConnection() {
        guard let url = URL(
            string: "http://192.168.6.136:8787/health"
        ) else {
            connectionStatus = "Invalid server address"
            return
        }

        connectionStatus = "Checking..."

        var request = URLRequest(url: url)
        request.timeoutInterval = 5

        URLSession.shared.dataTask(with: request) { data, response, error in
            let isConnected: Bool

            if error == nil,
               let httpResponse = response as? HTTPURLResponse,
               httpResponse.statusCode == 200,
               let data,
               let json = try? JSONSerialization.jsonObject(with: data)
                   as? [String: Any],
               let ok = json["ok"] as? Bool {
                isConnected = ok
            } else {
                isConnected = false
            }

            DispatchQueue.main.async {
                connectionStatus = isConnected ? "Connected" : "Unavailable"
            }
        }.resume()
    }
}