import AVFoundation
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

struct HoldOtherAudioArgs: Decodable {
  let hold: Bool
}

struct WatchArgs: Decodable {
  let changed: Channel
}

struct KeepAwakeArgs: Decodable {
  let on: Bool
}

struct FolderResult: Encodable {
  let path: String?
}

/// Opening a folder the user picks, and hearing the app leave the screen.
class QuireIosPlugin: Plugin, UIDocumentPickerDelegate {
  private static let bookmarkKey = "quire.folderBookmark"
  private var picking: Invoke?
  private var opened: URL?
  private var changed: Channel?
  private var cover: UIView?
  /// The audio taken and given back in the order asked: a video left at once mustn't be given back before it was taken.
  private let audio = DispatchQueue(label: "quire.audio", qos: .userInitiated)
  let sites = SiteSessions()

  override func load(webview: WKWebView) {
    keepOutOfBackups()
    // The page reaches every edge and keeps clear of the notch itself (env(safe-area-inset-*)).
    webview.scrollView.contentInsetAdjustmentBehavior = .never
    // Only what is inside the page scrolls: the page itself stays put under a finger.
    webview.scrollView.bounces = false
    webview.scrollView.isScrollEnabled = false
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(hide), name: UIApplication.willResignActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(show), name: UIApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(left), name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(self, selector: #selector(back), name: UIApplication.willEnterForegroundNotification, object: nil)
  }

  /// What the app keeps on the device (its settings, installed plugins, what the webview stores) stays
  /// on the device: not in an iCloud or computer backup.
  private func keepOutOfBackups() {
    for directory: FileManager.SearchPathDirectory in [.libraryDirectory, .documentDirectory] {
      guard var url = FileManager.default.urls(for: directory, in: .userDomainMask).first else { continue }
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? url.setResourceValues(values)
    }
  }

  @objc public func watchApp(_ invoke: Invoke) throws {
    changed = try invoke.parseArgs(WatchArgs.self).changed
    invoke.resolve()
  }

  @objc public func keepAwake(_ invoke: Invoke) throws {
    let on = try invoke.parseArgs(KeepAwakeArgs.self).on
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = on
      invoke.resolve()
    }
  }

  /// The webview's audio is a session of its own that never tells other apps it is done. This one, the
  /// app's, takes their audio first and gives it back with that word, so their music goes on.
  @objc public func holdOtherAudio(_ invoke: Invoke) throws {
    let hold = try invoke.parseArgs(HoldOtherAudioArgs.self).hold
    audio.async {
      let session = AVAudioSession.sharedInstance()
      do {
        // Taken up again in case the webview's session interrupted it; not over music already back on.
        if hold || !session.isOtherAudioPlaying {
          try session.setCategory(.playback)
          try session.setActive(true)
        }
        if !hold { try session.setActive(false, options: .notifyOthersOnDeactivation) }
        invoke.resolve()
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  /// The system takes its picture for the app switcher as the app goes: the library must not be in it.
  @objc private func hide() {
    guard cover == nil, let window = manager.viewController?.view.window else { return }
    let view = UIView(frame: window.bounds)
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.backgroundColor = .black
    window.addSubview(view)
    cover = view
  }

  @objc private func show() {
    cover?.removeFromSuperview()
    cover = nil
  }

  /// iOS gives a moment after the app goes: enough to write what is waiting and lock the vault.
  @objc private func left() {
    hide()
    var task = UIBackgroundTaskIdentifier.invalid
    let finish = {
      guard task != .invalid else { return }
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
    task = UIApplication.shared.beginBackgroundTask(expirationHandler: finish)
    DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: finish)
    audio.async { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    try? changed?.send("background")
  }

  @objc private func back() {
    try? changed?.send("foreground")
  }

  @objc public func pickFolder(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
      picker.delegate = self
      picker.allowsMultipleSelection = false
      self.picking = invoke
      self.manager.viewController?.present(picker, animated: true)
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let invoke = picking else { return }
    picking = nil
    guard let url = urls.first else {
      invoke.resolve(FolderResult(path: nil))
      return
    }
    guard open(url) else {
      invoke.reject("iOS did not give access to that folder")
      return
    }
    do {
      let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      UserDefaults.standard.set(bookmark, forKey: Self.bookmarkKey)
    } catch {
      // Open for now; it is asked for again next time.
      UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
    }
    invoke.resolve(FolderResult(path: url.path))
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    picking?.resolve(FolderResult(path: nil))
    picking = nil
  }

  @objc public func closeFolder(_ invoke: Invoke) {
    opened?.stopAccessingSecurityScopedResource()
    opened = nil
    invoke.resolve()
  }

  @objc public func restoreFolder(_ invoke: Invoke) {
    guard let bookmark = UserDefaults.standard.data(forKey: Self.bookmarkKey) else {
      invoke.resolve(FolderResult(path: nil))
      return
    }
    do {
      var stale = false
      let url = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
      guard open(url) else {
        invoke.resolve(FolderResult(path: nil))
        return
      }
      if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
        UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey)
      }
      invoke.resolve(FolderResult(path: url.path))
    } catch {
      // Its drive isn't plugged in.
      invoke.resolve(FolderResult(path: nil))
    }
  }

  /// One folder is open at a time, for as long as the app needs it.
  private func open(_ url: URL) -> Bool {
    if opened == url { return true }
    guard url.startAccessingSecurityScopedResource() else { return false }
    opened?.stopAccessingSecurityScopedResource()
    opened = url
    return true
  }
}

@_cdecl("init_plugin_quire_ios")
func initPlugin() -> Plugin {
  return QuireIosPlugin()
}
