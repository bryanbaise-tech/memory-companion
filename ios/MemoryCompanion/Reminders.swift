import Foundation
import UserNotifications

/// Reminders scheduled on the phone itself, so they arrive even when the app is closed.
/// The web app sends the full list whenever tasks, medicines or the calendar change;
/// this replaces everything it scheduled before (all ids start with "mc-").
enum Reminders {
    #if DEBUG
    static var debugReceived: [[String: Any]] = []
    static var debugErrors: [String] = []
    #endif

    static func replaceAll(with items: [[String: Any]]) {
        #if DEBUG
        debugReceived = items.compactMap { request(for: $0) }.map { r in
            let t = r.trigger as? UNCalendarNotificationTrigger
            return ["id": r.identifier, "title": r.content.title, "body": r.content.body, "route": r.content.userInfo["route"] ?? "",
                    "when": "\(t?.dateComponents.year.map { "\($0)-" } ?? "")\(t?.dateComponents.month.map { "\($0)-" } ?? "")\(t?.dateComponents.day.map { "\($0) " } ?? "")\(t?.dateComponents.hour ?? -1):\(String(format: "%02d", t?.dateComponents.minute ?? 0))",
                    "repeats": t?.repeats ?? false]
        }
        debugErrors = []
        #endif
        let center = UNUserNotificationCenter.current()
        var skipPrompt = false
        #if DEBUG
        skipPrompt = ProcessInfo.processInfo.arguments.contains("-mcSkipNotificationPrompt") // Simulator tests
        #endif
        let schedule = {
            center.getPendingNotificationRequests { pending in
                let old = pending.map(\.identifier).filter { $0.hasPrefix("mc-") }
                center.removePendingNotificationRequests(withIdentifiers: old)
                for item in items.prefix(60) {
                    guard let request = request(for: item) else { continue }
                    center.add(request) { error in
                        #if DEBUG
                        if let error { debugErrors.append(error.localizedDescription) }
                        #endif
                    }
                }
            }
        }
        if skipPrompt { return schedule() }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            if granted { schedule() }
        }
    }

    #if DEBUG
    /// Test hook: writes the scheduled reminders to Documents/pending.json.
    static func debugDump() {
        UNUserNotificationCenter.current().getPendingNotificationRequests { pending in
            let rows: [[String: Any]] = pending.filter { $0.identifier.hasPrefix("mc-") }.map { r in
                let t = r.trigger as? UNCalendarNotificationTrigger
                return ["id": r.identifier, "title": r.content.title, "body": r.content.body,
                        "hour": t?.dateComponents.hour ?? -1, "minute": t?.dateComponents.minute ?? -1,
                        "repeats": t?.repeats ?? false, "route": r.content.userInfo["route"] ?? ""]
            }
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let all: [String: Any] = ["scheduled": rows, "received": debugReceived, "errors": Array(Set(debugErrors))]
            if let data = try? JSONSerialization.data(withJSONObject: all, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: dir.appendingPathComponent("pending.json"))
            }
        }
    }
    #endif

    private static func request(for item: [String: Any]) -> UNNotificationRequest? {
        guard let id = item["id"] as? String, id.count < 120,
              let title = item["title"] as? String else { return nil }
        let content = UNMutableNotificationContent()
        content.title = String(title.prefix(120))
        content.body = String(((item["body"] as? String) ?? "").prefix(200))
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        if let route = item["route"] as? String, route.hasPrefix("#"), route.count < 40 { content.userInfo = ["route": route] }

        var when = DateComponents()
        let repeats = (item["repeats"] as? Bool) ?? false
        if let date = item["date"] as? [String: Any] {
            when.year = date["year"] as? Int
            when.month = date["month"] as? Int
            when.day = date["day"] as? Int
            when.hour = date["hour"] as? Int
            when.minute = date["minute"] as? Int
        } else {
            when.hour = item["hour"] as? Int
            when.minute = item["minute"] as? Int
        }
        guard let h = when.hour, let m = when.minute, (0...23).contains(h), (0...59).contains(m) else { return nil }
        let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: repeats && item["date"] == nil)
        return UNNotificationRequest(identifier: "mc-" + id, content: content, trigger: trigger)
    }
}
