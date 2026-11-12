import Tauri
import UIKit
import WebKit

struct CheckSiteArgs: Decodable {
  let key: String
  let url: String
  let site: String
  let name: String
}

struct BrowseSiteArgs: Decodable {
  let key: String
  let url: String
  let site: String
  let cookies: String?
  let cap: Int
}

struct SiteChecked: Encodable {
  let cookies: String?
  let userAgent: String?
}

struct SiteBrowsed: Encodable {
  let json: String
}

/// Sites' browser sessions, each a browser view of the app's own that keeps nothing on the device. A
/// site's check (Cloudflare's "Just a moment…", an age question) is answered in a sheet; then its view
/// stays out of sight in the app and fetches the site's pages as the browser it is. The view goes
/// when the vault locks; the plugin keeps the cookies, in the vault if there is one, and a view is
/// made again from them. A site is only ever loaded because a plugin asked for one of its pages.
final class SiteSessions: NSObject, WKNavigationDelegate, WKUIDelegate {
  private final class Session {
    let webView: WKWebView
    let site: String
    var loaded = false
    var waiting: [(String?) -> Void] = []

    init(webView: WKWebView, site: String) {
      self.webView = webView
      self.site = site
    }

    func settle(_ error: String?) {
      let all = waiting
      waiting = []
      all.forEach { $0(error) }
    }
  }

  private struct Check {
    let key: String
    let session: Session
    let sheet: UIViewController
    let host: UIViewController
    let finish: (SiteChecked) -> Void
  }

  /// Run in the view's own world, where the site's scripts can't reach it. Only ever the page asked for.
  private static let fetchPage = """
    const u = new URL(url, location.href);
    if (u.host !== location.host && u.host.replace(/^www\\./, "") === location.host.replace(/^www\\./, "")) u.host = location.host;
    const r = await fetch(u.href, { credentials: "include", headers: { Accept: "text/html,application/xhtml+xml" } });
    const t = await r.text();
    return JSON.stringify({ status: r.status, body: t.slice(0, cap), truncated: t.length > cap });
    """

  private var sessions: [String: Session] = [:]
  private var checking: Check?

  private func makeSession(site: String) -> Session {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    return Session(webView: webView, site: site)
  }

  private func session(of webView: WKWebView) -> Session? {
    if let check = checking, check.session.webView === webView { return check.session }
    return sessions.values.first { $0.webView === webView }
  }

  private func close(_ session: Session) {
    session.webView.stopLoading()
    session.webView.removeFromSuperview()
    session.webView.navigationDelegate = nil
    session.webView.uiDelegate = nil
  }

  /// In the app's window, so it goes on running, but too small to see and out of the way of fingers.
  private func hide(_ session: Session, in host: UIViewController) {
    session.webView.removeFromSuperview()
    session.webView.autoresizingMask = []
    session.webView.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    session.webView.alpha = 0
    session.webView.isUserInteractionEnabled = false
    host.view.addSubview(session.webView)
  }

  /// A page of the site with no scripts: the view waits there, running none of its ads or tracking.
  private func quietPage(of url: URL?) -> URL? {
    guard let url = url else { return nil }
    return URL(string: "/robots.txt", relativeTo: url)?.absoluteURL
  }

  private static func belongs(_ domain: String, to site: String) -> Bool {
    let host = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
    return host == site || host.hasSuffix(".\(site)")
  }

  // MARK: The check

