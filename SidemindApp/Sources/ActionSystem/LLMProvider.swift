import Foundation

/// A high-level abstraction for the LLM that powers the Canvas AI.
protocol LLMProvider {
    func generateSummary(for text: String) async throws -> String
    func splitContent(text: String, intoParts parts: Int) async throws -> [String]
}

/// A Mock LLM to test our Command Pattern logic locally without API limits.
class MockLocalLLM: LLMProvider {
    func generateSummary(for text: String) async throws -> String {
        // Simulate a 1-second response time
        try await Task.sleep(nanoseconds: 1_000_000_000)
        return "✨ [AI Summary]: This section discusses the underlying architecture that powers the Canvas system."
    }
    
    func splitContent(text: String, intoParts parts: Int) async throws -> [String] {
        try await Task.sleep(nanoseconds: 1_000_000_000)
        // Dummy split by lines
        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        guard !lines.isEmpty else { return [text] }
        
        let chunkCount = min(lines.count, parts)
        let chunkSize = max(1, lines.count / chunkCount)
        
        var results: [String] = []
        for i in 0..<chunkCount {
            let start = i * chunkSize
            let end = (i == chunkCount - 1) ? lines.count : start + chunkSize
            let chunkLines = lines[start..<end]
            let chunkstr = chunkLines.joined(separator: "\n\n")
            results.append("✨ [AI Extracted \(i+1)]\n" + chunkstr)
        }
        
        return results
    }
}
