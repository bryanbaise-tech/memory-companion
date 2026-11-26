import SwiftUI
import WebKit
import UserNotifications

struct CompanionWebView: UIViewRepresentable {
    @ObservedObject var router: Router

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []      // speak and play without a tap first
        config.websiteDataStore = .default()                       // keep sign-in and settings between launches
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "mc")
        config.userContentController = controller

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = false
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.984, green: 0.949, blue: 0.914, alpha: 1)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.web = web
        web.load(Router.request(Router.home))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        guard let next = router.pending else { return }
        DispatchQueue.main.async { router.pending = nil }
        switch next {
        case .load(let url):
            web.load(Router.request(url))
        case .hash(let hash):
            let js = "location.hash = \(String(reflecting: hash));"
            web.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var web: WKWebView?

        // Messages from the web app: {type: "schedule", items: [...]} or {type: "awake", on: Bool}.
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == Router.home.host,
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }
            switch type {
            case "schedule":
                Reminders.replaceAll(with: body["items"] as? [[String: Any]] ?? [])
            case "awake":
                UIApplication.shared.isIdleTimerDisabled = (body["on"] as? Bool) ?? false
            #if DEBUG
            case "debugDump":
                Reminders.debugDump()
            #endif
            default:
                break
            }
        }

        // Only the app's own pages load inside; phone calls, texts, email and the music apps open outside.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            let inside = url.host == Router.home.host || url.host == "hekxmgammddlkdxtjvfd.supabase.co"
            if action.targetFrame?.isMainFrame == false || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
                return decisionHandler(.allow) // embedded players, generated audio, QR images
            }
            if url.scheme == "https" && inside { return decisionHandler(.allow) }
            if ["tel", "sms", "mailto", "facetime", "facetime-audio", "https", "spotify", "music"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        // Links that ask for a new window (e.g. "Play full song in Spotify") open in that app or Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { UIApplication.shared.open(url) }
            return nil
        }

        // Microphone for voice messages and voice recordings: iOS asks once, then the app remembers.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == Router.home.host ? .grant : .deny)
        }

        // confirm() and alert() from the web app become native dialogs.
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(alert, orElse: { completionHandler(false) })
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(alert, orElse: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
            present(alert, orElse: { completionHandler(nil) })
        }

        private func present(_ alert: UIAlertController, orElse fallback: @escaping () -> Void) {
            guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController
            else { return fallback() }
            var top = root
            while let next = top.presentedViewController { top = next }
            top.present(alert, animated: true)
        }

        // No internet: show a calm page that retries by itself.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showOffline(webView, error)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showOffline(webView, error)
        }
        private func showOffline(_ webView: WKWebView, _ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            guard let page = Bundle.main.url(forResource: "offline", withExtension: "html") else { return }
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }

        // The web content process can be stopped by iOS under memory pressure; reload it.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(Router.request(Router.home))
        }

        #if DEBUG
        // Test hook (Debug builds only): `-mcEval "<js>"` runs after each page load.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-mcEval"), i + 1 < args.count else { return }
            webView.evaluateJavaScript(args[i + 1], completionHandler: nil)
        }
        #endif
    }
}
