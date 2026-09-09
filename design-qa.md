# Design QA — “今天”页双人合照柔和背景

## Comparison Target

- Source visual truth: `C:\Users\30337\AppData\Local\Temp\codex-clipboard-6f603940-3ac8-4ba8-8fd7-4f7f5609b58a.jpg`
- Browser-rendered implementation: `D:\codex工作区域\生活管家\qa\home-memory-1920.png`
- Combined comparison evidence: `D:\codex工作区域\生活管家\qa\home-memory-comparison.png`
- Responsive evidence: `D:\codex工作区域\生活管家\qa\home-memory-980.png` and `D:\codex工作区域\生活管家\qa\home-memory-390.png`
- Source pixels: 878 × 1126.
- Implementation viewport/pixels: 1920 × 1080 at device scale factor 1.
- State: “今天”页全部原则完成状态，右侧辅助栏包含一句话与今日计划。

## Full-view Comparison Evidence

The browser implementation keeps both faces recognizable in the right side of the focus stage while preserving the original image ratio. The photo is visually subordinate to the task state through reduced saturation, contrast, opacity, a radial fade, and a separate white readability veil. The right rail remains outside the image layer and retains its original solid treatment.

The implementation uses three isolated layers inside `.focus-stage`: the local photo at z-index 0, the white veil at z-index 1, and the existing focus content at z-index 2. Because all three home-state variants are assigned to the same `focusHtml` slot inside `.home-foreground`, the empty, pending, and completed states share the same background behavior without duplicating state logic.

## Focused-region Comparison Evidence

The side-by-side evidence confirms that neither person is permanently cropped from the asset and both faces remain visible at the 1920px and 980px validation widths. At 390px the image remains a low-opacity edge element, is clipped by the focus stage rather than the document, and does not compete with the wrapped completion message or action button.

## Required Fidelity Surfaces

- Image treatment: real local JPEG, original 878 × 1126 dimensions, 66,115 bytes, JPEG quality 84, zero EXIF entries.
- Layout isolation: the photo exists only while the home renderer is active. Principles, Problem Summary, Thoughts, and Plans each report zero `.home-memory-photo` elements after navigation.
- Readability: the white veil is independent from image opacity; foreground content stays above both background layers.
- Responsive behavior: verified at 1920×1080, 1366×768, 980×800, 860×800, 560×800, and 390×844. No document or body horizontal overflow was observed.
- Accessibility: decorative empty `alt`, `aria-hidden="true"`, `draggable="false"`, `pointer-events:none`, and no focus target.
- Failure handling: with the asset temporarily unavailable, the image reports natural width 0, its wrapper becomes hidden, the foreground remains ready, and no horizontal overflow is introduced. The asset was restored after this test.
- Privacy: image source is local-only under `public/assets/private/`; no Base64 or data-file storage is used. `.gitignore` excludes the full private directory.
- Contrast modes: `prefers-contrast: more` reduces photo opacity to .08; forced-colors mode hides both decorative image layers.

## Comparison History

### Pass 1 — passed

- Both faces remain recognizable without enlarging the source asset.
- The image fades naturally into the focus stage and remains visually secondary.
- Focus content and the right rail are readable and interactive.
- All specified responsive breakpoints avoid horizontal overflow.
- The photo disappears completely on every non-home page.
- Missing-file fallback returns the page to its plain background without a broken-image marker.
- No actionable P0, P1, or P2 visual issues remain.

## Final Result

final result: passed
