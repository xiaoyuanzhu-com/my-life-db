# UX Design

This document describes user experience patterns and interactions in MyLifeDB.

## Context Menu System

MyLifeDB features a dual context menu system that adapts to the device type, providing an optimized experience for both desktop and mobile users.

### Desktop Context Menu

**Activation:**
- Right-click on any file card

**Appearance:**
- Traditional vertical list menu
- Positioned at cursor location
- Uses shadcn/ui ContextMenu component

**Actions Available:**
- **Open** - Navigate to library view with file selected
- **Copy** (text files only) - Copy full text content to clipboard
- **Expand/Collapse** (truncated text only) - Toggle full text view
- **Save** (media files only) - Download file to device
- **Share** (media files, if supported) - Use Web Share API
- **Delete** - Remove file with confirmation dialog

### Mobile Context Menu

**Activation:**
- Long-press (500ms) on any file card
- Cancels if user moves >10px (allows scrolling)

**Appearance:**
- Compact grid layout with icons + labels
- Maximum 5 items per row, wraps to second row if needed
- Smart positioning:
  1. Above file card (preferred)
  2. Below file card (if no space above)
  3. Middle of viewport (if no space above/below)
- Small triangle arrow points to center of file card
- Semi-transparent backdrop overlay
- Width adjusts dynamically based on number of actions

**Cell Design:**
- Icon: 20px (w-5 h-5)
- Label: 10px font size
- Padding: 8px (p-2)
- Gap between icon and label: 4px (gap-1)
- Grid gap: 4px (gap-1)
- Container padding: 4px (p-1)

**Touch Interactions:**
- Non-passive touch events allow preventDefault for text selection
- Movement detection prevents accidental triggers during scroll
- Tap outside or backdrop closes menu

### Text Selection Behavior (Text Files Only)

**Desktop:**
- Users can manually select text before right-clicking
- Selection persists when context menu opens
- Standard browser text selection UI

**Mobile:**
- Long-press automatically selects all text in the card
- System text selection UI (handles, toolbar) is suppressed
- Custom selection highlight: `rgb(180 180 255 / 30%)`
- Selection clears when menu closes
- Prevents conflicts with system selection gestures

**CSS Implementation:**
- `.mobile-menu-open` class applied to trigger element
- `-webkit-touch-callout: none` prevents iOS callout
- `user-select: text` allows programmatic selection
- Custom `::selection` styling for visual feedback

### Accessibility Features

- **Non-selectable elements:**
  - Timestamps above file cards
  - Menu icons and labels
  - Non-text file cards

- **Touch behaviors disabled:**
  - `-webkit-touch-callout: none` - iOS callout menu
  - `-webkit-tap-highlight-color: transparent` - tap flash
  - `touch-action: manipulation` - enables browser optimizations

### Visual Feedback

- Active cell scale: 95% (`active:scale-95`)
- Destructive actions: Red text color
- Disabled states: 50% opacity
- Hover/active backgrounds:
  - Default: `bg-accent`
  - Destructive: `bg-destructive/10`

### Device Detection

Touch capability detected via:
```javascript
'ontouchstart' in window || navigator.maxTouchPoints > 0
```

Desktop menu used when no touch capability detected.

## File Card Interactions

### Visual States

- **Default:** Border + muted background
- **Group hover:** Subtle visual feedback
- **Long-press (mobile):** Text selection + context menu
- **Right-click (desktop):** Context menu

### Selection Constraints

- Text files: Text selectable, card container not selectable
- Media files: Entire card non-selectable
- Timestamps: Always non-selectable
- Match context: Selectable text content

### Mobile Optimizations

- Max card width: `calc(100% - 40px)` for right-aligned layout
- Touch target size follows platform guidelines (minimum 44x44px)
- Prevents system zoom on long-press
- Scroll-friendly with movement threshold detection
