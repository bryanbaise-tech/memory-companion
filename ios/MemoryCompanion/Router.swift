import Foundation

/// Where the web view should go next: the start page, a screen inside the app, or the
/// sign-in result coming back from the email link.
final class Router: ObservableObject {
    static let shared = Router()
    static let home = URL(string: "https://bryanbaise-tech.github.io/memory-companion/")!

    /// A full URL to load, or a "#hash" to move to inside the already-loaded app.
    @Published var pending: Pending?

    enum Pending: Equatable {
        case load(URL)
        case hash(String)
    }

    /// The page itself is always checked for a fresh copy, so app updates arrive at once
    /// (scripts and styles are versioned, so those can still come from the cache).
    static func request(_ url: URL) -> URLRequest {
        URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
    }

    func go(hash: String) {
        guard hash.hasPrefix("#"), hash.count < 100 else { return }
        pending = .hash(hash)
    }

    /// memorycompanion://auth#access_token=…  → the web app finishes signing in.
    /// memorycompanion://pair?token=…         → the pairing screen with that link token.
    func open(_ url: URL) {
        guard url.scheme == "memorycompanion" else { return }
        var target = URLComponents(url: Router.home, resolvingAgainstBaseURL: false)!
        switch url.host {
        case "auth":
            target.fragment = url.fragment
        case "pair", "invite":
            let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "token" })?.value ?? ""
            let clean = token.lowercased().filter { "0123456789abcdef".contains($0) }
            guard clean.count == 32 else { return }
            target.queryItems = [URLQueryItem(name: url.host!, value: clean)]
        default:
            return
        }
        if let u = target.url { pending = .load(u) }
    }
}
