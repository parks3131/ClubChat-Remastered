// Present a staged file in iOS's own document previewer.
//
// The whole native surface of this module is one call: hand it a `file://` URL and it puts
// `QLPreviewController` on screen. That controller is what every iOS app showing a document
// inside itself is showing - the filename and a close button across the top, a page count, a
// search field and a share button - and it renders all seven of the types this product accepts
// (PDF, DOC, DOCX, XLS, XLSX, TXT, CSV) without knowing anything about any of them.
//
// Written here rather than taken from a package because it is 60 lines against a framework that
// has not changed since iOS 4, and the alternative was a third-party dependency in the binary for
// exactly this.

import ExpoModulesCore
import QuickLook

/// The file cannot be read at the path handed over, which is a caller bug rather than a refusal.
internal final class FileNotReadableException: Exception {
  override var reason: String {
    "The file could not be read"
  }
}

/// iOS has no previewer for this type. The caller falls back to the share sheet.
internal final class NotPreviewableException: Exception {
  override var reason: String {
    "iOS cannot preview this kind of file"
  }
}

/// Nothing on screen to present from, which happens only while the app is being torn down.
internal final class MissingViewControllerException: Exception {
  override var reason: String {
    "There is no view controller to present the preview from"
  }
}

/**
 The controller's data source and delegate.

 `QLPreviewController` holds both **weakly**, so this has to be owned by the module for as long as
 the preview is on screen. A local `let` here would be deallocated before the first frame and the
 preview would come up empty.
 */
internal final class PreviewItemSource: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private let url: URL
  private let onDismiss: () -> Void

  init(url: URL, onDismiss: @escaping () -> Void) {
    self.url = url
    self.onDismiss = onDismiss
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    return 1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    return url as QLPreviewItem
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    onDismiss()
  }
}

public final class QuickLookModule: Module {
  /// The live preview's source, held for exactly as long as the preview is up. See `PreviewItemSource`.
  private var source: PreviewItemSource?

  public func definition() -> ModuleDefinition {
    Name("ClubChatQuickLook")

    /**
     Whether iOS has a previewer for this file.

     Asked before staging anything, so a type it cannot render costs no download before falling
     back to the share sheet.
     */
    Function("canPreview") { (url: URL) -> Bool in
      return QLPreviewController.canPreview(url as QLPreviewItem)
    }

    /**
     Present the preview, and resolve when it is closed.

     Resolving on dismissal rather than on presentation is what lets the caller keep a spinner up
     for exactly as long as there is something to wait for, and know that the person is back.
     */
    AsyncFunction("previewAsync") { (url: URL, promise: Promise) in
      // The same guard `expo-sharing` applies before handing a URL to UIKit: a module that
      // presents whatever path it is given is a way to read a file the app may not own.
      guard FileSystemUtilities.isReadableFile(self.appContext, url) else {
        throw FileNotReadableException()
      }
      guard QLPreviewController.canPreview(url as QLPreviewItem) else {
        throw NotPreviewableException()
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        throw MissingViewControllerException()
      }

      let controller = QLPreviewController()
      let source = PreviewItemSource(url: url) { [weak self] in
        self?.source = nil
        promise.resolve(nil)
      }
      self.source = source
      controller.dataSource = source
      controller.delegate = source
      presenter.present(controller, animated: true)
    }
    .runOnQueue(.main)
  }
}
