// A small native window around Beekeep: Dock icon with a badge, its own menu and
// shortcuts, and no browser around it. Everything else is the same page.
import Cocoa
import WebKit

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var base: URL?

    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "badge")
        config.userContentController.add(self, name: "quit")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Beekeep"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.165, green: 0.212, blue: 0.247, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("Beekeep")
        window.isReleasedWhenClosed = false
        if ProcessInfo.processInfo.environment["BEEKEEP_QUIET"] == nil {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        buildMenu()
        let link = CommandLine.arguments.dropFirst().first { $0.hasPrefix("http://127.0.0.1:") }
        if let link, let url = URL(string: link) { open(url) } else { askHive() }
    }

    func open(_ url: URL) {
        base = URL(string: "/", relativeTo: url)
        web.load(URLRequest(url: url))
    }

    /// Started from the Dock: the hive command gives a fresh one-time link.
    func askHive() {
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [Bundle.main.path(forResource: "hive-path", ofType: "txt").flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "", "link"]
            let pipe = Pipe()
            p.standardOutput = pipe
            try? p.run()
            p.waitUntilExit()
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let last = out.split(separator: "\n").last.map(String.init) ?? ""
            DispatchQueue.main.async {
                if last.hasPrefix("http://127.0.0.1:"), let url = URL(string: last) { self.open(url) } else {
                    self.web.loadHTMLString("<body style='background:#2a363f;color:#eef0ea;font:15px -apple-system;padding:40px'>Beekeep did not start. Open a terminal and run <b>beekeep logs</b>.", baseURL: nil)
                }
            }
        }
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        // Beekeep was stopped on purpose; an open window would only wait for nothing.
        if m.name == "quit" { return NSApp.terminate(nil) }
        let n = (m.body as? NSNumber)?.intValue ?? 0
        NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
    }

    // Only Beekeep itself is shown here; other addresses open in the normal browser.
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = a.request.url else { return decisionHandler(.cancel) }
        if url.host == "127.0.0.1" || url.scheme == "about" { return decisionHandler(.allow) }
        if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let top = NSMenuItem()
            top.submenu = m
            main.addItem(top)
        }
        func item(_ title: String, _ sel: Selector?, _ key: String = "") -> NSMenuItem { NSMenuItem(title: title, action: sel, keyEquivalent: key) }
        menu("Beekeep", [
            item("Hide Beekeep", #selector(NSApplication.hide(_:)), "h"),
            item("Quit Beekeep Window", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        menu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Reload", #selector(reload), "r"),
        ])
        NSApp.mainMenu = main
    }

    @objc func reload() { askHive() }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
