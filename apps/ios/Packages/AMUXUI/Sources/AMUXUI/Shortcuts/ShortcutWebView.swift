import SwiftUI
import WebKit
import AMUXSharedUI

struct ShortcutWebView: UIViewRepresentable {
    let url: URL
    @Binding var canGoBack: Bool
    @Binding var canGoForward: Bool
    @Binding var isLoading: Bool
    @Binding var pageTitle: String
    @Binding var pageHost: String
    let actions: ShortcutWebViewActions

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        // KVO for nav state.
        context.coordinator.observe(webView)

        // Wire the action bus so the chrome can drive the web view.
        actions.goBack    = { [weak webView] in webView?.goBack()    }
        actions.goForward = { [weak webView] in webView?.goForward() }
        actions.reload    = { [weak webView] in webView?.reload()    }

        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url != url && webView.url == nil {
            webView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let parent: ShortcutWebView
        private var observations: [NSKeyValueObservation] = []

        init(_ parent: ShortcutWebView) {
            self.parent = parent
        }

        func observe(_ webView: WKWebView) {
            observations.append(webView.observe(\.canGoBack,    options: [.new, .initial]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.canGoBack = wv.canGoBack }
            })
            observations.append(webView.observe(\.canGoForward, options: [.new, .initial]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.canGoForward = wv.canGoForward }
            })
            observations.append(webView.observe(\.isLoading,    options: [.new, .initial]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.isLoading = wv.isLoading }
            })
            observations.append(webView.observe(\.title,        options: [.new, .initial]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.pageTitle = wv.title ?? "" }
            })
            observations.append(webView.observe(\.url,          options: [.new, .initial]) { [weak self] wv, _ in
                Task { @MainActor in self?.parent.pageHost = wv.url?.host ?? "" }
            })
        }
    }
}

@MainActor
final class ShortcutWebViewActions {
    var goBack: (@MainActor () -> Void)?
    var goForward: (@MainActor () -> Void)?
    var reload: (@MainActor () -> Void)?
}

struct ShortcutWebScreen: View {
    let title: String
    let url: URL
    let onClose: () -> Void

    @State private var canGoBack = false
    @State private var canGoForward = false
    @State private var isLoading = false
    @State private var pageTitle = ""
    @State private var pageHost = ""
    @State private var actions = ShortcutWebViewActions()

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ShortcutWebView(
                url: url,
                canGoBack: $canGoBack,
                canGoForward: $canGoForward,
                isLoading: $isLoading,
                pageTitle: $pageTitle,
                pageHost: $pageHost,
                actions: actions
            )
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .background(Color.amux.paper.ignoresSafeArea(edges: .top))
    }

    private var topBar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color.amux.basalt)
                        .frame(width: 30, height: 30)
                        .background(Color.amux.pebble, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
                .accessibilityIdentifier("shortcuts.web.close")

                VStack(alignment: .leading, spacing: 1) {
                    Text(displayTitle)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.amux.onyx)
                        .lineLimit(1)
                    Text(displayHost)
                        .font(.system(size: 11, weight: .regular, design: .monospaced))
                        .foregroundStyle(Color.amux.slate)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 4) {
                    chromeButton(systemName: "chevron.left",  enabled: canGoBack,    action: { actions.goBack?()    })
                    chromeButton(systemName: "chevron.right", enabled: canGoForward, action: { actions.goForward?() })
                    chromeButton(systemName: "arrow.clockwise", enabled: true,       action: { actions.reload?()    })
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.amux.basalt)
                            .frame(width: 30, height: 30)
                    }
                    .accessibilityIdentifier("shortcuts.web.share")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.amux.paper)

            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(Color.amux.hairline)
                    .frame(height: 0.5)
                if isLoading {
                    Rectangle()
                        .fill(Color.amux.cinnabar)
                        .frame(width: 80, height: 1.5)
                        .modifier(LoadingBarMotion())
                }
            }
        }
    }

    private var displayTitle: String {
        let candidate = pageTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return candidate.isEmpty ? title : candidate
    }

    private var displayHost: String {
        let candidate = pageHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return candidate.isEmpty ? (url.host ?? url.absoluteString) : candidate
    }

    @ViewBuilder
    private func chromeButton(systemName: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(enabled ? Color.amux.basalt : Color.amux.slate.opacity(0.5))
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

private struct LoadingBarMotion: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        GeometryReader { geo in
            content
                .offset(x: phase * geo.size.width)
                .onAppear {
                    withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                        phase = 1
                    }
                }
        }
        .frame(height: 1.5)
    }
}
