// Memory Companion for iPhone and iPad.
// A thin native shell around the web app (https://bryanbaise-tech.github.io/memory-companion/):
// the web app does everything it does in Safari, and this shell adds what only a real app can:
//  - reminders scheduled on the phone, so they fire even when the app is closed
//  - keeping the screen on while the picture frame is showing
//  - speaking and playing music without a tap first, even with the silent switch on
//  - reopening the app from the email sign-in link (memorycompanion://auth)
import SwiftUI
import AVFoundation
import UserNotifications

@main
struct MemoryCompanionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var router = Router.shared

    var body: some Scene {
        WindowGroup {
            CompanionWebView(router: router)
                .ignoresSafeArea(.container, edges: .bottom)
                .background(Color(red: 0.984, green: 0.949, blue: 0.914))
                .onOpenURL { url in router.open(url) }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Voices and music play even when the ring/silent switch is on silent.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        #if DEBUG
        // Test hook (Debug builds only): `-mcOpenURL memorycompanion://…` opens a link at launch.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-mcOpenURL"), i + 1 < args.count, let url = URL(string: args[i + 1]) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { Router.shared.open(url) }
        }
        #endif
        return true
    }

    // While the app is open, the web app shows its own large reminder card, so skip the banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    // Tapping a reminder opens the right screen (My Day, Medicines, Calendar…).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let route = response.notification.request.content.userInfo["route"] as? String {
            DispatchQueue.main.async { Router.shared.go(hash: route) }
        }
        completionHandler()
    }
}
