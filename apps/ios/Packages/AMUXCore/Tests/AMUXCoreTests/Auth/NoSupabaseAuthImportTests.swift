import XCTest

final class NoSupabaseAuthImportTests: XCTestCase {
    /// The iOS Supabase→Cloud API cutover removed the Supabase SDK entirely.
    /// Guard the whole AMUXCore source tree against any `import Supabase`
    /// regression (the dependency is no longer declared in Package.swift, so a
    /// reintroduced import would also fail to build — this test gives a clear
    /// signal first).
    func testAMUXCoreDoesNotImportSupabase() throws {
        let pkgRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Auth/
            .deletingLastPathComponent()  // AMUXCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // <pkg root>
        let sourcesDir = pkgRoot.appendingPathComponent("Sources/AMUXCore")

        let enumerator = FileManager.default.enumerator(
            at: sourcesDir,
            includingPropertiesForKeys: nil
        )
        var scanned = 0
        while let url = enumerator?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            scanned += 1
            let contents = try String(contentsOf: url, encoding: .utf8)
            XCTAssertFalse(
                contents.contains("import Supabase"),
                "\(url.lastPathComponent) must not import Supabase — the Supabase SDK was removed in the Cloud API cutover"
            )
        }
        XCTAssertGreaterThan(scanned, 0, "expected to scan Swift files under \(sourcesDir.path)")
    }
}