  /// False when another site's check is still open.
  func check(key: String, url: URL, site: String, name: String, over host: UIViewController, finish: @escaping (SiteChecked) -> Void) -> Bool {
    guard checking == nil else { return false }
    let session = makeSession(site: site)
    let page = UIViewController()
    session.webView.frame = page.view.bounds
    session.webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    page.view.addSubview(session.webView)
    page.navigationItem.title = name
    page.navigationItem.prompt = "Answer what it asks, then press Done."
    page.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancelled))
    page.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(done))
    let sheet = UINavigationController(rootViewController: page)
    // Only Done or Cancel closes it: it has an answer to give.
    sheet.isModalInPresentation = true
    checking = Check(key: key, session: session, sheet: sheet, host: host, finish: finish)
    session.webView.load(URLRequest(url: url))
    host.present(sheet, animated: true)
    return true
  }

  @objc private func cancelled() {
    finishCheck(cookies: nil, userAgent: nil)
  }

  @objc private func done() {
    guard let check = checking else { return }
    let webView = check.session.webView
    webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
      let line = cookies.filter { Self.belongs($0.domain, to: check.session.site) }.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
      webView.evaluateJavaScript("navigator.userAgent") { agent, _ in
        self?.finishCheck(cookies: line.isEmpty ? nil : line, userAgent: agent as? String)
      }
    }
  }

  private func finishCheck(cookies: String?, userAgent: String?, animated: Bool = true) {
    guard let check = checking else { return }
    checking = nil
    check.sheet.dismiss(animated: animated)
    let session = check.session
    if cookies != nil, let home = quietPage(of: session.webView.url) {
      if let old = sessions[check.key] { close(old) }
      hide(session, in: check.host)
      session.loaded = false
      sessions[check.key] = session
      session.webView.load(URLRequest(url: home))
    } else {
      close(session)
    }
    check.finish(SiteChecked(cookies: cookies, userAgent: userAgent))
  }

  // MARK: Pages

  func browse(key: String, url: String, site: String, cookies: String?, cap: Int, over host: UIViewController, finish: @escaping (String?, String?) -> Void) {
    var answered = false
    let answer: (String?, String?) -> Void = { json, error in
      guard !answered else { return }
      answered = true
      finish(json, error)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { answer(nil, "\(site) took too long to answer") }

    let session: Session
    if let open = sessions[key] {
      session = open
    } else {
      guard let line = cookies, !line.trimmingCharacters(in: .whitespaces).isEmpty else {
        return answer(nil, "no browser session for \(site): its check comes first")
      }
      guard let home = quietPage(of: URL(string: url)) else { return answer(nil, "\(site) has no page to wait on") }
      session = reopen(key: key, site: site, cookies: line, home: home, over: host)
    }
    let fetch = {
      session.webView.callAsyncJavaScript(Self.fetchPage, arguments: ["url": url, "cap": cap], in: nil, in: .defaultClient) { result in
        switch result {
        case .success(let value):
          if let json = value as? String {
            answer(json, nil)
          } else {
            answer(nil, "\(site)'s window gave nothing back")
          }
        case .failure(let error):
          answer(nil, "\(site)'s window couldn't fetch it: \(error.localizedDescription)")
        }
      }
    }
    if session.loaded {
      fetch()
    } else {
      session.waiting.append { error in
        if let error = error { answer(nil, error) } else { fetch() }
      }
    }
  }

  /// A session gone (the vault locked, its browser crashed) made again from the cookies its check gave.
  private func reopen(key: String, site: String, cookies: String, home: URL, over host: UIViewController) -> Session {
    let session = makeSession(site: site)
    hide(session, in: host)
    sessions[key] = session
    let store = session.webView.configuration.websiteDataStore.httpCookieStore
    let group = DispatchGroup()
    for pair in cookies.split(separator: ";") {
      let parts = pair.split(separator: "=", maxSplits: 1)
      guard parts.count == 2 else { continue }
      let name = parts[0].trimmingCharacters(in: .whitespaces)
      let value = parts[1].trimmingCharacters(in: .whitespaces)
      guard let cookie = HTTPCookie(properties: [.name: name, .value: value, .domain: ".\(site)", .path: "/", .secure: "TRUE"]) else { continue }
      group.enter()
      store.setCookie(cookie) { group.leave() }
    }
    group.notify(queue: .main) { session.webView.load(URLRequest(url: home)) }
    return session
  }

  /// Every session gone, and a check still open closed: nothing of a site stays when the vault locks.
  func dropAll() {
    for session in sessions.values {
      close(session)
      session.settle("the app left the screen")
    }
    sessions.removeAll()
    finishCheck(cookies: nil, userAgent: nil, animated: false)
  }

  // MARK: The views

  /// The site, its subdomains and Cloudflare's check; never where an ad would send it.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let site = session(of: webView)?.site, let url = action.request.url else { return decisionHandler(.cancel) }
    let host = url.host?.lowercased() ?? ""
    let allowed = ["about", "data", "blob"].contains(url.scheme ?? "") || Self.belongs(host, to: site) || host == "challenges.cloudflare.com"
    decisionHandler(allowed ? .allow : .cancel)
  }

  /// No pop-ups.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    return nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let session = session(of: webView), webView.url?.scheme == "https" else { return }
    session.loaded = true
    session.settle(nil)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(webView, error)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    failed(webView, error)
  }

  private func failed(_ webView: WKWebView, _ error: Error) {
    // Replaced by the next page (the quiet one, after the check): nothing went wrong.
    if (error as NSError).code == NSURLErrorCancelled { return }
    session(of: webView)?.settle(error.localizedDescription)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    if let check = checking, check.session.webView === webView {
      webView.reload()
      return
    }
    guard let (key, session) = sessions.first(where: { $0.value.webView === webView }) else { return }
    close(session)
    sessions[key] = nil
    session.settle("the site's browser stopped")
  }
}

extension QuireIosPlugin {
  @objc public func checkSite(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CheckSiteArgs.self)
    DispatchQueue.main.async {
      guard let url = URL(string: args.url), let host = self.manager.viewController else { return invoke.reject("the site's check couldn't be opened") }
      let opened = self.sites.check(key: args.key, url: url, site: args.site, name: args.name, over: host) { invoke.resolve($0) }
      if !opened { invoke.reject("Another site's check is open: finish that one first.") }
    }
  }

  @objc public func browseSite(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BrowseSiteArgs.self)
    DispatchQueue.main.async {
      guard let host = self.manager.viewController else { return invoke.reject("the app isn't on the screen") }
      self.sites.browse(key: args.key, url: args.url, site: args.site, cookies: args.cookies, cap: args.cap, over: host) { json, error in
        if let json = json { invoke.resolve(SiteBrowsed(json: json)) } else { invoke.reject(error ?? "the site couldn't be read") }
      }
    }
  }

  @objc public func dropSites(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.sites.dropAll()
      invoke.resolve()
    }
  }
}
