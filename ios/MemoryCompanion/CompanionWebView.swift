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
        #if DEBUG
        controller.addUserScript(WKUserScript(source: Coordinator.diagnostics, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
        config.userContentController = controller

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = false
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.984, green: 0.949, blue: 0.914, alpha: 1)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.web = web
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }   // Safari → Develop → this iPhone
        #endif
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
            case "log":
                print("[web]", body["level"] as? String ?? "log", body["text"] as? String ?? "")
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
            if url.isFileURL && url.standardizedFileURL.path.hasPrefix(Bundle.main.bundleURL.standardizedFileURL.path) {
                return decisionHandler(.allow) // the bundled "no internet" page
            }
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
            #if DEBUG
            print("[native] load failed:", (error as NSError).domain, (error as NSError).code, error.localizedDescription)
            #endif
            // Only real connection problems. Other failures (a cancelled load, a link handed to
            // another app, WebKit's "frame load interrupted") must not replace the page.
            let e = error as NSError
            let offline: Set<Int> = [NSURLErrorNotConnectedToInternet, NSURLErrorTimedOut, NSURLErrorCannotFindHost,
                                     NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorDNSLookupFailed,
                                     NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed]
            guard e.domain == NSURLErrorDomain, offline.contains(e.code) else { return }
            guard let page = Bundle.main.url(forResource: "offline", withExtension: "html") else { return }
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }

        // The web content process can be stopped by iOS under memory pressure; reload it.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(Router.request(Router.home))
        }

        #if DEBUG
        // Diagnostics (Debug builds only): page errors, startup and taps show in the Xcode console.
        static let diagnostics = """
        (function(){
          var send = function(level, parts){ try { window.webkit.messageHandlers.mc.postMessage({type:'log', level:level,
            text: Array.prototype.map.call(parts, function(p){ try { return typeof p === 'string' ? p : (p && p.stack) || JSON.stringify(p); } catch(e) { return String(p); } }).join(' ').slice(0, 2000)}); } catch(e) {} };
          ['error','warn'].forEach(function(l){ var o = console[l]; console[l] = function(){ send(l, arguments); return o.apply(console, arguments); }; });
          window.addEventListener('error', function(e){ send('error', [(e.message || 'resource failed: ' + ((e.target && (e.target.src || e.target.href)) || '?')) + (e.filename ? ' @ ' + e.filename + ':' + e.lineno : '')]); }, true);
          window.addEventListener('unhandledrejection', function(e){ send('error', ['unhandled promise: ', e.reason]); });
          document.addEventListener('securitypolicyviolation', function(e){ send('error', ['CSP blocked ' + e.blockedURI + ' (' + e.violatedDirective + ')']); });
          document.addEventListener('DOMContentLoaded', function(){ send('info', ['DOMContentLoaded, supabase loaded: ' + !!window.supabase]); });
          window.addEventListener('load', function(){ setTimeout(function(){ var a = document.getElementById('app') || document.body;
            send('info', ['load done; screen text: ' + ((a && a.innerText) || '').replace(/\\s+/g, ' ').slice(0, 160)]); }, 1500); });
          document.addEventListener('pointerdown', function(e){ var t = document.elementFromPoint(e.clientX, e.clientY);
            var d = function(n){ return n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '') : 'none'; };
            send('info', ['tap at ' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' hits ' + d(t) + ' inside ' + d(t && t.closest('[data-action],button,a,input,label'))]); }, true);
        })();
        """

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            print("[native] loading", webView.url?.absoluteString ?? "")
        }

        // Test hook (Debug builds only): `-mcEval "<js>"` runs after each page load.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            print("[native] finished loading", webView.url?.absoluteString ?? "")
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-mcEval"), i + 1 < args.count else { return }
            webView.evaluateJavaScript(args[i + 1], completionHandler: nil)
        }
        #endif
    }
}
