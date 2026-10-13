import SwiftUI
import AppKit

struct CanvasPlatformView: NSViewRepresentable {
    @ObservedObject var noteBoard: NoteBoard
    @Binding var blocks: [MarkdownBlock]
    
    // We bind a layout function that converts the 'Flex Stacks' into raw Coordinates for NSView
    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.allowsMagnification = true
        scrollView.maxMagnification = 4.0
        scrollView.minMagnification = 0.2
        
        // Setup internal custom Canvas NSView 
        let canvas = InternalCanvasView()
        context.coordinator.canvas = canvas
        canvas.frame = CGRect(x: 0, y: 0, width: 4000, height: 4000) // Infinite bounds trick
        
        canvas.onPlacementsChanged = { [weak noteBoard] newPlacements in
            guard let board = noteBoard else { return }
            DispatchQueue.main.async {
                board.placements = newPlacements
                board.save()
            }
        }
        
        scrollView.documentView = canvas
        
        return scrollView
    }
    
    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let canvas = scrollView.documentView as? InternalCanvasView else { return }
        canvas.update(with: blocks, placements: noteBoard.placements)
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject {
        var parent: CanvasPlatformView
        weak var canvas: InternalCanvasView?
        
        init(_ parent: CanvasPlatformView) {
            self.parent = parent
        }
    }
}

class InternalCanvasView: NSView {
    var blockViews: [String: NSView] = [:]
    
    var currentBlocks: [MarkdownBlock] = []
    var currentPlacements: [Placement] = []
    var onPlacementsChanged: (([Placement]) -> Void)?
    
    // Drag & Selection state
    private var draggedBlockId: String?
    private var selectedBlockId: String?
    private var dragStartMouseOffset: CGSize = .zero
    
    override var isFlipped: Bool { return true } // Top-left origin
    
