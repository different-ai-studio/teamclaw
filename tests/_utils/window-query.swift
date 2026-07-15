// Queries CGWindowList for windows owned by a given PID.
// Usage: window-query <pid>
// Output: one line per window: name|onscreen|x,y,width,height

import Foundation
import CoreGraphics

guard CommandLine.arguments.count > 1, let pid = Int32(CommandLine.arguments[1]) else {
    fputs("Usage: window-query <pid>\n", stderr)
    exit(1)
}

guard let windowList = CGWindowListCopyWindowInfo(
    [.optionAll, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] else {
    exit(0)
}

for w in windowList {
    guard let ownerPid = w[kCGWindowOwnerPID as String] as? Int32, ownerPid == pid else { continue }
    let name = w[kCGWindowName as String] as? String ?? ""
    let onscreen = w[kCGWindowIsOnscreen as String] as? Int ?? 0
    let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = bounds["X"] as? Double ?? 0
    let y = bounds["Y"] as? Double ?? 0
    let width = bounds["Width"] as? Double ?? 0
    let height = bounds["Height"] as? Double ?? 0
    print("\(name)|\(onscreen)|\(x),\(y),\(width),\(height)")
}
