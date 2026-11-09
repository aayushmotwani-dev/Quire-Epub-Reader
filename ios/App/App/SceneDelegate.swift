import UIKit
import WebKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        removeStaleInbox(keeping: connectionOptions.urlContexts.map { $0.url })

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = QuireBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // "Open in Quire" makes iOS copy each file into Documents/Inbox. Quire imports
    // the book into its own library straight away, so older copies only take up
    // space. Keep the file that is being opened right now.
    private func removeStaleInbox(keeping urls: [URL]) {
        let fm = FileManager.default
        guard let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let inbox = docs.appendingPathComponent("Inbox", isDirectory: true)
        guard let files = try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil) else { return }
        let keep = Set(urls.map { $0.lastPathComponent })
        for file in files where !keep.contains(file.lastPathComponent) {
            try? fm.removeItem(at: file)
        }
    }
}

// Capacitor's screen, plus Quire's own native helper.
class QuireBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PageSnapshotPlugin())
    }
}

// A picture of part of the page, for the page flip. JavaScript calls
// Capacitor.Plugins.PageSnapshot.capture({ x, y, width, height }) with the
// area in CSS pixels (the same as points here). The answer is a JPEG as
// base64 in "data".
@objc(PageSnapshotPlugin)
public class PageSnapshotPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PageSnapshotPlugin"
    public let jsName = "PageSnapshot"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise)
    ]

    @objc func capture(_ call: CAPPluginCall) {
        guard let x = call.getDouble("x"), let y = call.getDouble("y"),
              let width = call.getDouble("width"), let height = call.getDouble("height"),
              width >= 1, height >= 1, width <= 4096, height <= 4096 else {
            call.reject("Invalid area")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.bridge?.webView else {
                call.reject("No web view")
                return
            }
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(x: x, y: y, width: width, height: height)
            config.afterScreenUpdates = true
            webView.takeSnapshot(with: config) { image, _ in
                guard let image = image, let data = image.jpegData(compressionQuality: 0.88) else {
                    call.reject("Snapshot failed")
                    return
                }
                call.resolve(["data": data.base64EncodedString()])
            }
        }
    }
}