    // Route every click to the canvas so card dragging works even over the text.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return bounds.contains(local) ? self : nil
    }
    
    // Approximate height calculation for a given width
    private func estimateHeight(for text: String, width: CGFloat) -> CGFloat {
        let constraintRect = CGSize(width: width, height: .greatestFiniteMagnitude)
        let boundingBox = text.boundingRect(
            with: constraintRect,
            options: .usesLineFragmentOrigin,
            attributes: [.font: NSFont.systemFont(ofSize: NSFont.systemFontSize)],
            context: nil
        )
        return ceil(boundingBox.height)
    }
    
    func update(with blocks: [MarkdownBlock], placements: [Placement]) {
        self.currentBlocks = blocks
        self.currentPlacements = placements
        
        // Sync placements with blocks (SwiftUI shouldn't mutate state during update)
        let reconciled = NoteBoard.reconcile(placements, with: blocks)
        if reconciled != placements {
            self.currentPlacements = reconciled
            onPlacementsChanged?(reconciled)
        }
        
        if draggedBlockId == nil {
            layoutCards()
        }
    }
    
    func layoutCards() {
        // Group by column
        var columns: [Int: [(MarkdownBlock, Placement)]] = [:]
        
        for block in currentBlocks {
            if let p = currentPlacements.first(where: { $0.blockId == block.id }) {
                columns[p.groupIndex, default: []].append((block, p))
            }
        }
        
        // Layout each column as a Flex Stack
        for (groupIndex, var items) in columns {
            items.sort(by: { $0.1.orderIndex < $1.1.orderIndex })
            
            var currentY: CGFloat = 50.0
            let columnX = CGFloat(groupIndex) * 350.0 + 50.0
            
            for (block, p) in items {
                let cardView = getOrCreateCardView(for: block)
                
                // Calculate dynamic height based on actual text
                let padding: CGFloat = 20.0
                let textWidth = CGFloat(p.preferredWidth) - (padding * 2)
                let textHeight = estimateHeight(for: block.rawContent, width: textWidth)
                let finalHeight = max(60, textHeight + (padding * 2))
                
                // If being dragged, don't auto frame it (let mouse drag own the frame)
                if draggedBlockId != block.id {
                    cardView.frame = CGRect(x: columnX, y: currentY, width: CGFloat(p.preferredWidth), height: finalHeight)
                }
                
                // Adjust inner label frame
                if let textLabel = cardView.subviews.first as? NSTextField {
                    textLabel.frame = CGRect(x: padding, y: padding, width: textWidth, height: textHeight)
                }
                
                currentY += finalHeight + 20.0 // 20px margin between cards in the stack
            }
        }
        
        // Remove orphans
        let blockIds = Set(currentBlocks.map { $0.id })
        for (id, view) in blockViews {
            if !blockIds.contains(id) {
                view.removeFromSuperview()
                blockViews.removeValue(forKey: id)
            }
        }
        
        self.needsDisplay = true // Trigger redraw for bezier lines
    }
    
    func getOrCreateCardView(for block: MarkdownBlock) -> NSView {
        let isSelected = block.id == selectedBlockId
        let borderColor = isSelected ? NSColor.systemBlue.cgColor : NSColor.gridColor.cgColor
        let borderWidth: CGFloat = isSelected ? 2.0 : 1.0
        
        if let existing = blockViews[block.id] {
            // Update content
            if let textLabel = existing.subviews.first as? NSTextField {
                textLabel.stringValue = block.rawContent
            }
            existing.layer?.borderColor = borderColor
            existing.layer?.borderWidth = borderWidth
            return existing
        }
        
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
        container.layer?.cornerRadius = 8.0
        container.layer?.borderWidth = borderWidth
        container.layer?.borderColor = borderColor
        container.layer?.shadowOpacity = 0.2
        container.layer?.shadowRadius = 4.0
        container.layer?.shadowOffset = CGSize(width: 0, height: -2)
        
        let label = NSTextField(labelWithString: block.rawContent)
        label.isEditable = false
        // Not selectable: a selectable text field swallows mouse-downs and blocks dragging the card.
        label.isSelectable = false
        label.lineBreakMode = .byWordWrapping
        // Frame will be assigned dynamically in update()
        
        container.addSubview(label)
        addSubview(container)
        
        blockViews[block.id] = container
        return container
    }
    
    // MARK: - Drawing Bezier Curves
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        
        NSColor.systemGray.withAlphaComponent(0.3).setStroke()
        
        let groups = Dictionary(grouping: currentPlacements, by: { $0.groupIndex })
        for (_, groupItems) in groups {
            let sorted = groupItems.sorted { $0.orderIndex < $1.orderIndex }
            if sorted.count < 2 { continue }
            
            for i in 0..<(sorted.count - 1) {
                let id1 = sorted[i].blockId
                let id2 = sorted[i+1].blockId
                
                guard let v1 = blockViews[id1], let v2 = blockViews[id2] else { continue }
                
                let startPoint = CGPoint(x: v1.frame.midX, y: v1.frame.maxY)
                let endPoint = CGPoint(x: v2.frame.midX, y: v2.frame.minY)
                
                let path = NSBezierPath()
                path.lineWidth = 2.0
                path.move(to: startPoint)
                
                // Draw a nice curve
                let cp1 = CGPoint(x: startPoint.x, y: startPoint.y + 20)
                let cp2 = CGPoint(x: endPoint.x, y: endPoint.y - 20)
                path.curve(to: endPoint, controlPoint1: cp1, controlPoint2: cp2)
                
                path.stroke()
            }
        }
    }
    
    // MARK: - Drag & Drop Events
    
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        
        // Clear selection initially
        let oldSelection = selectedBlockId
        selectedBlockId = nil
        
        for (id, view) in blockViews {
            if view.frame.contains(point) {
                selectedBlockId = id
                draggedBlockId = id
                dragStartMouseOffset = CGSize(width: point.x - view.frame.origin.x, height: point.y - view.frame.origin.y)
                
                view.layer?.shadowOpacity = 0.5
                view.layer?.shadowRadius = 10.0
                addSubview(view) // Bring to front
                break
            }
        }
        
        // If selection changed, trigger full visual update quickly
        if oldSelection != selectedBlockId {
            layoutCards() // Updates borders
        }
    }
    
    override func mouseDragged(with event: NSEvent) {
        guard let id = draggedBlockId, let view = blockViews[id] else { return }
        let point = convert(event.locationInWindow, from: nil)
        
        // Move view immediately for 60fps response
        let newX = point.x - dragStartMouseOffset.width
        let newY = point.y - dragStartMouseOffset.height
        view.frame.origin = CGPoint(x: newX, y: newY)
        
        self.needsDisplay = true // Realtime curve update
    }
    
    override func mouseUp(with event: NSEvent) {
        guard let id = draggedBlockId, let view = blockViews[id] else { return }
        draggedBlockId = nil
        
        view.layer?.shadowOpacity = 0.2
        view.layer?.shadowRadius = 4.0
        
        let center = CGPoint(x: view.frame.midX, y: view.frame.midY)
        
        // 1. Determine new column
        var newGroupIndex = Int((center.x) / 350.0)
        if newGroupIndex < 0 { newGroupIndex = 0 }
        
        // 2. Re-calculate orderIndex based on visual Y centers
        var siblingsInGroup: [(id: String, y: CGFloat)] = []
        for p in currentPlacements where p.groupIndex == newGroupIndex && p.blockId != id {
            if let siblingView = blockViews[p.blockId] {
                siblingsInGroup.append((p.blockId, siblingView.frame.midY))
            }
        }
        
        // Add the dragged block
        siblingsInGroup.append((id, center.y))
        
        // Sort from top to bottom
        siblingsInGroup.sort { $0.y < $1.y }
        
        // 3. Mutate Placements
        for (order, item) in siblingsInGroup.enumerated() {
            if let idx = currentPlacements.firstIndex(where: { $0.blockId == item.id }) {
                currentPlacements[idx].groupIndex = newGroupIndex
                currentPlacements[idx].orderIndex = order
            }
        }
        
        // Normalizing other groups to keep orderIndexes contiguous
        let groups = Dictionary(grouping: currentPlacements, by: { $0.groupIndex })
        for (_, groupItems) in groups {
            let sorted = groupItems.sorted { $0.orderIndex < $1.orderIndex }
            for (i, p) in sorted.enumerated() {
                if let idx = currentPlacements.firstIndex(where: { $0.blockId == p.blockId }) {
                    currentPlacements[idx].orderIndex = i
                }
            }
        }
        
        // Trigger save and state bubble up
        onPlacementsChanged?(currentPlacements)
        
        // Snap everything into final place with animation
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            context.allowsImplicitAnimation = true
            layoutCards()
        }
    }
}
